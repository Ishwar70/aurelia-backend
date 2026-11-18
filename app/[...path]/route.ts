import { app } from "../../src/server/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handle(request: Request) {
  return app.fetch(request);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
