# AURELIA API

Commerce service for the AURELIA storefront. Catalog, cart, checkout, inventory reservations, orders, staff operations, and a grounded shopping assistant live in one modular process.

The storefront is a separate repository and talks to this API. Pricing, stock, tax, and payment status are recalculated here. The browser is not the authority.

## Run locally

```bash
npm install
npm run dev
```

The API listens on [http://localhost:4000](http://localhost:4000). Health: `/v1/health`.

```bash
npm test
npm run typecheck
```

## Persistence

With no `MONGODB_URI`, the process seeds an in-memory catalog. That is enough for local development and a serverless demo: the cart is also kept in a signed cookie, and prices are recomputed from the catalog on every read.

Set `MONGODB_URI` for durable orders, inventory, and admin edits across instances. Reservations then use a conditional MongoDB update so two checkouts cannot take the last unit. Copy `.env.example` to `.env.local`.

Set `SESSION_SECRET` in any deployed environment so sessions survive a cold start.

## Payments and the assistant

Checkout uses a sandbox adapter until `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set. The sandbox never collects card data. Webhooks are verified with HMAC and deduplicated before any business effect.

The assistant answers from catalog tools and the approved policy pages. It does not read the database freely, and it will not start a return without an explicit confirmation. Set `OPENAI_API_KEY` later if you want a model in front of the same tools. `AI_ENABLED=false` turns the assistant off without affecting checkout.

## Demo access

These accounts exist only in the seed data. Replace them before a real launch.

- Shopper: `mira@aurelia.test` / `AureliaShopper!1`
- Super admin: `admin@aurelia.test` / `AureliaAdmin!1`
- Order operator, refunds capped at ₹5,000: `ops@aurelia.test` / `AureliaOps!1`

Promotion codes: `AURELIA10`, `WELCOME500`.

## What this process owns

Identity, catalog, pricing, inventory, cart, checkout, orders, returns, and the assistant are modules behind one HTTP surface (`/v1`). Money is integer paise. Order transitions are explicit. Staff actions are permission-checked and written to the audit log.
