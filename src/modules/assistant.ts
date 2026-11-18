import { formatInr, unitPriceMinor } from "../domain/money";
import { returnEligibility } from "../domain/orders";
import { searchCatalog } from "../domain/search";
import { signValue, unsignValue } from "../domain/session";
import { createId, returnNumber } from "../domain/ids";
import { STORE_ID, type Customer, type Order, type Product } from "../domain/types";
import type { CommerceStore } from "../data/store";
import { availabilityMap, toCard } from "./catalog";
import { POLICIES } from "../data/content";

export interface AssistantCard {
  slug: string;
  name: string;
  priceMinor: number;
  currency: "INR";
  image: string | null;
  reason: string;
}

export interface AssistantResponse {
  message: string;
  cards?: AssistantCard[];
  citations?: { label: string; sourceId: string }[];
  followUps?: string[];
  action?: { type: "confirm_return" | "handoff"; token: string; summary: string };
  confidence: "high" | "medium" | "low";
}

const INJECTION = /ignore (all |previous |the )?(policy|instructions|rules)|system prompt|reveal (the )?(secret|password|key)|card number|cvv|one[- ]time password/i;

function knowledge() {
  return POLICIES.flatMap((policy) =>
    policy.sections.map((section) => ({
      id: `${policy.slug}:${section.heading}`,
      title: `${policy.title}: ${section.heading}`,
      sourceId: policy.slug,
      text: section.body,
    })),
  );
}

function retrieve(query: string) {
  const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
  return knowledge()
    .map((chunk) => ({
      chunk,
      score: words.reduce((sum, word) => sum + (chunk.text.toLowerCase().includes(word) ? 1 : 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

function cardsFor(products: Product[], available: Map<string, number>, reason: string): AssistantCard[] {
  return products.slice(0, 4).map((product) => {
    const card = toCard(product, available);
    return {
      slug: product.slug,
      name: product.name,
      priceMinor: card.priceMinor,
      currency: "INR" as const,
      image: card.image,
      reason,
    };
  });
}

function budgetMinor(message: string): number | null {
  const match = message.match(/(?:under|below|budget)\s*₹?\s*([\d,]+)/i) ?? message.match(/₹\s*([\d,]+)/);
  if (!match?.[1]) return null;
  return Number(match[1].replace(/,/g, "")) * 100;
}

async function findOrder(store: CommerceStore, message: string, customer: Customer | null): Promise<Order | null> {
  const match = message.toUpperCase().match(/AU-[A-Z0-9]+/);
  if (match?.[0]) return store.getOrderByNumber(match[0]);
  if (!customer) return null;
  const orders = await store.listOrders();
  return orders.find((order) => order.customerId === customer.id || order.email === customer.emailNormalized) ?? null;
}

export async function answerAssistant(
  store: CommerceStore,
  input: { message: string; customer: Customer | null; confirmToken?: string },
): Promise<AssistantResponse> {
  const message = input.message.trim();
  if (input.confirmToken) {
    const raw = unsignValue(input.confirmToken);
    if (!raw) {
      return { message: "That confirmation expired. Ask again and I will recheck the order.", confidence: "low", followUps: ["Can I return my order?"] };
    }
    const payload = JSON.parse(raw) as { orderNumber: string; lineId: string; exp: number };
    if (payload.exp < Date.now()) {
      return { message: "That confirmation expired. Ask again and I will recheck the order.", confidence: "low" };
    }
    const order = await store.getOrderByNumber(payload.orderNumber);
    const line = order?.lines.find((item) => item.lineId === payload.lineId);
    if (!order || !line) return { message: "I could not find that item anymore.", confidence: "low" };
    const allowed = input.customer && (order.customerId === input.customer.id || order.email === input.customer.emailNormalized);
    if (!allowed) {
      return { message: "Sign in with the email on the order before I start a return.", confidence: "medium", followUps: ["Where is my order?"] };
    }
    const created = {
      id: createId("ret"),
      storeId: STORE_ID,
      returnNumber: returnNumber(),
      orderNumber: order.orderNumber,
      email: order.email,
      lineId: line.lineId,
      reason: "Requested in the assistant after explicit confirmation",
      state: "requested" as const,
      createdAt: new Date().toISOString(),
    };
    await store.saveReturn(created);
    await store.addAudit({
      id: createId("aud"),
      storeId: STORE_ID,
      actorId: input.customer?.id ?? order.email,
      action: "return.requested",
      entity: created.returnNumber,
      summary: `Return requested for ${order.orderNumber}`,
      createdAt: created.createdAt,
    });
    return {
      message: `Return ${created.returnNumber} is requested for ${line.nameSnapshot}. Nothing is refunded until the team inspects the piece.`,
      confidence: "high",
    };
  }

  if (INJECTION.test(message)) {
    return {
      message: "I can help with the catalog, policies, and your orders. I will not ignore those rules or share secrets, card details, or passwords.",
      confidence: "low",
      followUps: ["What is the return window?", "Show me wedding guest dresses"],
      action: { type: "handoff", token: signValue(JSON.stringify({ exp: Date.now() + 10 * 60 * 1000 })), summary: "A person can take this from here." },
    };
  }

  const products = (await store.listProducts()).filter((product) => product.status === "active");
  const available = availabilityMap(await store.getBalances());
  const lower = message.toLowerCase();

  if (/(return|refund)/.test(lower)) {
    const order = await findOrder(store, message, input.customer);
    if (!order) {
      return {
        message: "I can check a return once I can see the order. Sign in, or include the order number that starts with AU-.",
        confidence: "medium",
        citations: [{ label: "Returns", sourceId: "returns" }],
        followUps: ["What is the return window?"],
      };
    }
    const line = order.lines[0];
    if (!line) return { message: "That order has no items to return.", confidence: "high" };
    const product = products.find((item) => item.id === line.productId);
    const delivered = order.timeline.find((event) => event.type === "delivered");
    const decision = returnEligibility({
      orderState: order.state,
      deliveredAt: delivered?.at ?? null,
      categorySlug: product?.categorySlug ?? "",
      now: Date.now(),
    });
    if (!decision.eligible) {
      return {
        message: `${order.orderNumber}: ${decision.reason}`,
        confidence: "high",
        citations: [{ label: "Returns", sourceId: "returns" }],
      };
    }
    const token = signValue(JSON.stringify({ orderNumber: order.orderNumber, lineId: line.lineId, exp: Date.now() + 10 * 60 * 1000 }));
    return {
      message: `${line.nameSnapshot} from ${order.orderNumber} can be returned. Confirm and I will open the request. The refund is not issued until inspection.`,
      confidence: "high",
      citations: [{ label: "Returns", sourceId: "returns" }],
      action: { type: "confirm_return", token, summary: `Request a return for ${line.nameSnapshot}` },
    };
  }

  if (/(where is my order|order status|track|shipment)/.test(lower) || /AU-\w+/.test(message.toUpperCase())) {
    const order = await findOrder(store, message, input.customer);
    if (!order) {
      return { message: "I could not find that order for this account. Check the number or sign in with the same email.", confidence: "medium" };
    }
    const allowed = input.customer && (order.customerId === input.customer.id || order.email === input.customer.emailNormalized);
    if (!allowed) {
      return { message: "Sign in with the email on the order before I share its status.", confidence: "medium" };
    }
    return {
      message: `${order.orderNumber} is ${order.state.replaceAll("_", " ")} and payment is ${order.paymentState.replaceAll("_", " ")}.`,
      confidence: "high",
      followUps: ["Can I return this?"],
    };
  }

  if (/(shipping|delivery|return policy|gst|guest checkout|payment final|privacy|how long)/.test(lower)) {
    const hits = retrieve(message);
    if (hits.length === 0) {
      return {
        message: "I am not sure from the approved policies. You can read shipping and returns, or I can hand this to client care.",
        confidence: "low",
        followUps: ["Shipping policy", "Returns policy"],
        action: { type: "handoff", token: signValue("{}"), summary: "Talk to client care" },
      };
    }
    const top = hits[0];
    return {
      message: top ? top.chunk.text : "I could not find an approved answer.",
      confidence: "high",
      citations: hits.map((hit) => ({ label: hit.chunk.title, sourceId: hit.chunk.sourceId })),
    };
  }

  const mentioned = products.filter((product) => lower.includes(product.name.toLowerCase()));
  if (lower.includes("compare") && mentioned.length >= 2) {
    const lines = mentioned.slice(0, 3).map((product) => {
      const price = formatInr(unitPriceMinor(product.variants[0]?.pricing ?? { listMinor: 0, saleMinor: null }));
      return `${product.name}: ${price}, ${product.attributes.material ?? "material listed on the product"}`;
    });
    return {
      message: lines.join(". ") + ".",
      cards: cardsFor(mentioned, available, "Live catalog comparison"),
      confidence: "high",
    };
  }

  const budget = budgetMinor(message);
  const occasion = /wedding|ceremony|festive/.test(lower) ? "wedding guest" : /office|work/.test(lower) ? "office" : /evening|dinner/.test(lower) ? "evening" : null;
  if (occasion || /look|outfit|style|wear/.test(lower)) {
    const hits = searchCatalog(products, await store.listSynonyms(), {
      q: occasion ?? message,
      availability: available,
      sort: "relevance",
    }).map((hit) => hit.product);
    const filtered = hits.filter((product) => (budget == null ? true : toCard(product, available).priceMinor <= budget)).slice(0, 3);
    const chosen = filtered.length ? filtered : hits.slice(0, 3);
    if (chosen.length === 0) {
      return { message: "I could not find pieces for that brief. Try a category or a colour.", confidence: "low" };
    }
    const reason = budget ? `Within ${formatInr(budget)}` : "Selected from the live catalog";
    return {
      message: `Here is a small edit${occasion ? ` for ${occasion}` : ""}. Prices and stock are live.`,
      cards: cardsFor(chosen, available, reason),
      confidence: "high",
      followUps: ["Compare the first two", "Show something under ₹10,000"],
    };
  }

  const hits = searchCatalog(products, await store.listSynonyms(), { q: message, availability: available, sort: "relevance" });
  if (hits.length === 0) {
    return {
      message: "Nothing in the catalog matches that. Try a colour, a category, or an occasion.",
      confidence: "low",
      followUps: ["Wedding guest dresses", "Office tailoring"],
    };
  }
  return {
    message: `I found ${hits.length} ${hits.length === 1 ? "piece" : "pieces"}. These prices come from the catalog, not from me.`,
    cards: cardsFor(hits.map((hit) => hit.product), available, "Catalog search"),
    confidence: hits[0] && hits[0].score >= 10 ? "high" : "medium",
  };
}
