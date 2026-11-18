export const STORE_ID = "store_aurelia";
export const POLICY_VERSION = "2026-11-18";
export const WAREHOUSE_ID = "wh_mumbai";

export type Department = "women" | "men" | "kids" | "accessories";
export type ProductStatus = "draft" | "active" | "archived";
export type OrderState =
  | "pending_payment"
  | "confirmed"
  | "fulfilling"
  | "shipped"
  | "delivered"
  | "cancelled";
export type PaymentState =
  | "unpaid"
  | "pending"
  | "paid"
  | "partially_refunded"
  | "refunded"
  | "failed";
export type FulfilmentState = "unfulfilled" | "partial" | "fulfilled" | "returned";
export type ReservationState = "active" | "converted" | "released" | "expired";
export type StaffRole =
  | "super_admin"
  | "catalog_manager"
  | "order_operator"
  | "support"
  | "analyst";

export interface Media {
  url: string;
  alt: string;
}

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  options: { name: string; label: string }[];
  colorFamily: string;
  colorHex: string;
  pricing: { currency: "INR"; listMinor: number; saleMinor: number | null };
  status: "active" | "archived";
}

export interface Product {
  id: string;
  storeId: string;
  schemaVersion: 1;
  status: ProductStatus;
  name: string;
  slug: string;
  brand: string;
  department: Department;
  category: string;
  categorySlug: string;
  subcategory: string;
  description: { short: string; details: string };
  attributes: { material?: string; fit?: string; occasion?: string[]; care?: string[] };
  seo: { title: string; description: string };
  media: Media[];
  tags: string[];
  rating: { average: number; count: number };
  sizeGuide: string;
  collectionIds: string[];
  variants: Variant[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface Balance {
  id: string;
  storeId: string;
  variantId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  safetyStock: number;
  availableToSell: number;
  version: number;
}

export interface Movement {
  id: string;
  storeId: string;
  variantId: string;
  deltaOnHand: number;
  deltaReserved: number;
  reason: string;
  reference: string;
  actorId: string;
  createdAt: string;
}

export interface Reservation {
  id: string;
  storeId: string;
  variantId: string;
  warehouseId: string;
  qty: number;
  state: ReservationState;
  ownerId: string;
  expiresAt: string;
  createdAt: string;
}

export interface CartLine {
  lineId: string;
  variantId: string;
  quantity: number;
  quotedUnitPriceMinor: number;
}

export interface Cart {
  id: string;
  storeId: string;
  customerId: string | null;
  lines: CartLine[];
  couponCode: string | null;
  updatedAt: string;
}

export interface Address {
  id: string;
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: "IN";
}

export interface Customer {
  id: string;
  storeId: string;
  email: string;
  emailNormalized: string;
  name: string;
  passwordHash: string;
  phone: string | null;
  addresses: Address[];
  wishlist: { productId: string; addedAt: string }[];
  consent: { marketing: boolean; updatedAt: string; version: string };
  createdAt: string;
}

export interface Staff {
  id: string;
  storeId: string;
  email: string;
  name: string;
  passwordHash: string;
  role: StaffRole;
  mfaEnrolled: boolean;
  refundLimitMinor: number;
  active: boolean;
}

export interface OrderLine {
  lineId: string;
  productId: string;
  variantId: string;
  sku: string;
  nameSnapshot: string;
  optionSnapshot: string;
  imageSnapshot: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface OrderAmounts {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  currency: "INR";
}

export interface Order {
  id: string;
  storeId: string;
  orderNumber: string;
  customerId: string | null;
  email: string;
  phone: string;
  state: OrderState;
  paymentState: PaymentState;
  fulfilmentState: FulfilmentState;
  lines: OrderLine[];
  amounts: OrderAmounts;
  shippingAddressSnapshot: Address;
  shippingMethod: { id: string; label: string; eta: string };
  promotionSnapshots: { code: string; label: string; amountMinor: number }[];
  inventoryReservationIds: string[];
  timeline: { at: string; type: string; actorRef: string; note: string }[];
  risk: "low" | "review";
  exception: string | null;
  idempotencyKey: string;
  policyVersion: string;
  invoice: { number: string; taxMinor: number; hash: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReturnIntent {
  id: string;
  storeId: string;
  returnNumber: string;
  orderNumber: string;
  email: string;
  lineId: string;
  reason: string;
  state: "requested" | "approved" | "received" | "rejected";
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  storeId: string;
  actorId: string;
  action: string;
  entity: string;
  summary: string;
  createdAt: string;
}

export interface Review {
  id: string;
  productId: string;
  author: string;
  rating: number;
  title: string;
  body: string;
  status: "approved" | "pending";
  createdAt: string;
}

export interface KnowledgeChunk {
  id: string;
  title: string;
  sourceId: string;
  text: string;
}

export interface Conversation {
  id: string;
  customerId: string | null;
  messages: { role: "user" | "assistant"; content: string; at: string }[];
  updatedAt: string;
}

export interface SynonymSet {
  id: string;
  terms: string[];
}

export interface BackInStockRequest {
  id: string;
  email: string;
  variantId: string;
  createdAt: string;
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  value: unknown;
}

export interface WebhookRecord {
  id: string;
  provider: string;
  eventId: string;
}

export interface Snapshot {
  products: Product[];
  balances: Balance[];
  movements: Movement[];
  reservations: Reservation[];
  carts: Cart[];
  customers: Customer[];
  staff: Staff[];
  orders: Order[];
  reviews: Review[];
  returns: ReturnIntent[];
  audit: AuditEntry[];
  synonyms: SynonymSet[];
  backInStock: BackInStockRequest[];
  conversations: Conversation[];
  idempotency: IdempotencyRecord[];
  webhooks: WebhookRecord[];
}
