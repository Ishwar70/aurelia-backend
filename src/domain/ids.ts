import { createHash, randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function orderNumber(now = new Date()): string {
  const year = now.getUTCFullYear().toString().slice(2);
  return `AU-${year}${randomBytes(3).toString("hex").toUpperCase()}`;
}

export function returnNumber(now = new Date()): string {
  const year = now.getUTCFullYear().toString().slice(2);
  return `RT-${year}${randomBytes(3).toString("hex").toUpperCase()}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
