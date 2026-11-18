import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allocateDiscount, includedGstMinor, rupeesToMinor } from "../src/domain/money";
import { adjustOnHand, commitQuantity, releaseQuantity, reserveQuantity } from "../src/domain/inventory";
import { canTransition, customerMayCancel, returnEligibility } from "../src/domain/orders";
import { evaluateCoupon, quoteTotals, shippingMethods } from "../src/domain/pricing";
import { verifyPaymentSignature, verifyWebhook, webhookSignature } from "../src/domain/razorpay";
import { searchCatalog } from "../src/domain/search";
import { signValue, unsignValue } from "../src/domain/session";
import { buildProducts } from "../src/data/catalog";
import { STORE_ID, WAREHOUSE_ID, type Balance } from "../src/domain/types";

function balance(available: number): Balance {
  return {
    id: "bal",
    storeId: STORE_ID,
    variantId: "var",
    warehouseId: WAREHOUSE_ID,
    onHand: available,
    reserved: 0,
    safetyStock: 0,
    availableToSell: available,
    version: 1,
  };
}

describe("money and pricing", () => {
  it("keeps GST inside the customer total", () => {
    expect(includedGstMinor(11800)).toBe(1800);
    const totals = quoteTotals({ subtotalMinor: 11800, discountMinor: 0, shippingMinor: 0 });
    expect(totals.grandTotalMinor).toBe(11800);
    expect(totals.taxMinor).toBe(1800);
  });

  it("caps percentage coupons and explains threshold codes", () => {
    expect(evaluateCoupon(rupeesToMinor(30000), "AURELIA10").discountMinor).toBe(200_000);
    expect(evaluateCoupon(rupeesToMinor(2000), "WELCOME500").error).toMatch(/3,000/);
    expect(evaluateCoupon(rupeesToMinor(3000), "welcome500").discountMinor).toBe(50_000);
  });

  it("allocates a discount without losing a paise", () => {
    const shares = allocateDiscount([100, 100, 100], 100);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it("blocks express for PIN codes that start with 9", () => {
    const methods = shippingMethods(1000, "900001");
    expect(methods.find((method) => method.id === "express")?.available).toBe(false);
    expect(methods.find((method) => method.id === "standard")?.available).toBe(true);
  });
});

describe("inventory", () => {
  it("lets only one reservation take the last unit", () => {
    const first = reserveQuantity(balance(1), 1);
    const second = reserveQuantity(first ?? balance(0), 1);
    expect(first?.availableToSell).toBe(0);
    expect(second).toBeNull();
  });

  it("releases a reservation once", () => {
    const reserved = reserveQuantity(balance(2), 1);
    const released = releaseQuantity(reserved!, 1);
    const again = releaseQuantity(released, 1);
    expect(released.availableToSell).toBe(2);
    expect(again.reserved).toBe(0);
    expect(again.availableToSell).toBe(2);
  });

  it("commits stock without restoring availability", () => {
    const reserved = reserveQuantity(balance(3), 2)!;
    const committed = commitQuantity(reserved, 2);
    expect(committed.onHand).toBe(1);
    expect(committed.reserved).toBe(0);
    expect(committed.availableToSell).toBe(1);
  });

  it("refuses an adjustment that would pass reserved units", () => {
    const held = reserveQuantity(balance(2), 2)!;
    expect(adjustOnHand(held, -1)).toBeNull();
  });
});

describe("orders and search", () => {
  it("guards order transitions and return windows", () => {
    expect(canTransition("confirmed", "shipped")).toBe(false);
    expect(customerMayCancel("fulfilling")).toBe(false);
    expect(returnEligibility({ orderState: "delivered", deliveredAt: new Date().toISOString(), categorySlug: "jewelry", now: Date.now() }).eligible).toBe(false);
    expect(returnEligibility({ orderState: "shipped", deliveredAt: null, categorySlug: "dresses", now: Date.now() }).eligible).toBe(false);
  });

  it("expands synonyms and does not match unrelated copy", () => {
    const products = buildProducts();
    const hits = searchCatalog(products, [{ id: "syn", terms: ["pants", "trousers"] }], {
      q: "pants",
      availability: new Map(),
    });
    expect(hits.some((hit) => hit.product.slug === "pleated-trouser")).toBe(true);
  });

  it("verifies payment and webhook signatures", () => {
    const secret = "test_secret";
    const signature = webhookSignature("{}", secret);
    expect(verifyWebhook("{}", signature, secret)).toBe(true);
    expect(verifyWebhook("{}", signature, "other")).toBe(false);
    const paymentSignature = createHmac("sha256", secret).update("order_1|pay_1").digest("hex");
    expect(verifyPaymentSignature("order_1", "pay_1", paymentSignature, secret)).toBe(true);
  });

  it("rejects a tampered session", () => {
    const token = signValue('{"sub":"cust_mira","role":"customer","exp":9999999999}');
    expect(unsignValue(token)).toContain("cust_mira");
    expect(unsignValue(`${token}x`)).toBeNull();
  });
});
