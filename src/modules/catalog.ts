import { unitPriceMinor } from "../domain/money";
import { fromPrice } from "../domain/search";
import type { Balance, Product, Review } from "../domain/types";

export interface CardProduct {
  id: string;
  slug: string;
  name: string;
  brand: string;
  department: string;
  category: string;
  categorySlug: string;
  short: string;
  image: string | null;
  hoverImage: string | null;
  alt: string;
  priceMinor: number;
  compareAtMinor: number | null;
  currency: "INR";
  colorCount: number;
  rating: { average: number; count: number };
  inStock: boolean;
  badge: "new" | "sale" | null;
  tags: string[];
}

export interface DetailVariant {
  id: string;
  sku: string;
  color: string;
  colorFamily: string;
  colorHex: string;
  size: string;
  listMinor: number;
  saleMinor: number | null;
  unitPriceMinor: number;
  available: number;
  lowStock: boolean;
}

export function availabilityMap(balances: Balance[]): Map<string, number> {
  return new Map(balances.map((balance) => [balance.variantId, balance.availableToSell]));
}

export function toCard(product: Product, available: Map<string, number>): CardProduct {
  const active = product.variants.filter((variant) => variant.status === "active");
  const priceMinor = fromPrice(product);
  const priced = active.find((variant) => unitPriceMinor(variant.pricing) === priceMinor) ?? active[0];
  const compareAtMinor = priced && priced.pricing.saleMinor != null ? priced.pricing.listMinor : null;
  const colors = new Set(active.map((variant) => variant.colorFamily));
  const inStock = active.some((variant) => (available.get(variant.id) ?? 0) > 0);
  const badge = product.tags.includes("new") ? "new" : compareAtMinor ? "sale" : null;
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    brand: product.brand,
    department: product.department,
    category: product.category,
    categorySlug: product.categorySlug,
    short: product.description.short,
    image: product.media[0]?.url ?? null,
    hoverImage: product.media[1]?.url ?? null,
    alt: product.media[0]?.alt ?? product.name,
    priceMinor,
    compareAtMinor,
    currency: "INR",
    colorCount: colors.size,
    rating: product.rating,
    inStock,
    badge,
    tags: product.tags,
  };
}

export function toVariants(product: Product, available: Map<string, number>): DetailVariant[] {
  return product.variants.filter((variant) => variant.status === "active").map((variant) => {
    const count = available.get(variant.id) ?? 0;
    return {
      id: variant.id,
      sku: variant.sku,
      color: variant.options.find((option) => option.name === "color")?.label ?? "",
      colorFamily: variant.colorFamily,
      colorHex: variant.colorHex,
      size: variant.options.find((option) => option.name === "size")?.label ?? "",
      listMinor: variant.pricing.listMinor,
      saleMinor: variant.pricing.saleMinor,
      unitPriceMinor: unitPriceMinor(variant.pricing),
      available: count,
      lowStock: count > 0 && count <= 2,
    };
  });
}

export function publicReviews(reviews: Review[]) {
  return reviews.map((review) => ({
    id: review.id,
    author: review.author,
    rating: review.rating,
    title: review.title,
    body: review.body,
    createdAt: review.createdAt,
  }));
}
