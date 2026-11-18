import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function scryptCost(): number {
  const fromEnv = Number(process.env.AURELIA_SCRYPT_N ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 1024) return fromEnv;
  return process.env.NODE_ENV === "test" ? 1024 : 16384;
}

export function hashPassword(password: string): string {
  const cost = scryptCost();
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32, { N: cost, r: 8, p: 1 }).toString("hex");
  return `scrypt$${cost}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const cost = Number(parts[1]);
  const salt = parts[2];
  const hash = parts[3];
  if (!salt || !hash || !Number.isFinite(cost) || cost < 1024) return false;
  const next = scryptSync(password, salt, 32, { N: cost, r: 8, p: 1 });
  const current = Buffer.from(hash, "hex");
  if (current.length !== next.length) return false;
  return timingSafeEqual(current, next);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
