# EventVendora Marketplace

A marketplace where customers find and book event vendors. It runs on **Cloudflare Workers** at
**https://marketplace.eventvendora.com**, stores data in **Neon Postgres**, and takes payments through
**Stripe Checkout in test mode**.

- **15 vendor categories:** Photography, Videography, Catering, DJs, Live Music, Venues, Florists,
  Event Planners, Decor & Rentals, Hair & Makeup, Cakes & Desserts, Officiants, Lighting & AV,
  Photo Booths, Transportation.
- **Vendor accounts:** each vendor signs up with their own email and password, and gets a public
  profile at `/v/<slug>`, bookable packages, a bookings list, an earnings summary and a private CRM.
- **Payments through the app:** customers pay on the platform's Stripe Checkout, and the platform
  keeps a commission (`PLATFORM_FEE_BPS`, default 10%).
  - A vendor who connects a Stripe Express account (test mode) is paid out automatically by
    destination charge.
  - Until then, the platform holds the vendor's net amount, which the Payments page shows.
- **Built-in CRM per vendor:**
  - Contacts with pipeline stages: lead → contacted → proposal → booked → completed / lost.
  - An activity timeline of notes, calls, emails, meetings, inquiries, bookings and payments.
  - Tasks with due dates and overdue highlighting, search, lifetime value and CSV export.
  - Inquiries and bookings from the public page create or update contacts automatically, and a
    payment moves the contact to *booked*.
  - Every CRM query is scoped to the logged-in vendor.

The pages are plain server-rendered HTML with no frontend build step.

## Stripe test mode only

The app refuses any key that isn't `sk_test_…`/`rk_test_…` and ignores live-mode webhook events.
Pay with card `4242 4242 4242 4242`, any future expiry date and any CVC.

## Project layout

```
src/index.ts          app setup: session loading, CSRF protection, /vendor auth guard
src/routes/public.ts  browse categories and vendors, inquiries, booking + Stripe Checkout, receipts
src/routes/auth.ts    vendor signup, login, logout
src/routes/vendor.ts  dashboard, profile, services, bookings, payments (Stripe Connect)
src/routes/crm.ts     CRM contacts, pipeline, timeline, tasks, CSV export
src/routes/webhook.ts Stripe webhook (signature-verified)
src/lib/              auth (PBKDF2, sessions), fetch-based Stripe client, CRM helpers, views
migrations/           SQL schema + category seed (applied by `npm run migrate`)
```

## Setup

### 1. Database (Neon)

The schema is already applied to the `main` branch of the Neon project
*Event vendor marketplace 2* (`nameless-brook-83864038`). To migrate another branch or a fresh
database:

```sh
npm install
DATABASE_URL='postgresql://…-pooler…neon.tech/neondb?sslmode=require' npm run migrate
```

### 2. Stripe (test mode)

1. In the Stripe Dashboard, switch to **Test mode** and copy the secret key (`sk_test_…`).
2. Enable **Connect** (Settings → Connect) so vendors can onboard Express accounts. This is
   optional; without it, all funds stay on the platform account.
3. Go to Developers → Webhooks and add the endpoint
   `https://marketplace.eventvendora.com/stripe/webhook` with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`. Copy its signing secret.
4. Optionally, add a second endpoint at the same URL that **listens to events on Connected
   accounts**, with the event `account.updated`. Copy its signing secret too.

### 3. Cloudflare

`eventvendora.com` must be a zone in your Cloudflare account. `wrangler.toml` routes the Worker to
the custom domain `marketplace.eventvendora.com`, and Cloudflare creates the DNS record and
certificate on deploy.

```sh
npx wrangler login
npx wrangler secret put DATABASE_URL                   # Neon pooled connection string
npx wrangler secret put STRIPE_SECRET_KEY              # sk_test_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET          # whsec_… (platform endpoint)
npx wrangler secret put STRIPE_CONNECT_WEBHOOK_SECRET  # whsec_… (Connect endpoint, optional)
npm run deploy
```

To use a different subdomain, change the `routes` pattern in `wrangler.toml`.

### Continuous deployment

`.github/workflows/deploy.yml` typechecks and tests every push and PR. On pushes to `main` it also
applies migrations and deploys. Add these repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token with the *Edit Cloudflare Workers* template, plus zone access for eventvendora.com |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `DATABASE_URL` | Neon connection string for production (used for migrations) |
| `TEST_DATABASE_URL` | Optional: a disposable Neon branch for the end-to-end tests |

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in a Neon *branch* URL and Stripe test keys
npm run dev                      # http://localhost:8787
stripe listen --forward-to localhost:8787/stripe/webhook   # optional, to receive webhooks locally
```

## Tests

```sh
npm run typecheck
npm test                                               # unit tests
TEST_DATABASE_URL='postgresql://…' npm test            # plus end-to-end tests against Neon
```

The end-to-end suite stubs Stripe's API. It covers:

- signup and login, CSRF rejection, and the auth guard;
- publishing a package, inquiry → CRM lead, and HTML escaping;
- isolating each vendor's CRM;
- checkout, an idempotent signed webhook, the CRM payment record, and fee and earnings totals;
- refusing live keys and neutralising formulas in the CSV export.

Point `TEST_DATABASE_URL` at a throwaway Neon branch, never production.
