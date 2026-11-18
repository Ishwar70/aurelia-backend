import { includedGstMinor } from "./money";

export const FREE_SHIPPING_THRESHOLD_MINOR = 500_000;
export const STANDARD_SHIPPING_MINOR = 9_900;
export const EXPRESS_SHIPPING_MINOR = 19_900;

export interface CouponResult {
  code: string | null;
  label: string | null;
  discountMinor: number;
  error: string | null;
}

export function evaluateCoupon(subtotalMinor: number, code: string | null): CouponResult {
  if (!code) return { code: null, label: null, discountMinor: 0, error: null };
  const normalized = code.trim().toUpperCase();
  if (normalized === "AURELIA10") {
    const raw = Math.floor(subtotalMinor * 0.1);
    const discountMinor = Math.min(raw, 200_000);
    return { code: normalized, label: "10% off, capped at ₹2,000", discountMinor, error: null };
  }
  if (normalized === "WELCOME500") {
    if (subtotalMinor < 300_000) {
      return {
        code: normalized,
        label: null,
        discountMinor: 0,
        error: "WELCOME500 applies on orders of ₹3,000 or more.",
      };
    }
    return { code: normalized, label: "₹500 welcome offer", discountMinor: 50_000, error: null };
  }
  return { code: normalized, label: null, discountMinor: 0, error: "This code is not active." };
}

export interface ShippingMethod {
  id: "standard" | "express";
  label: string;
  eta: string;
  priceMinor: number;
  available: boolean;
  reason: string | null;
}

export function shippingMethods(subtotalAfterDiscount: number, postalCode: string | null): ShippingMethod[] {
  const standardPrice = subtotalAfterDiscount >= FREE_SHIPPING_THRESHOLD_MINOR ? 0 : STANDARD_SHIPPING_MINOR;
  const expressBlocked = postalCode?.startsWith("9") ?? false;
  return [
    {
      id: "standard",
      label: "Standard delivery",
      eta: "5–7 days",
      priceMinor: standardPrice,
      available: true,
      reason: standardPrice === 0 ? "Complimentary above ₹5,000" : null,
    },
    {
      id: "express",
      label: "Express delivery",
      eta: "2–3 days",
      priceMinor: EXPRESS_SHIPPING_MINOR,
      available: !expressBlocked,
      reason: expressBlocked ? "Express is not available for this PIN code." : null,
    },
  ];
}

export function quoteTotals(input: {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
}) {
  const grandTotalMinor = Math.max(0, input.subtotalMinor - input.discountMinor + input.shippingMinor);
  return {
    subtotalMinor: input.subtotalMinor,
    discountMinor: input.discountMinor,
    shippingMinor: input.shippingMinor,
    taxMinor: includedGstMinor(grandTotalMinor),
    grandTotalMinor,
    currency: "INR" as const,
  };
}
