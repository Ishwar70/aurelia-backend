import { hashPassword } from "../domain/password";
import { createId } from "../domain/ids";
import { STORE_ID, WAREHOUSE_ID, type Address, type Balance, type Order, type Product, type Snapshot } from "../domain/types";
import { buildProducts } from "./catalog";
import { DEFAULT_SYNONYMS } from "./content";

const DEMO_CUSTOMER_PASSWORD = "AureliaShopper!1";
const DEMO_ADMIN_PASSWORD = "AureliaAdmin!1";
const DEMO_OPS_PASSWORD = "AureliaOps!1";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function findVariant(products: Product[], slug: string, color: string, size: string) {
  const product = products.find((item) => item.slug === slug);
  if (!product) throw new Error(`Missing product ${slug}`);
  const variant = product.variants.find(
    (item) => item.options.some((option) => option.label === color) && item.options.some((option) => option.label === size),
  );
  if (!variant) throw new Error(`Missing variant ${slug} ${color} ${size}`);
  return { product, variant };
}

function openingBalance(variantId: string, onHand: number): Balance {
  return {
    id: `bal_${variantId}`,
    storeId: STORE_ID,
    variantId,
    warehouseId: WAREHOUSE_ID,
    onHand,
    reserved: 0,
    safetyStock: 0,
    availableToSell: onHand,
    version: 1,
  };
}

export function buildSeed(): Snapshot {
  const products = buildProducts();
  const balances = new Map<string, Balance>();
  for (const product of products) {
    for (const variant of product.variants) balances.set(variant.id, openingBalance(variant.id, 10));
  }

  const setAvailable = (variantId: string, available: number) => {
    const current = balances.get(variantId);
    if (!current) return;
    current.onHand = available + current.reserved + current.safetyStock;
    current.availableToSell = available;
  };

  const miraAddress: Address = {
    id: "addr_mira",
    fullName: "Mira Sen",
    phone: "9876543210",
    line1: "14 Kala Ghoda",
    city: "Mumbai",
    region: "Maharashtra",
    postalCode: "400001",
    country: "IN",
  };

  const customers = [
    {
      id: "cust_mira",
      storeId: STORE_ID,
      email: "mira@aurelia.test",
      emailNormalized: "mira@aurelia.test",
      name: "Mira Sen",
      passwordHash: hashPassword(DEMO_CUSTOMER_PASSWORD),
      phone: "9876543210",
      addresses: [miraAddress],
      wishlist: [
        { productId: "prd_wool_blazer", addedAt: daysAgo(4) },
        { productId: "prd_silk_scarf", addedAt: daysAgo(1) },
      ],
      consent: { marketing: true, updatedAt: daysAgo(20), version: "2026-11-18" },
      createdAt: daysAgo(40),
    },
  ];

  const staff = [
    {
      id: "staff_admin",
      storeId: STORE_ID,
      email: "admin@aurelia.test",
      name: "Aurelia Admin",
      passwordHash: hashPassword(DEMO_ADMIN_PASSWORD),
      role: "super_admin" as const,
      mfaEnrolled: true,
      refundLimitMinor: 10_000_000,
      active: true,
    },
    {
      id: "staff_ops",
      storeId: STORE_ID,
      email: "ops@aurelia.test",
      name: "Order Operator",
      passwordHash: hashPassword(DEMO_OPS_PASSWORD),
      role: "order_operator" as const,
      mfaEnrolled: true,
      refundLimitMinor: 500_000,
      active: true,
    },
  ];

  const dress = findVariant(products, "silk-column-dress", "Ivory", "S");
  const trouser = findVariant(products, "pleated-trouser", "Ink", "32");
  const oxford = findVariant(products, "oxford-shirt", "Ivory", "M");
  const hoops = findVariant(products, "sculptural-hoops", "Gold", "One size");
  const coat = findVariant(products, "wool-overcoat", "Camel", "M");

  const line = (
    product: Product,
    variantId: string,
    sku: string,
    name: string,
    option: string,
    image: string,
    unit: number,
    qty = 1,
  ) => ({
    lineId: createId("ln"),
    productId: product.id,
    variantId,
    sku,
    nameSnapshot: name,
    optionSnapshot: option,
    imageSnapshot: image,
    quantity: qty,
    unitPriceMinor: unit,
    discountMinor: 0,
    taxMinor: 0,
    totalMinor: unit * qty,
  });

  const baseOrder = (partial: Pick<Order, "orderNumber" | "state" | "paymentState" | "fulfilmentState" | "lines" | "createdAt"> & Partial<Order>): Order => {
    const subtotal = partial.lines.reduce((sum, item) => sum + item.totalMinor, 0);
    return {
      id: `ord_${partial.orderNumber.toLowerCase()}`,
      storeId: STORE_ID,
      customerId: "cust_mira",
      email: "mira@aurelia.test",
      phone: "9876543210",
      amounts: {
        subtotalMinor: subtotal,
        discountMinor: 0,
        shippingMinor: 0,
        taxMinor: Math.round((subtotal * 18) / 118),
        grandTotalMinor: subtotal,
        currency: "INR",
      },
      shippingAddressSnapshot: miraAddress,
      shippingMethod: { id: "standard", label: "Standard delivery", eta: "5–7 days" },
      promotionSnapshots: [],
      inventoryReservationIds: [],
      timeline: [{ at: partial.createdAt, type: partial.state, actorRef: "seed", note: "Opening history" }],
      risk: "low",
      exception: null,
      idempotencyKey: `seed_${partial.orderNumber}`,
      policyVersion: "2026-11-18",
      invoice: partial.paymentState === "paid" ? { number: `INV-${partial.orderNumber}`, taxMinor: Math.round((subtotal * 18) / 118), hash: "seed" } : null,
      updatedAt: partial.createdAt,
      ...partial,
    };
  };

  const orders: Order[] = [
    baseOrder({
      orderNumber: "AU-2600A",
      state: "delivered",
      paymentState: "paid",
      fulfilmentState: "fulfilled",
      createdAt: daysAgo(6),
      lines: [
        line(dress.product, dress.variant.id, dress.variant.sku, dress.product.name, "Ivory / S", dress.product.media[0]?.url ?? "", dress.variant.pricing.saleMinor ?? dress.variant.pricing.listMinor),
      ],
      timeline: [
        { at: daysAgo(6), type: "confirmed", actorRef: "seed", note: "Paid" },
        { at: daysAgo(2), type: "delivered", actorRef: "seed", note: "Delivered in Mumbai" },
      ],
    }),
    baseOrder({
      orderNumber: "AU-2600B",
      state: "shipped",
      paymentState: "paid",
      fulfilmentState: "fulfilled",
      createdAt: daysAgo(3),
      lines: [line(coat.product, coat.variant.id, coat.variant.sku, coat.product.name, "Camel / M", coat.product.media[0]?.url ?? "", coat.variant.pricing.listMinor)],
    }),
    baseOrder({
      orderNumber: "AU-2600C",
      state: "fulfilling",
      paymentState: "paid",
      fulfilmentState: "unfulfilled",
      createdAt: daysAgo(1),
      lines: [line(trouser.product, trouser.variant.id, trouser.variant.sku, trouser.product.name, "Ink / 32", trouser.product.media[0]?.url ?? "", trouser.variant.pricing.listMinor)],
    }),
    baseOrder({
      orderNumber: "AU-2600D",
      state: "pending_payment",
      paymentState: "pending",
      fulfilmentState: "unfulfilled",
      createdAt: daysAgo(2),
      exception: "stale_pending",
      lines: [line(oxford.product, oxford.variant.id, oxford.variant.sku, oxford.product.name, "Ivory / M", oxford.product.media[0]?.url ?? "", oxford.variant.pricing.listMinor)],
      inventoryReservationIds: ["rsv_seed_oxford"],
    }),
    baseOrder({
      orderNumber: "AU-2600E",
      state: "cancelled",
      paymentState: "refunded",
      fulfilmentState: "unfulfilled",
      createdAt: daysAgo(9),
      lines: [line(trouser.product, trouser.variant.id, trouser.variant.sku, trouser.product.name, "Ink / 32", trouser.product.media[0]?.url ?? "", trouser.variant.pricing.listMinor)],
    }),
    baseOrder({
      orderNumber: "AU-2600F",
      state: "delivered",
      paymentState: "paid",
      fulfilmentState: "fulfilled",
      createdAt: daysAgo(4),
      lines: [line(hoops.product, hoops.variant.id, hoops.variant.sku, hoops.product.name, "Gold / One size", hoops.product.media[0]?.url ?? "", hoops.variant.pricing.listMinor)],
      timeline: [
        { at: daysAgo(4), type: "confirmed", actorRef: "seed", note: "Paid" },
        { at: daysAgo(1), type: "delivered", actorRef: "seed", note: "Delivered" },
      ],
    }),
  ];

  const oxfordBalance = balances.get(oxford.variant.id);
  if (oxfordBalance) {
    oxfordBalance.reserved = 1;
    oxfordBalance.availableToSell = oxfordBalance.onHand - oxfordBalance.reserved;
  }

  const cashmere = findVariant(products, "cashmere-crew", "Camel", "M");
  setAvailable(cashmere.variant.id, 1);
  setAvailable(hoops.variant.id, 0);

  const reviews = [
    {
      id: "rev_1",
      productId: dress.product.id,
      author: "A. Kapoor",
      rating: 5,
      title: "The length is right",
      body: "Wore it to a nikah and did not think about the hem once.",
      status: "approved" as const,
      createdAt: daysAgo(8),
    },
    {
      id: "rev_2",
      productId: dress.product.id,
      author: "R. Iyer",
      rating: 4,
      title: "Silk has a dry hand",
      body: "Not shiny. Size S matched the guide.",
      status: "approved" as const,
      createdAt: daysAgo(3),
    },
  ];

  return {
    products,
    balances: [...balances.values()],
    movements: [
      {
        id: "mov_opening",
        storeId: STORE_ID,
        variantId: cashmere.variant.id,
        deltaOnHand: 1,
        deltaReserved: 0,
        reason: "opening_balance",
        reference: "seed",
        actorId: "staff_seed",
        createdAt: daysAgo(1),
      },
    ],
    reservations: [
      {
        id: "rsv_seed_oxford",
        storeId: STORE_ID,
        variantId: oxford.variant.id,
        warehouseId: WAREHOUSE_ID,
        qty: 1,
        state: "active",
        ownerId: "ord_au-2600d",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: daysAgo(2),
      },
    ],
    carts: [],
    customers,
    staff,
    orders,
    reviews,
    returns: [],
    audit: [
      {
        id: "aud_seed",
        storeId: STORE_ID,
        actorId: "staff_seed",
        action: "store.seeded",
        entity: "store",
        summary: "Opened the store with the launch catalog.",
        createdAt: new Date().toISOString(),
      },
    ],
    synonyms: DEFAULT_SYNONYMS,
    backInStock: [],
    conversations: [],
    idempotency: [],
    webhooks: [],
  };
}
