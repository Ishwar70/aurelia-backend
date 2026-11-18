import { Hono } from "hono";
import { z } from "zod";
import { COLLECTIONS, DEPARTMENTS } from "../../data/catalog";
import { HOME, POLICIES } from "../../data/content";
import { createId } from "../../domain/ids";
import { searchCatalog, suggest } from "../../domain/search";
import { STORE_ID } from "../../domain/types";
import { availabilityMap, publicReviews, toCard, toVariants } from "../../modules/catalog";
import { fieldErrors, problem, rateLimit, clientIp } from "../http";
import type { AppEnv } from "../types";

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/health", (c) => {
  const store = c.get("store");
  return c.json({
    ok: true,
    service: "aurelia-api",
    persistence: store.mode,
    ai: process.env.AI_ENABLED === "false" ? "off" : process.env.OPENAI_API_KEY ? "model" : "rules",
    payments: process.env.RAZORPAY_KEY_ID ? "razorpay" : "sandbox",
    time: new Date().toISOString(),
  });
});

publicRoutes.get("/store", (c) =>
  c.json({
    id: STORE_ID,
    name: "AURELIA",
    currency: "INR",
    taxDisplay: "inclusive",
    country: "IN",
    utility: HOME.utility,
  }),
);

publicRoutes.get("/home", async (c) => {
  const store = c.get("store");
  const products = await store.listProducts();
  const available = availabilityMap(await store.getBalances());
  const cards = products.filter((product) => product.status === "active").map((product) => toCard(product, available));
  const bySlug = (slug: string) => cards.find((card) => card.slug === slug) ?? null;
  return c.json({
    ...HOME,
    categories: DEPARTMENTS.map((department) => ({
      ...department,
      href: `/${department.id}`,
      image: cards.find((card) => card.department === department.id)?.image ?? null,
    })),
    newArrivals: cards.filter((card) => card.tags.includes("new")).slice(0, 8),
    look: { ...HOME.look, products: HOME.look.productSlugs.map(bySlug).filter(Boolean) },
  });
});

publicRoutes.get("/categories", async (c) => {
  const products = (await c.get("store").listProducts()).filter((product) => product.status === "active");
  return c.json({
    departments: DEPARTMENTS.map((department) => {
      const mine = products.filter((product) => product.department === department.id);
      const categories = new Map<string, { slug: string; label: string; count: number }>();
      for (const product of mine) {
        const current = categories.get(product.categorySlug) ?? { slug: product.categorySlug, label: product.category, count: 0 };
        current.count += 1;
        categories.set(product.categorySlug, current);
      }
      return { id: department.id, label: department.label, categories: [...categories.values()] };
    }),
  });
});

publicRoutes.get("/collections", (c) => c.json({ collections: COLLECTIONS }));

publicRoutes.get("/collections/:slug", async (c) => {
  const collection = COLLECTIONS.find((item) => item.slug === c.req.param("slug"));
  if (!collection) return problem(c, 404, "NOT_FOUND", "Collection not found", "That edit is not published.");
  const store = c.get("store");
  const available = availabilityMap(await store.getBalances());
  const products = (await store.listProducts())
    .filter((product) => product.status === "active" && product.collectionIds.includes(collection.slug))
    .map((product) => toCard(product, available));
  return c.json({ ...collection, products });
});

publicRoutes.get("/policies", (c) => c.json({ policies: POLICIES.map(({ slug, title, summary }) => ({ slug, title, summary })) }));

publicRoutes.get("/policies/:slug", (c) => {
  const policy = POLICIES.find((item) => item.slug === c.req.param("slug"));
  if (!policy) return problem(c, 404, "NOT_FOUND", "Policy not found", "That page is not published.");
  return c.json(policy);
});

function queryNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

publicRoutes.get("/products", async (c) => {
  const store = c.get("store");
  const products = await store.listProducts();
  const available = availabilityMap(await store.getBalances());
  const synonyms = await store.listSynonyms();
  const min = queryNumber(c.req.query("min"));
  const max = queryNumber(c.req.query("max"));
  const page = Math.max(1, queryNumber(c.req.query("page")) ?? 1);
  const pageSize = Math.min(48, Math.max(1, queryNumber(c.req.query("pageSize")) ?? 12));
  const sort = c.req.query("sort");
  const hits = searchCatalog(products, synonyms, {
    q: c.req.query("q"),
    department: c.req.query("department"),
    category: c.req.query("category"),
    collection: c.req.query("collection"),
    color: c.req.query("color"),
    size: c.req.query("size"),
    minMinor: min != null ? min * 100 : undefined,
    maxMinor: max != null ? max * 100 : undefined,
    availableOnly: c.req.query("available") === "1",
    sort: sort === "price_asc" || sort === "price_desc" || sort === "rating" || sort === "newest" || sort === "relevance" ? sort : undefined,
    availability: available,
  });
  const start = (page - 1) * pageSize;
  const colors = new Map<string, number>();
  const sizes = new Map<string, number>();
  for (const hit of hits) {
    for (const variant of hit.product.variants) {
      colors.set(variant.colorFamily, (colors.get(variant.colorFamily) ?? 0) + 1);
      const size = variant.options.find((option) => option.name === "size")?.label;
      if (size) sizes.set(size, (sizes.get(size) ?? 0) + 1);
    }
  }
  return c.json({
    total: hits.length,
    page,
    pageSize,
    items: hits.slice(start, start + pageSize).map((hit) => toCard(hit.product, available)),
    facets: {
      colors: [...colors.entries()].map(([value, count]) => ({ value, count })),
      sizes: [...sizes.entries()].map(([value, count]) => ({ value, count })),
    },
  });
});

publicRoutes.get("/products/:slug", async (c) => {
  const store = c.get("store");
  const products = await store.listProducts();
  const product = products.find((item) => item.slug === c.req.param("slug") && item.status === "active");
  if (!product) return problem(c, 404, "NOT_FOUND", "Product not found", "That piece is not published.");
  const available = availabilityMap(await store.getBalances());
  const related = products
    .filter((item) => item.status === "active" && item.id !== product.id && (item.categorySlug === product.categorySlug || item.collectionIds.some((id) => product.collectionIds.includes(id))))
    .slice(0, 4)
    .map((item) => toCard(item, available));
  return c.json({
    ...toCard(product, available),
    details: product.description.details,
    attributes: product.attributes,
    sizeGuide: product.sizeGuide,
    seo: product.seo,
    media: product.media,
    variants: toVariants(product, available),
    reviews: publicReviews(await store.listReviews(product.id)),
    related,
    taxDisplay: "inclusive",
  });
});

publicRoutes.get("/search/suggest", async (c) => {
  const q = c.req.query("q") ?? "";
  const products = await c.get("store").listProducts();
  return c.json({ suggestions: suggest(products, q).map((product) => ({ slug: product.slug, name: product.name })) });
});

const FAMILIES: Record<string, [number, number, number]> = {
  ivory: [243, 238, 228],
  plum: [74, 36, 59],
  ink: [23, 23, 23],
  indigo: [44, 62, 107],
  camel: [196, 165, 116],
  gold: [195, 154, 91],
  blush: [231, 199, 193],
  stone: [217, 211, 203],
};

publicRoutes.post("/search/image", async (c) => {
  if (process.env.VISUAL_SEARCH_ENABLED === "false") {
    return problem(c, 503, "VISUAL_SEARCH_DISABLED", "Visual search is off", "Typed search is still available.");
  }
  if (!rateLimit(`image:${clientIp(c)}`, 12, 60_000)) {
    return problem(c, 429, "RATE_LIMITED", "Too many attempts", "Wait a minute before another image search.");
  }
  const parsed = z.object({ pixels: z.array(z.number().int().min(0).max(255)).min(48).max(1728) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "INVALID_IMAGE", "Image rejected", "Send a small RGB sample. Photographs are not stored.", fieldErrors(parsed.error));
  if (parsed.data.pixels.length % 3 !== 0) return problem(c, 400, "INVALID_IMAGE", "Image rejected", "The colour sample was incomplete.");
  let r = 0, g = 0, b = 0;
  const count = parsed.data.pixels.length / 3;
  for (let i = 0; i < parsed.data.pixels.length; i += 3) {
    r += parsed.data.pixels[i] ?? 0;
    g += parsed.data.pixels[i + 1] ?? 0;
    b += parsed.data.pixels[i + 2] ?? 0;
  }
  r /= count; g /= count; b /= count;
  let family = "ink";
  let best = Number.POSITIVE_INFINITY;
  for (const [name, rgb] of Object.entries(FAMILIES)) {
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (distance < best) {
      best = distance;
      family = name;
    }
  }
  const store = c.get("store");
  const available = availabilityMap(await store.getBalances());
  const products = (await store.listProducts())
    .filter((product) => product.status === "active" && product.variants.some((variant) => variant.colorFamily === family))
    .map((product) => toCard(product, available));
  const lowConfidence = best > 18000 || products.length === 0;
  return c.json({
    family,
    confidence: lowConfidence ? "low" : "high",
    notice: "Results are visually similar by colour. They are not an exact match.",
    items: products,
  });
});

publicRoutes.post("/search/voice", async (c) => {
  if (!rateLimit(`voice:${clientIp(c)}`, 20, 60_000)) {
    return problem(c, 429, "RATE_LIMITED", "Too many attempts", "Wait a minute before another voice search.");
  }
  const parsed = z.object({ transcript: z.string().trim().min(1).max(180) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "INVALID_TRANSCRIPT", "Transcript rejected", "Send the recognised text. Audio is not retained.", fieldErrors(parsed.error));
  const store = c.get("store");
  const available = availabilityMap(await store.getBalances());
  const hits = searchCatalog(await store.listProducts(), await store.listSynonyms(), {
    q: parsed.data.transcript,
    availability: available,
    sort: "relevance",
  });
  return c.json({
    transcript: parsed.data.transcript,
    items: hits.slice(0, 12).map((hit) => toCard(hit.product, available)),
    total: hits.length,
  });
});

publicRoutes.post("/products/:slug/back-in-stock", async (c) => {
  const parsed = z.object({ email: z.string().email(), variantId: z.string().min(3) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the form", "Enter a valid email.", fieldErrors(parsed.error));
  const store = c.get("store");
  const product = (await store.listProducts()).find((item) => item.slug === c.req.param("slug"));
  if (!product || !product.variants.some((variant) => variant.id === parsed.data.variantId)) {
    return problem(c, 404, "NOT_FOUND", "Variant not found", "That option is not on this piece.");
  }
  await store.saveBackInStock({
    id: createId("bis"),
    email: parsed.data.email.toLowerCase(),
    variantId: parsed.data.variantId,
    createdAt: new Date().toISOString(),
  });
  return c.json({ accepted: true }, 202);
});
