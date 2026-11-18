import type { Product, SynonymSet } from "./types";
import { unitPriceMinor } from "./money";

export interface SearchQuery {
  q?: string;
  department?: string;
  category?: string;
  collection?: string;
  color?: string;
  size?: string;
  minMinor?: number;
  maxMinor?: number;
  availableOnly?: boolean;
  sort?: "relevance" | "price_asc" | "price_desc" | "newest" | "rating";
  page?: number;
  pageSize?: number;
  availability: Map<string, number>;
}

export interface SearchHit {
  product: Product;
  score: number;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 99;
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = rows[i];
      const prev = rows[i - 1];
      if (!row || !prev) continue;
      row[j] = Math.min((prev[j] ?? 99) + 1, (row[j - 1] ?? 99) + 1, (prev[j - 1] ?? 99) + cost);
    }
  }
  return rows[a.length]?.[b.length] ?? 99;
}

function expand(queryTokens: string[], synonyms: SynonymSet[]): string[] {
  const extra = new Set<string>();
  for (const token of queryTokens) {
    for (const set of synonyms) {
      if (set.terms.some((term) => term.toLowerCase() === token)) {
        for (const term of set.terms) extra.add(term.toLowerCase());
      }
    }
  }
  return [...queryTokens, ...extra];
}

function haystack(product: Product): string {
  return [
    product.name,
    product.brand,
    product.category,
    product.subcategory,
    product.department,
    product.tags.join(" "),
    product.attributes.material ?? "",
    product.attributes.fit ?? "",
    ...(product.attributes.occasion ?? []),
    product.description.short,
  ]
    .join(" ")
    .toLowerCase();
}

function scoreProduct(product: Product, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 1;
  const name = product.name.toLowerCase();
  const fields = haystack(product);
  const fieldTokens = tokens(fields);
  let score = 0;
  const phrase = queryTokens.join(" ");
  if (name.includes(phrase)) score += 50;
  for (const token of queryTokens) {
    if (name.includes(token)) score += 10;
    else if (product.brand.toLowerCase().includes(token)) score += 8;
    else if (product.category.toLowerCase().includes(token)) score += 6;
    else if (product.tags.some((tag) => tag.toLowerCase().includes(token))) score += 5;
    else if (fields.includes(token)) score += 2;
    else if (token.length >= 4 && fieldTokens.some((candidate) => editDistance(candidate, token) <= 1)) score += 3;
  }
  return score;
}

export function fromPrice(product: Product): number {
  const prices = product.variants
    .filter((variant) => variant.status === "active")
    .map((variant) => unitPriceMinor(variant.pricing));
  return prices.length ? Math.min(...prices) : 0;
}

export function searchCatalog(products: Product[], synonyms: SynonymSet[], query: SearchQuery): SearchHit[] {
  const queryTokens = expand(tokens(query.q ?? ""), synonyms);
  const hits: SearchHit[] = [];
  for (const product of products) {
    if (product.status !== "active") continue;
    if (query.department && product.department !== query.department) continue;
    if (query.category && product.categorySlug !== query.category) continue;
    if (query.collection && !product.collectionIds.includes(query.collection)) continue;
    if (query.color && !product.variants.some((variant) => variant.colorFamily === query.color)) continue;
    if (query.size && !product.variants.some((variant) => variant.options.some((option) => option.label === query.size))) {
      continue;
    }
    const price = fromPrice(product);
    if (query.minMinor != null && price < query.minMinor) continue;
    if (query.maxMinor != null && price > query.maxMinor) continue;
    const available = product.variants.some((variant) => (query.availability.get(variant.id) ?? 0) > 0);
    if (query.availableOnly && !available) continue;
    const score = scoreProduct(product, queryTokens);
    if (query.q && score <= 0) continue;
    hits.push({ product, score });
  }
  const sort = query.sort ?? (query.q ? "relevance" : "newest");
  hits.sort((a, b) => {
    if (sort === "price_asc") return fromPrice(a.product) - fromPrice(b.product);
    if (sort === "price_desc") return fromPrice(b.product) - fromPrice(a.product);
    if (sort === "rating") return b.product.rating.average - a.product.rating.average;
    if (sort === "newest") return b.product.publishedAt!.localeCompare(a.product.publishedAt ?? "");
    return b.score - a.score || a.product.name.localeCompare(b.product.name);
  });
  return hits;
}

export function suggest(products: Product[], q: string, limit = 6): Product[] {
  const query = q.trim().toLowerCase();
  if (query.length < 1) return [];
  return products
    .filter((product) => product.status === "active" && product.name.toLowerCase().includes(query))
    .slice(0, limit);
}
