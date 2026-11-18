import { createHmac, timingSafeEqual } from "node:crypto";

export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === "production") {
    console.warn("SESSION_SECRET is missing; set it before real traffic.");
  }
  return "dev-only-aurelia-secret-change-me";
}

export function signValue(value: string, secret = sessionSecret()): string {
  const body = Buffer.from(value, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function unsignValue(token: string, secret = sessionSecret()): string | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}

export interface SessionClaims {
  sub: string;
  role: "customer" | "staff";
  exp: number;
}

export function issueSession(sub: string, role: SessionClaims["role"], ttlSeconds: number): string {
  const claims: SessionClaims = { sub, role, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  return signValue(JSON.stringify(claims));
}

export function readSession(token: string | undefined): SessionClaims | null {
  if (!token) return null;
  const raw = unsignValue(token);
  if (!raw) return null;
  try {
    const claims = JSON.parse(raw) as SessionClaims;
    if (!claims.sub || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
