import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function webhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhook(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  return safeEqual(signature, webhookSignature(rawBody, secret));
}

export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(signature, expected);
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export async function createRazorpayOrder(amountMinor: number, receipt: string): Promise<{ id: string } | null> {
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) return null;
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ amount: amountMinor, currency: "INR", receipt }),
  });
  if (!response.ok) {
    throw new Error("RAZORPAY_CREATE_FAILED");
  }
  const body = (await response.json()) as { id: string };
  return { id: body.id };
}
