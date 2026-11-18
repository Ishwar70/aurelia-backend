import type { OrderState } from "./types";

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["fulfilling", "cancelled"],
  fulfilling: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function customerMayCancel(state: OrderState): boolean {
  return state === "pending_payment" || state === "confirmed";
}

export interface ReturnDecision {
  eligible: boolean;
  reason: string;
}

export function returnEligibility(input: {
  orderState: OrderState;
  deliveredAt: string | null;
  categorySlug: string;
  now: number;
  windowDays?: number;
}): ReturnDecision {
  if (input.categorySlug === "jewelry") {
    return { eligible: false, reason: "Jewelry is final sale and cannot be returned." };
  }
  if (input.orderState !== "delivered" || !input.deliveredAt) {
    return { eligible: false, reason: "A return can start only after the order is delivered." };
  }
  const windowMs = (input.windowDays ?? 15) * 24 * 60 * 60 * 1000;
  if (input.now - Date.parse(input.deliveredAt) > windowMs) {
    return { eligible: false, reason: "The 15-day return window has closed for this delivery." };
  }
  return { eligible: true, reason: "Eligible for return if unworn, with tags attached." };
}
