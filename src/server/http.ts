import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ZodError } from "zod";
import { CommerceError } from "../domain/errors";
import { readSession, signValue, unsignValue } from "../domain/session";
import type { Cart, Customer, Order, Staff } from "../domain/types";
import type { AppEnv } from "./types";

const COOKIE_BASE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Lax" as const,
  path: "/",
};

export function problem(c: Context<AppEnv>, status: number, code: string, title: string, detail: string, extra?: Record<string, unknown>) {
  return c.json(
    {
      type: `https://api.aurelia.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      code,
      detail,
      traceId: c.get("traceId"),
      ...extra,
    },
    status as 400,
  );
}

export function fromError(c: Context<AppEnv>, error: CommerceError) {
  return problem(c, error.status, error.code, error.title, error.detail, error.extra);
}

export function fieldErrors(error: ZodError) {
  return { errors: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) };
}

export function writeCookie(c: Context, name: string, value: string, maxAge: number) {
  setCookie(c, name, value, { ...COOKIE_BASE, maxAge });
}

export function clearCookie(c: Context, name: string) {
  deleteCookie(c, name, { path: "/" });
}

export function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

export function readCustomerId(c: Context): string | null {
  const claims = readSession(getCookie(c, "aurelia_customer"));
  return claims?.role === "customer" ? claims.sub : null;
}

export function readStaffId(c: Context): string | null {
  const claims = readSession(getCookie(c, "aurelia_staff"));
  return claims?.role === "staff" ? claims.sub : null;
}

export interface CartCookie {
  id: string;
  lines: Cart["lines"];
  couponCode: string | null;
  customerId: string | null;
}

export function readCartCookie(c: Context): CartCookie | null {
  const raw = getCookie(c, "aurelia_cart");
  if (!raw) return null;
  const json = unsignValue(raw);
  if (!json) return null;
  try {
    return JSON.parse(json) as CartCookie;
  } catch {
    return null;
  }
}

export function writeCartCookie(c: Context, cart: Cart) {
  const payload: CartCookie = { id: cart.id, lines: cart.lines, couponCode: cart.couponCode, customerId: cart.customerId };
  writeCookie(c, "aurelia_cart", signValue(JSON.stringify(payload)), 60 * 60 * 24 * 30);
}

export function readReceipts(c: Context): Order[] {
  const raw = getCookie(c, "aurelia_receipts");
  if (!raw) return [];
  const json = unsignValue(raw);
  if (!json) return [];
  try {
    const orders = JSON.parse(json) as Order[];
    return Array.isArray(orders) ? orders : [];
  } catch {
    return [];
  }
}

export function writeReceipt(c: Context, order: Order) {
  const existing = readReceipts(c).filter((item) => item.orderNumber !== order.orderNumber);
  existing.push(order);
  let packed = existing.slice(-2);
  while (packed.length > 1 && JSON.stringify(packed).length > 3200) packed = packed.slice(1);
  writeCookie(c, "aurelia_receipts", signValue(JSON.stringify(packed)), 60 * 60 * 24 * 30);
}

export async function actor(c: Context<AppEnv>): Promise<{ customer: Customer | null; staff: Staff | null }> {
  const store = c.get("store");
  const customerId = c.get("customerId");
  const staffId = c.get("staffId");
  const customer = customerId ? await store.getCustomer(customerId) : null;
  const staff = staffId ? await store.getStaff(staffId) : null;
  return { customer, staff };
}
