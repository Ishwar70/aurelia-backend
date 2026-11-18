import { createHash } from "node:crypto";
import { CommerceError } from "../domain/errors";
import { createId, orderNumber, sha256 } from "../domain/ids";
import { allocateDiscount, includedGstMinor, unitPriceMinor } from "../domain/money";
import { canTransition, customerMayCancel } from "../domain/orders";
import { evaluateCoupon, quoteTotals, shippingMethods, type ShippingMethod } from "../domain/pricing";
import { POLICY_VERSION, STORE_ID, type Address, type Cart, type CartLine, type Order, type OrderLine, type Product } from "../domain/types";
import type { CommerceStore } from "../data/store";

export interface PricedLine {
  lineId: string;
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  optionLabel: string;
  image: string | null;
  quantity: number;
  unitPriceMinor: number;
  compareAtMinor: number | null;
  lineTotalMinor: number;
  available: number;
  priceChanged: boolean;
  inStock: boolean;
}

export interface CartView {
  id: string | null;
  lines: PricedLine[];
  coupon: { code: string; label: string | null; discountMinor: number; error: string | null } | null;
  amounts: ReturnType<typeof quoteTotals>;
  currency: "INR";
}

interface LocatedVariant {
  product: Product;
  variant: Product["variants"][number];
}

function locate(products: Product[], variantId: string): LocatedVariant | null {
  for (const product of products) {
    const variant = product.variants.find((item) => item.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

export async function presentCart(store: CommerceStore, cart: Cart | null): Promise<CartView> {
  const products = await store.listProducts();
  const balances = await store.getBalances();
  const available = new Map(balances.map((balance) => [balance.variantId, balance.availableToSell]));
  const lines: PricedLine[] = [];
  for (const line of cart?.lines ?? []) {
    const found = locate(products, line.variantId);
    if (!found || found.product.status !== "active" || found.variant.status !== "active") continue;
    const unit = unitPriceMinor(found.variant.pricing);
    const onHand = available.get(line.variantId) ?? 0;
    lines.push({
      lineId: line.lineId,
      variantId: line.variantId,
      productId: found.product.id,
      slug: found.product.slug,
      name: found.product.name,
      optionLabel: found.variant.options.map((option) => option.label).join(" / "),
      image: found.product.media[0]?.url ?? null,
      quantity: line.quantity,
      unitPriceMinor: unit,
      compareAtMinor: found.variant.pricing.saleMinor != null ? found.variant.pricing.listMinor : null,
      lineTotalMinor: unit * line.quantity,
      available: onHand,
      priceChanged: line.quotedUnitPriceMinor !== unit,
      inStock: onHand >= line.quantity,
    });
  }
  const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const coupon = evaluateCoupon(subtotalMinor, cart?.couponCode ?? null);
  const discountMinor = coupon.error ? 0 : coupon.discountMinor;
  return {
    id: cart?.id ?? null,
    lines,
    coupon: cart?.couponCode ? { code: coupon.code ?? cart.couponCode, label: coupon.label, discountMinor, error: coupon.error } : null,
    amounts: quoteTotals({ subtotalMinor, discountMinor, shippingMinor: 0 }),
    currency: "INR",
  };
}

export function emptyCart(customerId: string | null = null): Cart {
  return {
    id: createId("cart"),
    storeId: STORE_ID,
    customerId,
    lines: [],
    couponCode: null,
    updatedAt: new Date().toISOString(),
  };
}

export async function addLine(store: CommerceStore, cart: Cart, variantId: string, quantity: number): Promise<Cart> {
  if (quantity < 1 || quantity > 8) {
    throw new CommerceError(400, "INVALID_QUANTITY", "Invalid quantity", "Choose between 1 and 8 units.");
  }
  const products = await store.listProducts();
  const found = locate(products, variantId);
  if (!found || found.product.status !== "active") {
    throw new CommerceError(404, "VARIANT_NOT_FOUND", "Variant not found", "That option is no longer sold.");
  }
  const balances = await store.getBalances();
  const available = balances.find((balance) => balance.variantId === variantId)?.availableToSell ?? 0;
  const existing = cart.lines.find((line) => line.variantId === variantId);
  const nextQty = (existing?.quantity ?? 0) + quantity;
  if (nextQty > available) {
    throw new CommerceError(409, "CART_STOCK_CHANGED", "Availability changed", "That quantity is no longer available.", {
      errors: [{ variantId, available }],
    });
  }
  const unit = unitPriceMinor(found.variant.pricing);
  if (existing) {
    existing.quantity = nextQty;
    existing.quotedUnitPriceMinor = unit;
  } else {
    const line: CartLine = { lineId: createId("line"), variantId, quantity, quotedUnitPriceMinor: unit };
    cart.lines.push(line);
  }
  cart.updatedAt = new Date().toISOString();
  await store.saveCart(cart);
  return cart;
}

export async function updateLine(store: CommerceStore, cart: Cart, lineId: string, quantity: number, variantId?: string): Promise<Cart> {
  const line = cart.lines.find((item) => item.lineId === lineId);
  if (!line) throw new CommerceError(404, "LINE_NOT_FOUND", "Line not found", "That bag line is no longer in the bag.");
  if (quantity <= 0) {
    cart.lines = cart.lines.filter((item) => item.lineId !== lineId);
  } else {
    const nextVariant = variantId ?? line.variantId;
    const products = await store.listProducts();
    const found = locate(products, nextVariant);
    if (!found) throw new CommerceError(404, "VARIANT_NOT_FOUND", "Variant not found", "That option is no longer sold.");
    const balances = await store.getBalances();
    const available = balances.find((balance) => balance.variantId === nextVariant)?.availableToSell ?? 0;
    if (quantity > available) {
      throw new CommerceError(409, "CART_STOCK_CHANGED", "Availability changed", "That quantity is no longer available.", {
        errors: [{ lineId, available }],
      });
    }
    line.variantId = nextVariant;
    line.quantity = quantity;
    line.quotedUnitPriceMinor = unitPriceMinor(found.variant.pricing);
  }
  cart.updatedAt = new Date().toISOString();
  await store.saveCart(cart);
  return cart;
}

export async function applyCoupon(store: CommerceStore, cart: Cart, code: string | null): Promise<Cart> {
  cart.couponCode = code ? code.trim().toUpperCase() : null;
  cart.updatedAt = new Date().toISOString();
  await store.saveCart(cart);
  return cart;
}

export async function quoteShipping(store: CommerceStore, cart: Cart | null, postalCode: string | null): Promise<ShippingMethod[]> {
  const view = await presentCart(store, cart);
  const discount = view.coupon?.error ? 0 : view.coupon?.discountMinor ?? 0;
  return shippingMethods(view.amounts.subtotalMinor - discount, postalCode);
}

export interface CheckoutInput {
  cart: Cart;
  email: string;
  phone: string;
  address: Address;
  shippingMethodId: "standard" | "express";
  idempotencyKey: string;
  customerId: string | null;
  acceptPriceChange: boolean;
}

export async function placeOrder(store: CommerceStore, input: CheckoutInput): Promise<Order> {
  const existing = await store.findOrderByIdempotency(input.idempotencyKey);
  if (existing) return existing;
  const view = await presentCart(store, input.cart);
  if (view.lines.length === 0) {
    throw new CommerceError(400, "CART_EMPTY", "Bag is empty", "Add a piece before checkout.");
  }
  if (view.lines.some((line) => !line.inStock)) {
    throw new CommerceError(409, "CART_STOCK_CHANGED", "Availability changed", "One item is no longer available in the requested quantity.", {
      errors: view.lines.filter((line) => !line.inStock).map((line) => ({ lineId: line.lineId, available: line.available })),
    });
  }
  if (view.lines.some((line) => line.priceChanged) && !input.acceptPriceChange) {
    throw new CommerceError(409, "PRICE_CHANGED", "Price changed", "A price changed since it was added. Review the new total to continue.", {
      amounts: view.amounts,
    });
  }
  if (view.coupon?.error) {
    throw new CommerceError(400, "COUPON_INVALID", "Code not applied", view.coupon.error);
  }
  const methods = await quoteShipping(store, input.cart, input.address.postalCode);
  const method = methods.find((item) => item.id === input.shippingMethodId);
  if (!method?.available) {
    throw new CommerceError(400, "SHIPPING_UNAVAILABLE", "Delivery unavailable", method?.reason ?? "Choose a delivery method.");
  }
  const reservation = await store.reserve(
    view.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
    input.idempotencyKey,
  );
  if (!reservation.ok) {
    throw new CommerceError(409, "CART_STOCK_CHANGED", "Availability changed", "One item sold while you were checking out.", {
      errors: [{ variantId: reservation.variantId, available: reservation.available }],
    });
  }
  const discountShares = allocateDiscount(
    view.lines.map((line) => line.lineTotalMinor),
    view.amounts.discountMinor,
  );
  const orderLines: OrderLine[] = view.lines.map((line, index) => {
    const discountMinor = discountShares[index] ?? 0;
    const totalMinor = line.lineTotalMinor - discountMinor;
    return {
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      sku: "",
      nameSnapshot: line.name,
      optionSnapshot: line.optionLabel,
      imageSnapshot: line.image ?? "",
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      discountMinor,
      taxMinor: includedGstMinor(totalMinor),
      totalMinor,
    };
  });
  const products = await store.listProducts();
  for (const orderLine of orderLines) {
    const found = locate(products, orderLine.variantId);
    orderLine.sku = found?.variant.sku ?? "";
  }
  const amounts = quoteTotals({
    subtotalMinor: view.amounts.subtotalMinor,
    discountMinor: view.amounts.discountMinor,
    shippingMinor: method.priceMinor,
  });
  const now = new Date().toISOString();
  const number = orderNumber();
  const order: Order = {
    id: createId("ord"),
    storeId: STORE_ID,
    orderNumber: number,
    customerId: input.customerId,
    email: input.email,
    phone: input.phone,
    state: "pending_payment",
    paymentState: "pending",
    fulfilmentState: "unfulfilled",
    lines: orderLines,
    amounts,
    shippingAddressSnapshot: input.address,
    shippingMethod: { id: method.id, label: method.label, eta: method.eta },
    promotionSnapshots: view.coupon?.code && view.amounts.discountMinor > 0 ? [{ code: view.coupon.code, label: view.coupon.label ?? view.coupon.code, amountMinor: view.amounts.discountMinor }] : [],
    inventoryReservationIds: reservation.reservationIds,
    timeline: [{ at: now, type: "checkout.started", actorRef: input.customerId ?? input.email, note: "Payment pending verification" }],
    risk: amounts.grandTotalMinor >= 10_000_000 ? "review" : "low",
    exception: null,
    idempotencyKey: input.idempotencyKey,
    policyVersion: POLICY_VERSION,
    invoice: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.saveOrder(order);
  return order;
}

export async function markOrderPaid(store: CommerceStore, order: Order, actorRef: string): Promise<Order> {
  if (order.paymentState === "paid") return order;
  if (order.state !== "pending_payment") {
    throw new CommerceError(409, "ORDER_STATE", "Order cannot be paid", "This order is not awaiting payment.");
  }
  const reservations = await store.listReservations();
  const active = reservations.filter((reservation) => order.inventoryReservationIds.includes(reservation.id) && reservation.state === "active");
  const reservedQty = new Map<string, number>();
  for (const reservation of active) reservedQty.set(reservation.variantId, (reservedQty.get(reservation.variantId) ?? 0) + reservation.qty);
  const covered = order.lines.every((line) => (reservedQty.get(line.variantId) ?? 0) >= line.quantity);
  if (!covered) {
    await store.releaseReservations(active.map((reservation) => reservation.id), "rehold", actorRef);
    const again = await store.reserve(
      order.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      order.orderNumber,
    );
    if (!again.ok) {
      throw new CommerceError(409, "CART_STOCK_CHANGED", "Availability changed", "The reserved pieces are no longer available.", {
        errors: [{ variantId: again.variantId, available: again.available }],
      });
    }
    order.inventoryReservationIds = again.reservationIds;
  }
  await store.commitReservations(order.inventoryReservationIds, order.orderNumber, actorRef);
  const now = new Date().toISOString();
  order.state = "confirmed";
  order.paymentState = "paid";
  order.invoice = {
    number: `INV-${order.orderNumber}`,
    taxMinor: order.amounts.taxMinor,
    hash: sha256(JSON.stringify({ amounts: order.amounts, lines: order.lines.map((line) => line.sku + line.quantity + line.totalMinor) })),
  };
  order.timeline.push({ at: now, type: "payment.succeeded", actorRef, note: "Payment verified" });
  order.updatedAt = now;
  order.exception = null;
  await store.saveOrder(order);
  return order;
}

export async function cancelOrder(store: CommerceStore, order: Order, actorRef: string, reason: string, asCustomer: boolean): Promise<Order> {
  if (asCustomer && !customerMayCancel(order.state)) {
    throw new CommerceError(409, "CANCEL_DENIED", "Cancellation denied", "This order has already moved into fulfilment. Contact client care.");
  }
  if (!canTransition(order.state, "cancelled") && order.state !== "cancelled") {
    throw new CommerceError(409, "ORDER_STATE", "Invalid transition", "This order cannot be cancelled from its current state.");
  }
  if (order.state === "cancelled") return order;
  await store.releaseReservations(order.inventoryReservationIds, "cancel", actorRef);
  const now = new Date().toISOString();
  order.state = "cancelled";
  if (order.paymentState === "paid") order.paymentState = "refunded";
  if (order.paymentState === "pending") order.paymentState = "failed";
  order.timeline.push({ at: now, type: "order.cancelled", actorRef, note: reason });
  order.updatedAt = now;
  await store.saveOrder(order);
  return order;
}

export function publicOrder(order: Order) {
  return {
    orderNumber: order.orderNumber,
    email: order.email,
    state: order.state,
    paymentState: order.paymentState,
    fulfilmentState: order.fulfilmentState,
    lines: order.lines,
    amounts: order.amounts,
    shippingAddress: order.shippingAddressSnapshot,
    shippingMethod: order.shippingMethod,
    promotions: order.promotionSnapshots,
    timeline: order.timeline,
    risk: order.risk,
    exception: order.exception,
    invoice: order.invoice,
    policyVersion: order.policyVersion,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function invoiceHashMatches(order: Order): boolean {
  if (!order.invoice) return false;
  const hash = createHash("sha256")
    .update(JSON.stringify({ amounts: order.amounts, lines: order.lines.map((line) => line.sku + line.quantity + line.totalMinor) }))
    .digest("hex");
  return hash === order.invoice.hash;
}
