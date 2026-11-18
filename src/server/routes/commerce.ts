import { Hono } from "hono";
import { z } from "zod";
import { createRazorpayOrder, razorpayConfigured, verifyPaymentSignature, verifyWebhook } from "../../domain/razorpay";
import { CommerceError } from "../../domain/errors";
import { createId } from "../../domain/ids";
import { hashPassword, normalizeEmail, verifyPassword } from "../../domain/password";
import { issueSession } from "../../domain/session";
import { returnEligibility } from "../../domain/orders";
import { STORE_ID, type Address, type Cart, type Order } from "../../domain/types";
import {
  addLine,
  applyCoupon,
  cancelOrder,
  emptyCart,
  markOrderPaid,
  placeOrder,
  presentCart,
  publicOrder,
  quoteShipping,
  updateLine,
} from "../../modules/commerce";
import { answerAssistant } from "../../modules/assistant";
import {
  actor,
  clearCookie,
  clientIp,
  fieldErrors,
  fromError,
  problem,
  rateLimit,
  readCartCookie,
  readReceipts,
  writeCartCookie,
  writeCookie,
  writeReceipt,
} from "../http";
import type { AppEnv } from "../types";

export const commerceRoutes = new Hono<AppEnv>();

const AddressSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  phone: z.string().regex(/^[6-9]\d{9}$/),
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(2).max(60),
  region: z.string().trim().min(2).max(60),
  postalCode: z.string().regex(/^\d{6}$/),
});

async function currentCart(c: Parameters<typeof readCartCookie>[0] & { get: (key: "store") => AppEnv["Variables"]["store"]; var: AppEnv["Variables"] }): Promise<Cart | null> {
  const cookie = readCartCookie(c);
  if (!cookie) return null;
  const store = c.get("store");
  const stored = await store.getCart(cookie.id);
  if (stored) return stored;
  const restored: Cart = {
    id: cookie.id,
    storeId: STORE_ID,
    customerId: cookie.customerId,
    lines: cookie.lines,
    couponCode: cookie.couponCode,
    updatedAt: new Date().toISOString(),
  };
  await store.saveCart(restored);
  return restored;
}

function requireIdempotency(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length < 8 || key.length > 80) return null;
  return key;
}

commerceRoutes.post("/auth/register", async (c) => {
  if (!rateLimit(`register:${clientIp(c)}`, 8, 10 * 60_000)) return problem(c, 429, "RATE_LIMITED", "Too many attempts", "Wait before creating another account.");
  const parsed = z.object({
    name: z.string().trim().min(2).max(80),
    email: z.string().email(),
    password: z.string().min(8).max(72),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the form", "Name, email, and a password of at least 8 characters are required.", fieldErrors(parsed.error));
  const store = c.get("store");
  const email = normalizeEmail(parsed.data.email);
  if (await store.findCustomerByEmail(email)) return problem(c, 409, "EMAIL_IN_USE", "Account exists", "Sign in instead. We will not say whether an email is registered on the sign-in form.");
  const customer = {
    id: createId("cust"),
    storeId: STORE_ID,
    email,
    emailNormalized: email,
    name: parsed.data.name,
    passwordHash: hashPassword(parsed.data.password),
    phone: null,
    addresses: [],
    wishlist: [],
    consent: { marketing: false, updatedAt: new Date().toISOString(), version: "2026-11-18" },
    createdAt: new Date().toISOString(),
  };
  await store.saveCustomer(customer);
  writeCookie(c, "aurelia_customer", issueSession(customer.id, "customer", 60 * 60 * 24 * 30), 60 * 60 * 24 * 30);
  return c.json({ id: customer.id, name: customer.name, email: customer.email }, 201);
});

commerceRoutes.post("/auth/login", async (c) => {
  if (!rateLimit(`login:${clientIp(c)}`, 10, 10 * 60_000)) return problem(c, 429, "RATE_LIMITED", "Too many attempts", "Wait ten minutes, then try again.");
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1).max(72) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 401, "INVALID_LOGIN", "Sign-in failed", "The email or password is not valid.");
  const store = c.get("store");
  const customer = await store.findCustomerByEmail(normalizeEmail(parsed.data.email));
  const valid = customer ? verifyPassword(parsed.data.password, customer.passwordHash) : verifyPassword(parsed.data.password, hashPassword("dummy-password-value"));
  if (!customer || !valid) return problem(c, 401, "INVALID_LOGIN", "Sign-in failed", "The email or password is not valid.");
  const orders = await store.listOrders();
  for (const order of orders) {
    if (!order.customerId && order.email.toLowerCase() === customer.emailNormalized) {
      order.customerId = customer.id;
      await store.saveOrder(order);
    }
  }
  const cookieCart = await currentCart(c as never);
  if (cookieCart && cookieCart.lines.length) {
    cookieCart.customerId = customer.id;
    await store.saveCart(cookieCart);
    writeCartCookie(c, cookieCart);
  }
  writeCookie(c, "aurelia_customer", issueSession(customer.id, "customer", 60 * 60 * 24 * 30), 60 * 60 * 24 * 30);
  return c.json({ id: customer.id, name: customer.name, email: customer.email });
});

commerceRoutes.post("/auth/logout", (c) => {
  clearCookie(c, "aurelia_customer");
  return c.json({ ok: true });
});

commerceRoutes.get("/me", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to view this account.");
  return c.json({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    addresses: customer.addresses,
    wishlist: customer.wishlist,
    consent: customer.consent,
  });
});

commerceRoutes.patch("/me", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to update this account.");
  const parsed = z.object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: z.string().regex(/^[6-9]\d{9}$/).nullable().optional(),
    marketing: z.boolean().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the form", "The profile could not be saved.", fieldErrors(parsed.error));
  if (parsed.data.name) customer.name = parsed.data.name;
  if (parsed.data.phone !== undefined) customer.phone = parsed.data.phone;
  if (parsed.data.marketing !== undefined) customer.consent = { marketing: parsed.data.marketing, updatedAt: new Date().toISOString(), version: "2026-11-18" };
  await c.get("store").saveCustomer(customer);
  return c.json({ ok: true });
});

commerceRoutes.post("/me/addresses", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to save an address.");
  const parsed = AddressSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the address", "The address needs a name, mobile, and a 6-digit PIN.", fieldErrors(parsed.error));
  const address: Address = { id: createId("addr"), ...parsed.data, country: "IN" };
  customer.addresses.push(address);
  await c.get("store").saveCustomer(customer);
  return c.json(address, 201);
});

commerceRoutes.post("/me/wishlist", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to save a piece.");
  const parsed = z.object({ productId: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Missing product", "Choose a product to save.");
  if (!customer.wishlist.some((item) => item.productId === parsed.data.productId)) {
    customer.wishlist.push({ productId: parsed.data.productId, addedAt: new Date().toISOString() });
    await c.get("store").saveCustomer(customer);
  }
  return c.json({ wishlist: customer.wishlist });
});

commerceRoutes.delete("/me/wishlist/:productId", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to edit your wishlist.");
  customer.wishlist = customer.wishlist.filter((item) => item.productId !== c.req.param("productId"));
  await c.get("store").saveCustomer(customer);
  return c.json({ wishlist: customer.wishlist });
});

commerceRoutes.post("/me/privacy/delete-request", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to request deletion.");
  customer.consent = { marketing: false, updatedAt: new Date().toISOString(), version: "2026-11-18" };
  await c.get("store").saveCustomer(customer);
  await c.get("store").addAudit({
    id: createId("aud"),
    storeId: STORE_ID,
    actorId: customer.id,
    action: "privacy.delete_requested",
    entity: customer.id,
    summary: "Customer requested deletion. Orders stay for tax retention; marketing consent is withdrawn.",
    createdAt: new Date().toISOString(),
  });
  return c.json({ accepted: true, note: "Marketing consent is withdrawn. Orders remain for legal retention." }, 202);
});

commerceRoutes.post("/carts", async (c) => {
  const { customer } = await actor(c);
  const cart = emptyCart(customer?.id ?? null);
  await c.get("store").saveCart(cart);
  writeCartCookie(c, cart);
  return c.json(await presentCart(c.get("store"), cart), 201);
});

commerceRoutes.get("/carts/current", async (c) => {
  const cart = await currentCart(c as never);
  return c.json(await presentCart(c.get("store"), cart));
});

commerceRoutes.post("/carts/current/items", async (c) => {
  const parsed = z.object({ variantId: z.string(), quantity: z.number().int().min(1).max(8) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the selection", "Choose a colour, a size, and a quantity.", fieldErrors(parsed.error));
  try {
    const { customer } = await actor(c);
    let cart = await currentCart(c as never);
    if (!cart) cart = emptyCart(customer?.id ?? null);
    cart = await addLine(c.get("store"), cart, parsed.data.variantId, parsed.data.quantity);
    writeCartCookie(c, cart);
    return c.json(await presentCart(c.get("store"), cart));
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

commerceRoutes.patch("/carts/current/items/:lineId", async (c) => {
  const parsed = z.object({ quantity: z.number().int().min(0).max(8), variantId: z.string().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the line", "Quantity must be between 0 and 8.", fieldErrors(parsed.error));
  try {
    const cart = await currentCart(c as never);
    if (!cart) return problem(c, 404, "CART_EMPTY", "Bag is empty", "There is no bag to update.");
    const next = await updateLine(c.get("store"), cart, c.req.param("lineId"), parsed.data.quantity, parsed.data.variantId);
    writeCartCookie(c, next);
    return c.json(await presentCart(c.get("store"), next));
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

commerceRoutes.delete("/carts/current/items/:lineId", async (c) => {
  const cart = await currentCart(c as never);
  if (!cart) return c.json(await presentCart(c.get("store"), null));
  cart.lines = cart.lines.filter((line) => line.lineId !== c.req.param("lineId"));
  await c.get("store").saveCart(cart);
  writeCartCookie(c, cart);
  return c.json(await presentCart(c.get("store"), cart));
});

commerceRoutes.post("/carts/current/coupon", async (c) => {
  const parsed = z.object({ code: z.string().max(40).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the code", "Enter a promotion code.");
  let cart = await currentCart(c as never);
  if (!cart) cart = emptyCart();
  cart = await applyCoupon(c.get("store"), cart, parsed.data.code);
  writeCartCookie(c, cart);
  return c.json(await presentCart(c.get("store"), cart));
});

commerceRoutes.get("/shipping-quotes", async (c) => {
  const cart = await currentCart(c as never);
  const postalCode = c.req.query("postalCode") ?? null;
  if (postalCode && !/^\d{6}$/.test(postalCode)) return problem(c, 400, "VALIDATION", "Check the PIN", "Enter a 6-digit PIN code.");
  return c.json({ methods: await quoteShipping(c.get("store"), cart, postalCode) });
});

commerceRoutes.post("/checkouts", async (c) => {
  const key = requireIdempotency(c);
  if (!key) return problem(c, 400, "IDEMPOTENCY_REQUIRED", "Idempotency key required", "Send an Idempotency-Key header so a retry cannot create two orders.");
  const parsed = z.object({
    email: z.string().email(),
    shippingMethodId: z.enum(["standard", "express"]),
    acceptPriceChange: z.boolean().optional(),
    address: AddressSchema,
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check checkout", "Email, address, and a delivery method are required.", fieldErrors(parsed.error));
  const cart = await currentCart(c as never);
  if (!cart) return problem(c, 400, "CART_EMPTY", "Bag is empty", "Add a piece before checkout.");
  try {
    const { customer } = await actor(c);
    const cached = await c.get("store").getIdempotency("checkout", key);
    if (cached) return c.json(cached);
    const order = await placeOrder(c.get("store"), {
      cart,
      email: normalizeEmail(parsed.data.email),
      phone: parsed.data.address.phone,
      address: { id: createId("addr"), ...parsed.data.address, country: "IN" },
      shippingMethodId: parsed.data.shippingMethodId,
      idempotencyKey: key,
      customerId: customer?.id ?? null,
      acceptPriceChange: parsed.data.acceptPriceChange ?? false,
    });
    let payment: { provider: "sandbox" | "razorpay"; razorpayOrderId?: string; keyId?: string } = { provider: "sandbox" };
    if (razorpayConfigured()) {
      const providerOrder = await createRazorpayOrder(order.amounts.grandTotalMinor, order.orderNumber);
      payment = { provider: "razorpay", razorpayOrderId: providerOrder?.id, keyId: process.env.RAZORPAY_KEY_ID };
    }
    const body = { order: publicOrder(order), payment };
    await c.get("store").putIdempotency("checkout", key, body);
    writeReceipt(c, order);
    return c.json(body, 201);
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

commerceRoutes.post("/checkouts/:orderNumber/pay", async (c) => {
  const key = requireIdempotency(c);
  if (!key) return problem(c, 400, "IDEMPOTENCY_REQUIRED", "Idempotency key required", "Send an Idempotency-Key header so a retry cannot capture twice.");
  const store = c.get("store");
  const cached = await store.getIdempotency("pay", key);
  if (cached) return c.json(cached);
  const parsed = z.object({
    razorpayOrderId: z.string().optional(),
    razorpayPaymentId: z.string().optional(),
    razorpaySignature: z.string().optional(),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Payment rejected", "The payment confirmation was not valid.");
  const number = c.req.param("orderNumber");
  let order = (await store.getOrderByNumber(number)) ?? readReceipts(c).find((item) => item.orderNumber === number) ?? null;
  if (!order) return problem(c, 404, "NOT_FOUND", "Order not found", "That checkout could not be found.");
  if (!(await store.getOrderByNumber(number))) await store.saveOrder(order);
  try {
    if (razorpayConfigured()) {
      const secret = process.env.RAZORPAY_KEY_SECRET ?? "";
      const ok = parsed.data.razorpayOrderId && parsed.data.razorpayPaymentId && parsed.data.razorpaySignature
        ? verifyPaymentSignature(parsed.data.razorpayOrderId, parsed.data.razorpayPaymentId, parsed.data.razorpaySignature, secret)
        : false;
      if (!ok) return problem(c, 400, "PAYMENT_UNVERIFIED", "Payment not verified", "The payment signature did not match.");
    }
    const { customer } = await actor(c);
    order = await markOrderPaid(store, order, customer?.id ?? order.email);
    const cart = await currentCart(c as never);
    if (cart) {
      cart.lines = [];
      cart.couponCode = null;
      await store.saveCart(cart);
      writeCartCookie(c, cart);
    }
    writeReceipt(c, order);
    const body = { order: publicOrder(order) };
    await store.putIdempotency("pay", key, body);
    return c.json(body);
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

commerceRoutes.post("/webhooks/razorpay", async (c) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return problem(c, 503, "WEBHOOK_UNCONFIGURED", "Webhook not configured", "Set the Razorpay webhook secret.");
  const raw = await c.req.text();
  const signature = c.req.header("x-razorpay-signature");
  if (!verifyWebhook(raw, signature, secret)) return problem(c, 400, "WEBHOOK_SIGNATURE", "Signature rejected", "The webhook signature did not match.");
  const event = JSON.parse(raw) as { id?: string; event?: string; payload?: { payment?: { entity?: { order_id?: string; id?: string } } } };
  const eventId = event.id ?? `${event.event}:${event.payload?.payment?.entity?.id ?? "unknown"}`;
  const marker = await c.get("store").markWebhook("razorpay", eventId);
  if (marker === "duplicate") return c.json({ received: true, duplicate: true });
  return c.json({ received: true });
});

async function readableOrder(c: { get: (key: "store") => AppEnv["Variables"]["store"]; req: { param: (name: string) => string } }, orderNumber: string): Promise<Order | null> {
  const store = c.get("store");
  return (await store.getOrderByNumber(orderNumber)) ?? null;
}

commerceRoutes.get("/me/orders", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to see orders.");
  const orders = await c.get("store").listOrders();
  const mine = orders.filter((order) => order.customerId === customer.id || order.email === customer.emailNormalized);
  const cookieOrders = readReceipts(c).filter((order) => order.email === customer.emailNormalized && !mine.some((item) => item.orderNumber === order.orderNumber));
  return c.json({ orders: [...cookieOrders, ...mine].map(publicOrder) });
});

commerceRoutes.get("/orders/:orderNumber", async (c) => {
  const number = c.req.param("orderNumber");
  const storeOrder = await readableOrder(c, number);
  const cookieOrder = readReceipts(c).find((order) => order.orderNumber === number) ?? null;
  const order = storeOrder ?? cookieOrder;
  if (!order) return problem(c, 404, "NOT_FOUND", "Order not found", "That order could not be found.");
  const { customer, staff } = await actor(c);
  const allowed = Boolean(staff) || Boolean(cookieOrder) || Boolean(customer && (order.customerId === customer.id || order.email === customer.emailNormalized));
  if (!allowed) return problem(c, 404, "NOT_FOUND", "Order not found", "That order could not be found.");
  return c.json(publicOrder(order));
});

commerceRoutes.post("/orders/:orderNumber/cancel-intents", async (c) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Reason required", "Tell us why you are cancelling.", fieldErrors(parsed.error));
  const store = c.get("store");
  const order = await store.getOrderByNumber(c.req.param("orderNumber"));
  if (!order) return problem(c, 404, "NOT_FOUND", "Order not found", "That order could not be found.");
  const { customer } = await actor(c);
  if (!customer || (order.customerId !== customer.id && order.email !== customer.emailNormalized)) {
    return problem(c, 404, "NOT_FOUND", "Order not found", "That order could not be found.");
  }
  try {
    const next = await cancelOrder(store, order, customer.id, parsed.data.reason, true);
    writeReceipt(c, next);
    return c.json(publicOrder(next));
  } catch (error) {
    if (error instanceof CommerceError) return fromError(c, error);
    throw error;
  }
});

commerceRoutes.post("/orders/:orderNumber/return-intents", async (c) => {
  const parsed = z.object({ lineId: z.string(), reason: z.string().trim().min(3).max(240) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the return", "Choose an item and a reason.", fieldErrors(parsed.error));
  const store = c.get("store");
  const order = await store.getOrderByNumber(c.req.param("orderNumber"));
  if (!order) return problem(c, 404, "NOT_FOUND", "Order not found", "That order could not be found.");
  const { customer } = await actor(c);
  if (!customer || (order.customerId !== customer.id && order.email !== customer.emailNormalized)) {
    return problem(c, 404, "NOT_FOUND", "Order not found", "That order could not be found.");
  }
  const line = order.lines.find((item) => item.lineId === parsed.data.lineId);
  if (!line) return problem(c, 404, "LINE_NOT_FOUND", "Item not found", "That item is not on the order.");
  const product = (await store.listProducts()).find((item) => item.id === line.productId);
  const delivered = order.timeline.find((event) => event.type === "delivered");
  const decision = returnEligibility({ orderState: order.state, deliveredAt: delivered?.at ?? null, categorySlug: product?.categorySlug ?? "", now: Date.now() });
  if (!decision.eligible) return problem(c, 409, "RETURN_INELIGIBLE", "Return not available", decision.reason);
  const created = {
    id: createId("ret"),
    storeId: STORE_ID,
    returnNumber: `RT-${order.orderNumber.slice(3)}`,
    orderNumber: order.orderNumber,
    email: order.email,
    lineId: line.lineId,
    reason: parsed.data.reason,
    state: "requested" as const,
    createdAt: new Date().toISOString(),
  };
  await store.saveReturn(created);
  return c.json(created, 201);
});

commerceRoutes.post("/products/:slug/reviews", async (c) => {
  const { customer } = await actor(c);
  if (!customer) return problem(c, 401, "UNAUTHENTICATED", "Sign in required", "Sign in to review a piece you bought.");
  const parsed = z.object({
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().min(3).max(80),
    body: z.string().trim().min(8).max(600),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Check the review", "Add a rating, a title, and a short note.", fieldErrors(parsed.error));
  const store = c.get("store");
  const product = (await store.listProducts()).find((item) => item.slug === c.req.param("slug"));
  if (!product) return problem(c, 404, "NOT_FOUND", "Product not found", "That piece is not published.");
  const orders = await store.listOrders();
  const purchased = orders.some((order) => (order.customerId === customer.id || order.email === customer.emailNormalized) && order.paymentState === "paid" && order.lines.some((line) => line.productId === product.id));
  if (!purchased) return problem(c, 403, "REVIEW_UNVERIFIED", "Purchase required", "Reviews are limited to paid orders of this piece.");
  await store.saveReview({
    id: createId("rev"),
    productId: product.id,
    author: customer.name,
    rating: parsed.data.rating,
    title: parsed.data.title,
    body: parsed.data.body,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  return c.json({ accepted: true, status: "pending" }, 202);
});

commerceRoutes.post("/assistant/messages", async (c) => {
  if (process.env.AI_ENABLED === "false") return problem(c, 503, "ASSISTANT_DISABLED", "Assistant is off", "Search and checkout are still available.");
  if (!rateLimit(`ai:${clientIp(c)}`, 30, 60_000)) return problem(c, 429, "RATE_LIMITED", "Too many attempts", "Wait a minute before another question.");
  const parsed = z.object({
    message: z.string().trim().min(1).max(500),
    confirmToken: z.string().optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c, 400, "VALIDATION", "Message required", "Write a short question.", fieldErrors(parsed.error));
  const { customer } = await actor(c);
  const response = await answerAssistant(c.get("store"), { message: parsed.data.message, customer, confirmToken: parsed.data.confirmToken });
  return c.json(response);
});

