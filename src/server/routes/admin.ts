import { Hono } from "hono";
import { z } from "zod";
import { staffCan } from "../../domain/access";
import { CommerceError } from "../../domain/errors";
import { createId } from "../../domain/ids";
import { normalizeEmail, verifyPassword } from "../../domain/password";
import { canTransition } from "../../domain/orders";
import { issueSession } from "../../domain/session";
import { STORE_ID, type OrderState } from "../../domain/types";
import { cancelOrder, publicOrder } from "../../modules/commerce";
import { actor, clientIp, clearCookie, fieldErrors, fromError, problem, rateLimit, writeCookie } from "../http";
import type { AppEnv } from "../types";

export const adminRoutes = new Hono<AppEnv>();

async function requireStaff(c: Parameters<typeof actor>[0], permission: string) {
  const { staff } = await actor(c);
  if (!staff) throw new CommerceError(401, "UNAUTHENTICATED", "Staff sign-in required", "Sign in to the operations console.");
  if (!staffCan(staff, permission)) throw new CommerceError(403, "FORBIDDEN", "Permission denied", "Your role cannot perform this action.");
  return staff;
}

adminRoutes.post("/admin/login", async (c) => {
  if (!rateLimit(`staff:${clientIp(c)}`, 8, 10 * 60_000)) return problem(c, 429, "RATE_LIMITED", "Too many attempts", "Wait before trying again.");
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1).max(72) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 401, "INVALID_LOGIN", "Sign-in failed", "The email or password is not valid.");
  const staff = await c.get("store").findStaffByEmail(normalizeEmail(parsed.data.email));
  if (!staff || !staff.active || !verifyPassword(parsed.data.password, staff.passwordHash)) {
    return problem(c, 401, "INVALID_LOGIN", "Sign-in failed", "The email or password is not valid.");
  }
  writeCookie(c, "aurelia_staff", issueSession(staff.id, "staff", 60 * 60 * 12), 60 * 60 * 12);
  await c.get("store").addAudit({
    id: createId("aud"),
    storeId: STORE_ID,
    actorId: staff.id,
    action: "staff.login",
    entity: staff.id,
    summary: "Staff session started",
    createdAt: new Date().toISOString(),
  });
  return c.json({ id: staff.id, name: staff.name, role: staff.role });
});

adminRoutes.post("/admin/logout", (c) => {
  clearCookie(c, "aurelia_staff");
  return c.json({ ok: true });
});

adminRoutes.get("/admin/me", async (c) => {
  try {
    const staff = await requireStaff(c, "reports.read");
    if (staff.role !== "analyst" && staff.role !== "super_admin" && !staffCan(staff, "orders.read") && !staffCan(staff, "catalog.read")) {
      return c.json({ id: staff.id, name: staff.name, role: staff.role, refundLimitMinor: staff.refundLimitMinor });
    }
    return c.json({ id: staff.id, name: staff.name, role: staff.role, refundLimitMinor: staff.refundLimitMinor });
  } catch (error) {
    if (error instanceof CommerceError && error.status === 403) {
      const { staff } = await actor(c);
      if (staff) return c.json({ id: staff.id, name: staff.name, role: staff.role, refundLimitMinor: staff.refundLimitMinor });
    }
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.get("/admin/dashboard", async (c) => {
  try {
    await requireStaff(c, "reports.read");
  } catch (error) {
    if (error instanceof CommerceError) {
      try {
        await requireStaff(c, "orders.read");
      } catch (inner) {
        if (inner instanceof CommerceError) return fromError(c, inner);
        throw inner;
      }
    } else throw error;
  }
  const store = c.get("store");
  const orders = await store.listOrders();
  const balances = await store.getBalances();
  const products = await store.listProducts();
  const netSalesMinor = orders.reduce((sum, order) => (order.paymentState === "paid" ? sum + order.amounts.grandTotalMinor : sum), 0);
  const byState = orders.reduce<Record<string, number>>((counts, order) => {
    counts[order.state] = (counts[order.state] ?? 0) + 1;
    return counts;
  }, {});
  const variantName = new Map<string, string>();
  for (const product of products) {
    for (const variant of product.variants) variantName.set(variant.id, `${product.name} · ${variant.options.map((option) => option.label).join(" / ")}`);
  }
  return c.json({
    netSalesMinor,
    currency: "INR",
    ordersByState: byState,
    lowStock: balances
      .filter((balance) => balance.availableToSell <= 2)
      .map((balance) => ({ variantId: balance.variantId, name: variantName.get(balance.variantId) ?? balance.variantId, available: balance.availableToSell })),
    exceptions: orders.filter((order) => order.exception || order.risk === "review").map((order) => ({
      ...publicOrder(order),
      exception: order.exception,
      risk: order.risk,
    })),
    returns: await store.listReturns(),
  });
});

adminRoutes.get("/admin/products", async (c) => {
  try {
    await requireStaff(c, "catalog.read");
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
  const products = await c.get("store").listProducts();
  return c.json({
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      status: product.status,
      department: product.department,
      category: product.category,
      updatedAt: product.updatedAt,
      variantCount: product.variants.length,
    })),
  });
});

adminRoutes.patch("/admin/products/:id", async (c) => {
  try {
    const staff = await requireStaff(c, "catalog.write");
    const parsed = z.object({ status: z.enum(["draft", "active", "archived"]) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the change", "Status must be draft, active, or archived.");
    const store = c.get("store");
    const product = (await store.listProducts()).find((item) => item.id === c.req.param("id"));
    if (!product) return problem(c, 404, "NOT_FOUND", "Product not found", "That product is not in the catalog.");
    product.status = parsed.data.status;
    product.updatedBy = staff.id;
    product.updatedAt = new Date().toISOString();
    if (parsed.data.status === "active" && !product.publishedAt) product.publishedAt = product.updatedAt;
    await store.saveProduct(product);
    await store.addAudit({
      id: createId("aud"),
      storeId: STORE_ID,
      actorId: staff.id,
      action: "product.status",
      entity: product.id,
      summary: `Set ${product.name} to ${product.status}`,
      createdAt: product.updatedAt,
    });
    return c.json({ id: product.id, status: product.status });
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.get("/admin/orders", async (c) => {
  try {
    await requireStaff(c, "orders.read");
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
  const state = c.req.query("state");
  const orders = await c.get("store").listOrders();
  return c.json({ orders: orders.filter((order) => (state ? order.state === state : true)).map(publicOrder) });
});

adminRoutes.get("/admin/orders/:orderNumber", async (c) => {
  try {
    await requireStaff(c, "orders.read");
    const order = await c.get("store").getOrderByNumber(c.req.param("orderNumber"));
    if (!order) return problem(c, 404, "NOT_FOUND", "Order not found", "That order is not in the queue.");
    return c.json(publicOrder(order));
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.post("/admin/orders/:orderNumber/transition", async (c) => {
  try {
    const staff = await requireStaff(c, "orders.write");
    const parsed = z.object({
      state: z.enum(["confirmed", "fulfilling", "shipped", "delivered", "cancelled"]),
      note: z.string().trim().min(3).max(240),
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the transition", "Choose a valid next state and a note.", fieldErrors(parsed.error));
    const store = c.get("store");
    const order = await store.getOrderByNumber(c.req.param("orderNumber"));
    if (!order) return problem(c, 404, "NOT_FOUND", "Order not found", "That order is not in the queue.");
    if (parsed.data.state === "cancelled") {
      const next = await cancelOrder(store, order, staff.id, parsed.data.note, false);
      await store.addAudit({ id: createId("aud"), storeId: STORE_ID, actorId: staff.id, action: "order.cancelled", entity: order.orderNumber, summary: parsed.data.note, createdAt: new Date().toISOString() });
      return c.json(publicOrder(next));
    }
    if (!canTransition(order.state, parsed.data.state as OrderState)) {
      return problem(c, 409, "ORDER_STATE", "Invalid transition", `${order.state} cannot move to ${parsed.data.state}.`);
    }
    order.state = parsed.data.state as OrderState;
    if (order.state === "shipped" || order.state === "delivered") order.fulfilmentState = "fulfilled";
    order.timeline.push({ at: new Date().toISOString(), type: order.state, actorRef: staff.id, note: parsed.data.note });
    order.updatedAt = new Date().toISOString();
    await store.saveOrder(order);
    await store.addAudit({ id: createId("aud"), storeId: STORE_ID, actorId: staff.id, action: "order.transition", entity: order.orderNumber, summary: `${order.orderNumber} → ${order.state}`, createdAt: order.updatedAt });
    return c.json(publicOrder(order));
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.post("/admin/orders/:orderNumber/refund", async (c) => {
  try {
    const staff = await requireStaff(c, "orders.refund");
    const parsed = z.object({ amountMinor: z.number().int().positive(), reason: z.string().trim().min(3).max(240) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the refund", "Amount and reason are required.", fieldErrors(parsed.error));
    if (parsed.data.amountMinor > staff.refundLimitMinor && staff.role !== "super_admin") {
      await c.get("store").addAudit({
        id: createId("aud"),
        storeId: STORE_ID,
        actorId: staff.id,
        action: "refund.denied",
        entity: c.req.param("orderNumber"),
        summary: `Refund of ${parsed.data.amountMinor} exceeds the role limit`,
        createdAt: new Date().toISOString(),
      });
      return problem(c, 403, "APPROVAL_REQUIRED", "Approval required", "This refund is above your limit. A super admin has to approve it.");
    }
    const store = c.get("store");
    const order = await store.getOrderByNumber(c.req.param("orderNumber"));
    if (!order || order.paymentState === "unpaid" || order.paymentState === "failed") {
      return problem(c, 409, "REFUND_UNAVAILABLE", "Refund unavailable", "There is no captured payment to refund.");
    }
    order.paymentState = parsed.data.amountMinor >= order.amounts.grandTotalMinor ? "refunded" : "partially_refunded";
    order.timeline.push({ at: new Date().toISOString(), type: "refund.updated", actorRef: staff.id, note: parsed.data.reason });
    order.updatedAt = new Date().toISOString();
    await store.saveOrder(order);
    await store.addAudit({ id: createId("aud"), storeId: STORE_ID, actorId: staff.id, action: "refund.issued", entity: order.orderNumber, summary: parsed.data.reason, createdAt: order.updatedAt });
    return c.json(publicOrder(order));
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.get("/admin/inventory", async (c) => {
  try {
    await requireStaff(c, "catalog.read");
  } catch (error) {
    if (error instanceof CommerceError) {
      try {
        await requireStaff(c, "orders.read");
      } catch (inner) {
        if (inner instanceof CommerceError) return fromError(c, inner);
        throw inner;
      }
    } else throw error;
  }
  const store = c.get("store");
  const products = await store.listProducts();
  const names = new Map<string, string>();
  for (const product of products) for (const variant of product.variants) names.set(variant.id, `${product.name} · ${variant.sku}`);
  return c.json({
    balances: (await store.getBalances()).map((balance) => ({ ...balance, label: names.get(balance.variantId) ?? balance.variantId })),
    reservations: await store.listReservations(),
    movements: (await store.listMovements()).slice(-40).reverse(),
  });
});

adminRoutes.post("/admin/inventory/adjustments", async (c) => {
  try {
    const staff = await requireStaff(c, "catalog.write");
    const parsed = z.object({
      variantId: z.string(),
      deltaOnHand: z.number().int(),
      reason: z.enum(["receiving", "correction", "damage", "return_restock", "transfer"]),
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the adjustment", "Variant, quantity, and a reason are required.", fieldErrors(parsed.error));
    const balance = await c.get("store").adjustInventory({ ...parsed.data, actorId: staff.id });
    await c.get("store").addAudit({
      id: createId("aud"),
      storeId: STORE_ID,
      actorId: staff.id,
      action: "inventory.adjust",
      entity: parsed.data.variantId,
      summary: `${parsed.data.reason} ${parsed.data.deltaOnHand}`,
      createdAt: new Date().toISOString(),
    });
    return c.json(balance);
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.get("/admin/customers", async (c) => {
  try {
    await requireStaff(c, "customers.read");
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
  const customers = await c.get("store").listCustomers();
  return c.json({
    customers: customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      marketing: customer.consent.marketing,
      wishlistCount: customer.wishlist.length,
      createdAt: customer.createdAt,
    })),
  });
});

adminRoutes.get("/admin/promotions", async (c) => {
  try {
    await requireStaff(c, "catalog.read");
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
  return c.json({
    promotions: [
      { code: "AURELIA10", label: "10% off, capped at ₹2,000", active: true },
      { code: "WELCOME500", label: "₹500 off from ₹3,000", active: true },
    ],
  });
});

adminRoutes.get("/admin/audit", async (c) => {
  try {
    await requireStaff(c, "reports.read");
  } catch (error) {
    if (error instanceof CommerceError) {
      const { staff } = await actor(c);
      if (!staff || staff.role !== "super_admin") return fromError(c, error instanceof CommerceError ? error : new CommerceError(403, "FORBIDDEN", "Permission denied", "Audit is limited."));
    } else throw error;
  }
  const { staff } = await actor(c);
  if (!staff || (staff.role !== "super_admin" && staff.role !== "analyst")) {
    return problem(c, 403, "FORBIDDEN", "Permission denied", "Audit is limited to administrators.");
  }
  return c.json({ entries: await c.get("store").listAudit() });
});

adminRoutes.get("/admin/returns", async (c) => {
  try {
    await requireStaff(c, "orders.read");
    return c.json({ returns: await c.get("store").listReturns() });
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.get("/admin/synonyms", async (c) => {
  try {
    await requireStaff(c, "catalog.read");
    return c.json({ synonyms: await c.get("store").listSynonyms() });
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

adminRoutes.post("/admin/synonyms", async (c) => {
  try {
    const staff = await requireStaff(c, "catalog.write");
    const parsed = z.object({ terms: z.array(z.string().trim().min(2)).min(2).max(8) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the synonyms", "Provide at least two terms.", fieldErrors(parsed.error));
    const set = { id: createId("syn"), terms: parsed.data.terms.map((term) => term.toLowerCase()) };
    await c.get("store").saveSynonym(set);
    await c.get("store").addAudit({ id: createId("aud"), storeId: STORE_ID, actorId: staff.id, action: "search.synonym", entity: set.id, summary: set.terms.join(", "), createdAt: new Date().toISOString() });
    return c.json(set, 201);
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});
