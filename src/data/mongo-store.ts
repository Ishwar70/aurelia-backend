import type { Db } from "mongodb";
import { createId } from "../domain/ids";
import { RESERVATION_TTL_MINUTES } from "../domain/inventory";
import { STORE_ID, WAREHOUSE_ID, type Balance, type Reservation, type Snapshot } from "../domain/types";
import { MemoryStore } from "./memory-store";
import type { CommerceStore, ReserveFailure, ReserveResult } from "./store";

const SNAPSHOT_KEYS = [
  "products",
  "balances",
  "movements",
  "reservations",
  "carts",
  "customers",
  "staff",
  "orders",
  "reviews",
  "returns",
  "audit",
  "synonyms",
  "backInStock",
  "conversations",
  "idempotency",
  "webhooks",
] as const;

function stripId<T>(value: T): T {
  if (value && typeof value === "object") {
    const copy = { ...(value as Record<string, unknown>) };
    delete copy._id;
    return copy as T;
  }
  return value;
}

export class MongoStore implements CommerceStore {
  readonly mode = "mongodb" as const;

  private constructor(
    private inner: MemoryStore,
    private readonly db: Db,
  ) {}

  static async open(db: Db): Promise<MongoStore> {
    await db.collection("products").createIndex({ storeId: 1, slug: 1 }, { unique: true });
    await db.collection("orders").createIndex({ storeId: 1, orderNumber: 1 }, { unique: true });
    await db.collection("balances").createIndex({ variantId: 1 }, { unique: true });
    await db.collection("customers").createIndex({ emailNormalized: 1 }, { unique: true });
    await db.collection("idempotency").createIndex({ scope: 1, key: 1 }, { unique: true });
    await db.collection("webhooks").createIndex({ id: 1 }, { unique: true });

    const existing = await db.collection("products").countDocuments();
    const inner = MemoryStore.fromSeed();
    if (existing === 0) {
      const snapshot = inner.exportSnapshot();
      for (const key of SNAPSHOT_KEYS) {
        const docs = snapshot[key];
        if (docs.length) await db.collection(key).insertMany(docs);
      }
    } else {
      const snapshot = {} as Snapshot;
      for (const key of SNAPSHOT_KEYS) {
        const docs = await db.collection(key).find({}, { projection: { _id: 0 } }).toArray();
        (snapshot as unknown as Record<string, unknown>)[key] = docs;
      }
      return new MongoStore(MemoryStore.fromSnapshot(snapshot), db);
    }
    return new MongoStore(inner, db);
  }

  private async upsert(collection: string, id: string, doc: unknown) {
    await this.db.collection(collection).updateOne({ id }, { $set: stripId(doc) as Record<string, unknown> }, { upsert: true });
  }

  async releaseExpired(now?: number) {
    const count = await this.inner.releaseExpired(now);
    if (count > 0) {
      for (const reservation of await this.inner.listReservations()) await this.upsert("reservations", reservation.id, reservation);
      for (const balance of await this.inner.getBalances()) await this.upsert("balances", balance.id, balance);
    }
    return count;
  }

  listProducts() {
    return this.inner.listProducts();
  }

  async saveProduct(product: Snapshot["products"][number]) {
    await this.inner.saveProduct(product);
    await this.upsert("products", product.id, product);
  }

  getBalances() {
    return this.inner.getBalances();
  }

  async reserve(lines: { variantId: string; quantity: number }[], ownerId: string): Promise<ReserveResult | ReserveFailure> {
    await this.releaseExpired();
    const created: string[] = [];
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000).toISOString();
    for (const line of lines) {
      const updated = await this.db.collection<Balance>("balances").findOneAndUpdate(
        { variantId: line.variantId, availableToSell: { $gte: line.quantity } },
        { $inc: { reserved: line.quantity, availableToSell: -line.quantity, version: 1 } },
        { returnDocument: "after" },
      );
      const next = updated && typeof updated === "object" && "value" in updated ? updated.value : updated;
      if (!next) {
        await this.rollbackMongoReservations(created);
        await this.reloadInventory();
        const current = await this.db.collection<Balance>("balances").findOne({ variantId: line.variantId }, { projection: { _id: 0 } });
        return { ok: false, variantId: line.variantId, available: current?.availableToSell ?? 0 };
      }
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
      await this.db.collection("reservations").insertOne({ ...reservation });
      created.push(reservation.id);
    }
    await this.reloadInventory();
    return { ok: true, reservationIds: created };
  }

  private async rollbackMongoReservations(ids: string[]) {
    for (const id of ids) {
      const reservation = await this.db.collection<Reservation>("reservations").findOne({ id });
      if (!reservation || reservation.state !== "active") continue;
      await this.db.collection("balances").updateOne(
        { variantId: reservation.variantId },
        { $inc: { reserved: -reservation.qty, availableToSell: reservation.qty, version: 1 } },
      );
      await this.db.collection("reservations").updateOne({ id }, { $set: { state: "released" } });
    }
  }

  private async reloadInventory() {
    const snapshot = this.inner.exportSnapshot();
    snapshot.balances = (await this.db.collection("balances").find({}, { projection: { _id: 0 } }).toArray()) as unknown as Snapshot["balances"];
    snapshot.reservations = (await this.db.collection("reservations").find({}, { projection: { _id: 0 } }).toArray()) as unknown as Snapshot["reservations"];
    this.inner = MemoryStore.fromSnapshot(snapshot);
  }

  async commitReservations(ids: string[], reference: string, actorId: string) {
    await this.inner.commitReservations(ids, reference, actorId);
    await this.persistInventory();
  }

  async releaseReservations(ids: string[], reason: string, actorId: string) {
    await this.inner.releaseReservations(ids, reason, actorId);
    await this.persistInventory();
  }

  async adjustInventory(input: { variantId: string; deltaOnHand: number; reason: string; actorId: string }) {
    const balance = await this.inner.adjustInventory(input);
    await this.persistInventory();
    return balance;
  }

  listMovements() {
    return this.inner.listMovements();
  }

  listReservations() {
    return this.inner.listReservations();
  }

  getCart(id: string) {
    return this.inner.getCart(id);
  }

  async saveCart(cart: Snapshot["carts"][number]) {
    await this.inner.saveCart(cart);
    await this.upsert("carts", cart.id, cart);
  }

  async deleteCart(id: string) {
    await this.inner.deleteCart(id);
    await this.db.collection("carts").deleteOne({ id });
  }

  findCustomerByEmail(email: string) {
    return this.inner.findCustomerByEmail(email);
  }

  getCustomer(id: string) {
    return this.inner.getCustomer(id);
  }

  async saveCustomer(customer: Snapshot["customers"][number]) {
    await this.inner.saveCustomer(customer);
    await this.upsert("customers", customer.id, customer);
  }

  listCustomers() {
    return this.inner.listCustomers();
  }

  findStaffByEmail(email: string) {
    return this.inner.findStaffByEmail(email);
  }

  getStaff(id: string) {
    return this.inner.getStaff(id);
  }

  listOrders() {
    return this.inner.listOrders();
  }

  getOrderByNumber(orderNumber: string) {
    return this.inner.getOrderByNumber(orderNumber);
  }

  async saveOrder(order: Snapshot["orders"][number]) {
    await this.inner.saveOrder(order);
    await this.upsert("orders", order.id, order);
  }

  findOrderByIdempotency(key: string) {
    return this.inner.findOrderByIdempotency(key);
  }

  listReviews(productId: string) {
    return this.inner.listReviews(productId);
  }

  async saveReview(review: Snapshot["reviews"][number]) {
    await this.inner.saveReview(review);
    await this.upsert("reviews", review.id, review);
  }

  listReturns() {
    return this.inner.listReturns();
  }

  async saveReturn(item: Snapshot["returns"][number]) {
    await this.inner.saveReturn(item);
    await this.upsert("returns", item.id, item);
  }

  listAudit() {
    return this.inner.listAudit();
  }

  async addAudit(entry: Snapshot["audit"][number]) {
    await this.inner.addAudit(entry);
    await this.upsert("audit", entry.id, entry);
  }

  listSynonyms() {
    return this.inner.listSynonyms();
  }

  async saveSynonym(set: Snapshot["synonyms"][number]) {
    await this.inner.saveSynonym(set);
    await this.upsert("synonyms", set.id, set);
  }

  listBackInStock() {
    return this.inner.listBackInStock();
  }

  async saveBackInStock(request: Snapshot["backInStock"][number]) {
    await this.inner.saveBackInStock(request);
    await this.upsert("backInStock", request.id, request);
  }

  async saveConversation(conversation: Snapshot["conversations"][number]) {
    await this.inner.saveConversation(conversation);
    await this.upsert("conversations", conversation.id, conversation);
  }

  getConversation(id: string) {
    return this.inner.getConversation(id);
  }

  getIdempotency(scope: string, key: string) {
    return this.inner.getIdempotency(scope, key);
  }

  async putIdempotency(scope: string, key: string, value: unknown) {
    await this.inner.putIdempotency(scope, key, value);
    await this.upsert("idempotency", `${scope}:${key}`, { id: `${scope}:${key}`, scope, key, value });
  }

  async markWebhook(provider: string, eventId: string) {
    const id = `${provider}:${eventId}`;
    try {
      await this.db.collection("webhooks").insertOne({ id, provider, eventId });
      return "new" as const;
    } catch {
      return "duplicate" as const;
    }
  }

  exportSnapshot() {
    return this.inner.exportSnapshot();
  }

  private async persistInventory() {
    for (const balance of await this.inner.getBalances()) await this.upsert("balances", balance.id, balance);
    for (const reservation of await this.inner.listReservations()) await this.upsert("reservations", reservation.id, reservation);
    const movements = await this.inner.listMovements();
    const recent = movements.slice(-20);
    for (const movement of recent) await this.upsert("movements", movement.id, movement);
  }
}
