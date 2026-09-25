# Project context - read this first

Every decision made so far, so nothing has to be re-explained in a new session.

---

## What we are building

A marketplace where customers find and book event vendors. Three kinds of user:

- **Customer** - browses vendors, requests a booking, pays. No login.
- **Vendor** - has their own login. Gets a dashboard and a CRM of their leads.
- **Admin** - the owner. Sees everything.

Will be served from a subdomain of a domain the owner already has:
**app.eventvendora.com**. The domain is the *only* thing shared with the
existing Vendora business - the app, the database and the code are separate
and self-contained.

---

## How to talk to this user

**Keep every explanation extremely simple.** The user is learning software.
Assume no jargon. If a technical word is unavoidable, define it in the same
sentence. Short sentences. Plain analogies over precision.

They have said this explicitly and more than once. It is a hard requirement,
not a preference.

They also want this built **fast**. Prefer the boring, obvious solution over
the clever one. Do not add abstraction that isn't needed yet.

---

## Decisions already made - do not re-litigate these

### Frontend
Deliberately plain. **No design work requested or wanted.** Plain HTML that
works. Do not spend effort on styling.

### Database: Neon (hosted Postgres)
The connection string goes in `DATABASE_URL`.

Either the user adds it to the environment's settings as an environment
variable, or they put it in a local `.env` file. **Never ask them to paste a
connection string or any secret into the chat** - chat keeps a transcript.

`npm run db:check` validates the schema against an in-process Postgres, so
development does not need a live Neon connection.

### Payments: Stripe, TEST MODE ONLY - this one matters
The user is reusing the **Stripe account of their real, live business**. This
was discussed and chosen knowingly.

Because of that, there is a **hard guard at startup**, and it must never be
weakened, bypassed, or made into a warning:

| Key found | Behaviour |
|---|---|
| No key | Pretend mode. Payment is recorded locally, nothing sent anywhere. |
| Starts with `sk_test_` | Real Stripe test mode. |
| **Anything else, including `sk_live_`** | **Refuse to start. Serve nothing.** |

Same rule for the publishable key (`pk_test_` only).

A live key must be incapable of moving real money through this app. If a
future request seems to require relaxing this, stop and ask first.

### Money
Always stored as **whole cents in integer columns**, never decimals or floats.
`$2,500.00` is `250000`. Column names end in `_cents` so this is obvious.

The platform takes a percentage fee (`PLATFORM_FEE_PERCENT`, default 10). Each
payment row stores `amount_cents`, `fee_cents` and `vendor_payout_cents`
separately so the split is recorded, never recalculated.

### The CRM is not a separate system
A vendor's CRM is just *"every booking pointing at me, grouped by status"*.
The `bookings` table is both the customer's request and the vendor's lead card.
`crm_notes` holds their private notes.

**Do not add parallel "leads" or "deals" tables.** It was considered and
rejected as duplicate machinery that would need syncing.

### Vendor categories
12 of them, seeded in `db/seed.sql`: photography, videography, catering,
dj-music, venues, florists, event-planners, decor-rentals, cakes-desserts,
hair-makeup, transportation, entertainment.

### Stack
Node + Express + plain `pg` + EJS templates. Passwords hashed with bcryptjs.
Chosen because it is one language end to end and easy to read.

---

## Git

Work on branch **`claude/event-vendor-marketplace-v40ifz`**. Push with
`git push -u origin claude/event-vendor-marketplace-v40ifz`.
Do not open a pull request unless asked.

---

## Rules

- Secrets live only in `.env`, which is gitignored. Never commit a key.
- Never print a password or full connection string in output or logs -
  hostname only.
- Never ask the user to paste a secret into the chat.
- Verify work by running it. Do not report something as done on the strength
  of having written it.

---

## Where things are

```
CLAUDE.md           This file
README.md           Plain-English guide to the project
.env.example         Template for settings - copy to .env
db/schema.sql        The 7 tables, commented in plain English
db/seed.sql          The 12 categories
db/reset.sql         Wipes everything (development only)
db/setup.sh          Runs the SQL against Neon (npm run db:setup)
db/check-schema.js   Validates the SQL without Neon (npm run db:check)
```

---

## Build status

- [x] Database structure - 7 tables, validated against real Postgres
- [x] 12 vendor categories
- [ ] Vendor and admin logins
- [ ] Customer browse + booking request
- [ ] Vendor dashboard + CRM
- [ ] Payments (pretend mode + the test-key guard)
- [ ] Demo data
- [ ] Deploy to app.eventvendora.com

Nothing after this point needs a live Neon connection to build. Keep going
against `npm run db:check` and it will behave identically on Neon.
