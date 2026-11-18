import { Hono } from "hono";
import { cors } from "hono/cors";
import { getStore } from "../data/create-store";
import { CommerceError } from "../domain/errors";
import { problem, readCustomerId, readStaffId } from "./http";
import { adminRoutes } from "./routes/admin";
import { commerceRoutes } from "./routes/commerce";
import { publicRoutes } from "./routes/public";
import type { AppEnv } from "./types";

function originAllowed(origin: string): boolean {
  const configured = (process.env.WEB_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host.startsWith("aurelia-frontend");
  } catch {
    return false;
  }
}

export const app = new Hono<AppEnv>().basePath("/v1");

app.use("*", cors({
  origin: (origin) => (originAllowed(origin) ? origin : null),
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["content-type", "idempotency-key", "x-trace-id"],
  credentials: true,
}));

app.use("*", async (c, next) => {
  const traceId = c.req.header("x-trace-id") ?? crypto.randomUUID();
  c.set("traceId", traceId);
  c.header("x-trace-id", traceId);
  c.header("cache-control", "no-store");
  const started = Date.now();
  try {
    c.set("store", await getStore());
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "store.open_failed", traceId, message: error instanceof Error ? error.message : "unknown" }));
    return problem(c, 503, "STORE_UNAVAILABLE", "Store unavailable", "The catalog store could not be opened.");
  }
  c.set("customerId", readCustomerId(c));
  c.set("staffId", readStaffId(c));
  await c.get("store").releaseExpired();
  await next();
  console.log(JSON.stringify({
    level: "info",
    service: "aurelia-api",
    traceId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - started,
  }));
});

app.route("/", publicRoutes);
app.route("/", commerceRoutes);
app.route("/", adminRoutes);

app.notFound((c) => problem(c, 404, "NOT_FOUND", "Not found", "No route matches this request."));

app.onError((error, c) => {
  if (error instanceof CommerceError) return problem(c, error.status, error.code, error.title, error.detail, error.extra);
  console.error(JSON.stringify({ level: "error", traceId: c.get("traceId"), message: error instanceof Error ? error.message : "unknown" }));
  return problem(c, 500, "INTERNAL", "Something went wrong", "The request could not be completed.");
});
