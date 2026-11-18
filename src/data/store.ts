import type {
  AuditEntry,
  BackInStockRequest,
  Balance,
  Cart,
  Conversation,
  Customer,
  Movement,
  Order,
  Product,
  Reservation,
  ReturnIntent,
  Review,
  Snapshot,
  Staff,
  SynonymSet,
} from "../domain/types";

export interface ReserveResult {
  ok: true;
  reservationIds: string[];
}

export interface ReserveFailure {
  ok: false;
  variantId: string;
  available: number;
}

export interface CommerceStore {
  readonly mode: "memory" | "mongodb";
  releaseExpired(now?: number): Promise<number>;
  listProducts(): Promise<Product[]>;
  saveProduct(product: Product): Promise<void>;
  getBalances(): Promise<Balance[]>;
  reserve(
    lines: { variantId: string; quantity: number }[],
    ownerId: string,
  ): Promise<ReserveResult | ReserveFailure>;
  commitReservations(ids: string[], reference: string, actorId: string): Promise<void>;
  releaseReservations(ids: string[], reason: string, actorId: string): Promise<void>;
  adjustInventory(input: {
    variantId: string;
    deltaOnHand: number;
    reason: string;
    actorId: string;
  }): Promise<Balance>;
  listMovements(): Promise<Movement[]>;
  listReservations(): Promise<Reservation[]>;
  getCart(id: string): Promise<Cart | null>;
  saveCart(cart: Cart): Promise<void>;
  deleteCart(id: string): Promise<void>;
  findCustomerByEmail(email: string): Promise<Customer | null>;
  getCustomer(id: string): Promise<Customer | null>;
  saveCustomer(customer: Customer): Promise<void>;
  listCustomers(): Promise<Customer[]>;
  findStaffByEmail(email: string): Promise<Staff | null>;
  getStaff(id: string): Promise<Staff | null>;
  listOrders(): Promise<Order[]>;
  getOrderByNumber(orderNumber: string): Promise<Order | null>;
  saveOrder(order: Order): Promise<void>;
  findOrderByIdempotency(key: string): Promise<Order | null>;
  listReviews(productId: string): Promise<Review[]>;
  saveReview(review: Review): Promise<void>;
  listReturns(): Promise<ReturnIntent[]>;
  saveReturn(item: ReturnIntent): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  addAudit(entry: AuditEntry): Promise<void>;
  listSynonyms(): Promise<SynonymSet[]>;
  saveSynonym(set: SynonymSet): Promise<void>;
  listBackInStock(): Promise<BackInStockRequest[]>;
  saveBackInStock(request: BackInStockRequest): Promise<void>;
  saveConversation(conversation: Conversation): Promise<void>;
  getConversation(id: string): Promise<Conversation | null>;
  getIdempotency(scope: string, key: string): Promise<unknown | null>;
  putIdempotency(scope: string, key: string, value: unknown): Promise<void>;
  markWebhook(provider: string, eventId: string): Promise<"new" | "duplicate">;
  exportSnapshot(): Snapshot;
}
