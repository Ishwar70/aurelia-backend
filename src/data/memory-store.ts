import { CommerceError } from "../domain/errors";
import { createId } from "../domain/ids";
import { RESERVATION_TTL_MINUTES, adjustOnHand, commitQuantity, releaseQuantity, reserveQuantity } from "../domain/inventory";
import { STORE_ID, WAREHOUSE_ID, type AuditEntry, type BackInStockRequest, type Balance, type Cart, type Customer, type Movement, type Order, type Reservation, type Snapshot } from "../domain/types";
import type { CommerceStore, ReserveFailure, ReserveResult } from "./store";
import { buildSeed } from "./seed";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStore implements CommerceStore {
  readonly mode = "memory" as const;

  constructor(private state: Snapshot) {}

  static fromSeed(): MemoryStore {
    return new MemoryStore(buildSeed());
  }

  static fromSnapshot(snapshot: Snapshot): MemoryStore {
    return new MemoryStore(clone(snapshot));
  }

  exportSnapshot(): Snapshot {
    return clone(this.state);
  }

  async releaseExpired(now = Date.now()): Promise<number> {
    const expired = this.state.reservations.filter(
      (reservation) => reservation.state === "active" && Date.parse(reservation.expiresAt) <= now,
    );
    for (const reservation of expired) {
      reservation.state = "expired";
      this.applyRelease(reservation.variantId, reservation.qty, "reservation_expired", reservation.id, "system");
    }
    return expired.length;
  }

  async listProducts() {
    return clone(this.state.products);
  }

  async saveProduct(product: Snapshot["products"][number]) {
    const index = this.state.products.findIndex((item) => item.id === product.id);
    if (index < 0) this.state.products.push(clone(product));
    else this.state.products[index] = clone(product);
  }

  async getBalances() {
    return clone(this.state.balances);
  }

  async reserve(lines: { variantId: string; quantity: number }[], ownerId: string): Promise<ReserveResult | ReserveFailure> {
    await this.releaseExpired();
    for (const line of lines) {
      const balance = this.balance(line.variantId);
      if (!balance || balance.availableToSell < line.quantity) {
        return { ok: false, variantId: line.variantId, available: balance?.availableToSell ?? 0 };
      }
    }
    const reservationIds: string[] = [];
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000).toISOString();
    for (const line of lines) {
      const balance = this.balance(line.variantId);
      if (!balance) return { ok: false, variantId: line.variantId, available: 0 };
      const next = reserveQuantity(balance, line.quantity);
      if (!next) return { ok: false, variantId: line.variantId, available: balance.availableToSell };
      this.replaceBalance(next);
      const reservation: Reservation = {
        id: createId("rsv"),
        storeId: STORE_ID,
        variantId: line.variantId,
        warehouseId: WAREHOUSE_ID,
        qty: line.quantity,
        state: "active",
        ownerId,
        expiresAt,
        createdAt: new Date().toISOString(),
      };
      this.state.reservations.push(reservation);
      this.pushMovement(line.variantId, 0, line.quantity, "reserve", reservation.id, ownerId);
      reservationIds.push(reservation.id);
    }
    return { ok: true, reservationIds };
  }

  async commitReservations(ids: string[], reference: string, actorId: string) {
    for (const id of ids) {
      const reservation = this.state.reservations.find((item) => item.id === id);
      if (!reservation || reservation.state !== "active") continue;
      reservation.state = "converted";
      const balance = this.balance(reservation.variantId);
      if (!balance) continue;
      this.replaceBalance(commitQuantity(balance, reservation.qty));
      this.pushMovement(reservation.variantId, -reservation.qty, -reservation.qty, "sale", reference, actorId);
    }
  }

  async releaseReservations(ids: string[], reason: string, actorId: string) {
    for (const id of ids) {
      const reservation = this.state.reservations.find((item) => item.id === id);
      if (!reservation || reservation.state !== "active") continue;
      reservation.state = "released";
      this.applyRelease(reservation.variantId, reservation.qty, reason, id, actorId);
    }
  }

  async adjustInventory(input: { variantId: string; deltaOnHand: number; reason: string; actorId: string }) {
    const balance = this.balance(input.variantId);
    if (!balance) throw new CommerceError(404, "VARIANT_NOT_FOUND", "Variant not found", "No inventory balance exists for this variant.");
    const next = adjustOnHand(balance, input.deltaOnHand);
    if (!next) {
      throw new CommerceError(409, "INVENTORY_CONFLICT", "Inventory conflict", "That adjustment would drop on-hand below reserved units.");
    }
    this.replaceBalance(next);
    this.pushMovement(input.variantId, input.deltaOnHand, 0, input.reason, createId("adj"), input.actorId);
    return clone(next);
  }

  async listMovements() {
    return clone(this.state.movements);
  }

  async listReservations() {
    return clone(this.state.reservations);
  }

  async getCart(id: string) {
    const cart = this.state.carts.find((item) => item.id === id);
    return cart ? clone(cart) : null;
  }

  async saveCart(cart: Cart) {
    const index = this.state.carts.findIndex((item) => item.id === cart.id);
    if (index < 0) this.state.carts.push(clone(cart));
    else this.state.carts[index] = clone(cart);
  }

  async deleteCart(id: string) {
    this.state.carts = this.state.carts.filter((cart) => cart.id !== id);
  }

  async findCustomerByEmail(email: string) {
    const customer = this.state.customers.find((item) => item.emailNormalized === email);
    return customer ? clone(customer) : null;
  }

  async getCustomer(id: string) {
    const customer = this.state.customers.find((item) => item.id === id);
    return customer ? clone(customer) : null;
  }

  async saveCustomer(customer: Customer) {
    const index = this.state.customers.findIndex((item) => item.id === customer.id);
    if (index < 0) this.state.customers.push(clone(customer));
    else this.state.customers[index] = clone(customer);
  }

  async listCustomers() {
    return clone(this.state.customers);
  }

  async findStaffByEmail(email: string) {
    const staff = this.state.staff.find((item) => item.email === email);
    return staff ? clone(staff) : null;
  }

  async getStaff(id: string) {
    const staff = this.state.staff.find((item) => item.id === id);
    return staff ? clone(staff) : null;
  }

  async listOrders() {
    return clone(this.state.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getOrderByNumber(orderNumber: string) {
    const order = this.state.orders.find((item) => item.orderNumber === orderNumber);
    return order ? clone(order) : null;
  }

  async saveOrder(order: Order) {
    const index = this.state.orders.findIndex((item) => item.id === order.id);
    if (index < 0) this.state.orders.push(clone(order));
    else this.state.orders[index] = clone(order);
  }

  async findOrderByIdempotency(key: string) {
    const order = this.state.orders.find((item) => item.idempotencyKey === key);
    return order ? clone(order) : null;
  }

  async listReviews(productId: string) {
    return clone(this.state.reviews.filter((review) => review.productId === productId && review.status === "approved"));
  }

  async saveReview(review: Snapshot["reviews"][number]) {
    this.state.reviews.push(clone(review));
  }

  async listReturns() {
    return clone(this.state.returns);
  }

  async saveReturn(item: Snapshot["returns"][number]) {
    const index = this.state.returns.findIndex((entry) => entry.id === item.id);
    if (index < 0) this.state.returns.push(clone(item));
    else this.state.returns[index] = clone(item);
  }

  async listAudit() {
    return clone(this.state.audit).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addAudit(entry: AuditEntry) {
    this.state.audit.push(clone(entry));
  }

  async listSynonyms() {
    return clone(this.state.synonyms);
  }

  async saveSynonym(set: Snapshot["synonyms"][number]) {
    const index = this.state.synonyms.findIndex((item) => item.id === set.id);
    if (index < 0) this.state.synonyms.push(clone(set));
    else this.state.synonyms[index] = clone(set);
  }

  async listBackInStock() {
    return clone(this.state.backInStock);
  }

  async saveBackInStock(request: BackInStockRequest) {
    this.state.backInStock.push(clone(request));
  }

  async saveConversation(conversation: Snapshot["conversations"][number]) {
    const index = this.state.conversations.findIndex((item) => item.id === conversation.id);
    if (index < 0) this.state.conversations.push(clone(conversation));
    else this.state.conversations[index] = clone(conversation);
  }

  async getConversation(id: string) {
    const conversation = this.state.conversations.find((item) => item.id === id);
    return conversation ? clone(conversation) : null;
  }

  async getIdempotency(scope: string, key: string) {
    const record = this.state.idempotency.find((item) => item.scope === scope && item.key === key);
    return record ? clone(record.value) : null;
  }

  async putIdempotency(scope: string, key: string, value: unknown) {
    const index = this.state.idempotency.findIndex((item) => item.scope === scope && item.key === key);
    const record = { scope, key, value: clone(value) };
    if (index < 0) this.state.idempotency.push(record);
    else this.state.idempotency[index] = record;
  }

  async markWebhook(provider: string, eventId: string) {
    const id = `${provider}:${eventId}`;
    if (this.state.webhooks.some((item) => item.id === id)) return "duplicate" as const;
    this.state.webhooks.push({ id, provider, eventId });
    return "new" as const;
  }

  private balance(variantId: string): Balance | undefined {
    return this.state.balances.find((item) => item.variantId === variantId);
  }

  private replaceBalance(balance: Balance) {
    const index = this.state.balances.findIndex((item) => item.variantId === balance.variantId);
    if (index >= 0) this.state.balances[index] = balance;
  }

  private applyRelease(variantId: string, qty: number, reason: string, reference: string, actorId: string) {
    const balance = this.balance(variantId);
    if (!balance) return;
    this.replaceBalance(releaseQuantity(balance, qty));
    this.pushMovement(variantId, 0, -qty, reason, reference, actorId);
  }

  private pushMovement(variantId: string, deltaOnHand: number, deltaReserved: number, reason: string, reference: string, actorId: string) {
    const movement: Movement = {
      id: createId("mov"),
      storeId: STORE_ID,
      variantId,
      deltaOnHand,
      deltaReserved,
      reason,
      reference,
      actorId,
      createdAt: new Date().toISOString(),
    };
    this.state.movements.push(movement);
  }
}

export async function attachCustomerOrders(store: CommerceStore, customer: Customer) {
  const orders = await store.listOrders();
  for (const order of orders) {
    if (!order.customerId && order.email.toLowerCase() === customer.emailNormalized) {
      order.customerId = customer.id;
      await store.saveOrder(order);
    }
  }
}
