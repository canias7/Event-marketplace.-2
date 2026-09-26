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

**The app runs with no Neon at all.** When `DATABASE_URL` is empty it starts
its own Postgres in a `.localdb` folder. Same Postgres, same SQL, so anything
that works locally works on Neon.

**The Neon path is tested, not assumed.** `npm run test:server` installs a real
Postgres on the machine and runs the entire suite against it through the `pg`
driver, including over a certificate-verified TLS connection. Do not claim
something works on Neon on the strength of the local tests alone - run that.

Two things genuinely differ between the two, and the test suite branches on it:
a real server accepts many connections at once, so `create-admin` works while
the app is running; the local one does not.

That local database is embedded in the process, so **only one program can open
it at a time**. `src/db.js` enforces this with a `.in-use-by-pid` note file
kept NEXT TO the folder (never inside it - Postgres refuses to open a data
folder containing unexpected files). Without this, `npm run create-admin` while
the app was running would report success and silently lose the write. Neon has
no such limit.

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

### Careful if `pg` is ever upgraded past version 8
`pg` currently treats `sslmode=require` as the strict `verify-full`, which is
what we want. In `pg` v9 it becomes the weaker libpq meaning: encrypted but the
certificate is **not** checked. `package.json` pins `pg` to `^8`, so this cannot
change by accident. If that pin is ever raised, change the connection string to
`sslmode=verify-full` in the same commit.

### How a customer gets back to their booking
Customers have no login. Each booking carries a long random `public_token`
and the customer's only way in is `/booking/<token>`. Booking ids run
1, 2, 3..., so a link built from the id would let anyone read strangers'
bookings by counting. **Never add a customer-facing page keyed on the booking
id.**

### Payments
`src/payments.js` holds both modes behind one door. `recordPayment` claims the
booking with a conditional UPDATE (`where status = any(PAYABLE)`) so two
payments arriving together cannot both succeed - checking first and then
updating would let both through.

On the way back from Stripe the app asks Stripe directly and refuses unless the
session is paid, belongs to this booking (`client_reference_id`), and the amount
matches the quote to the cent. A unique index on `payments.provider_ref` stops
the same Stripe session being recorded twice.

`npm run test:stripe` proves all of that with a stand-in for Stripe, so the
logic is tested without keys. **The live Stripe path still needs real test keys
to confirm end to end - say so rather than implying it is proven.**

### Logins and SESSION_SECRET
With Neon, logins are stored in the database (`connect-pg-simple`, table
`user_sessions`) so a restart or redeploy does not log everyone out. On the
local database they stay in memory.

That only works if `SESSION_SECRET` is set. Without it config invents a new one
each startup, the old cookies can no longer be checked, and everyone is logged
out anyway - database store or not. The startup output says so in plain terms
when that is the case. This cost a debugging round; do not remove that message.

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

`src/crm.js` holds every CRM query. **Every function in it takes a vendorId
and filters on it.** That is the only thing stopping a vendor from reading or
editing another vendor's leads by changing the number in the address bar.
A lead that is not theirs comes back as null, which the routes turn into a 404.
Never add a CRM query that trusts an id from the URL without also filtering on
the logged-in vendor. `npm test` checks this by logging in as a second vendor
and trying to read and overwrite the first one's lead.

### A vendor can never set a booking to 'paid'
`ALLOWED_MOVES` in `src/crm.js` leaves 'paid' out of every list on purpose -
only a real payment sets it. A paid job also cannot be cancelled from the CRM,
because the customer's money is involved and that needs a refund. Quoting is
locked once a job is booked.

### Vendor categories
12 of them, seeded in `db/seed.sql`: photography, videography, catering,
dj-music, venues, florists, event-planners, decor-rentals, cakes-desserts,
hair-makeup, transportation, entertainment.

### Stack
Node + Express + plain `pg` + EJS templates. Passwords hashed with bcryptjs.
Chosen because it is one language end to end and easy to read.

### EVERY page that waits on the database MUST be wrapped in handle()

```js
const { handle } = require('../handle');
router.get('/thing', handle(async (req, res) => { ... }));
```

This is not a style preference. Express 4 does not catch a rejected promise
from an async route, and Node's default on an uncaught rejection is to **kill
the whole process**. An unwrapped page means one bad request takes the entire
site offline and logs out every vendor. This actually happened: a customer
entering 31 February made Postgres refuse the date and the app died.

Async *middleware* needs it too - note `handle(auth.loadVendor)` in
`routes/vendor.js`.

`server.js` has an `unhandledRejection` listener as a last resort that logs
loudly and keeps serving, and `npm test` asserts it never fires. Do not treat
that backstop as permission to skip `handle()`.

### Dates must be checked for existing, not just for format
`2027-02-31` matches `YYYY-MM-DD` and JavaScript quietly rolls it to 3 March
rather than complaining, but Postgres rejects it. `readEventDate` in
`bookings.js` builds the date and checks it reads back the same.

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
- `npm test` must pass before committing. It starts the app on port 3999 with
  a throwaway database and refuses to run if something is already listening
  there, because stale servers answering with their own data make every result
  a lie.
- When backgrounding the server in a shell script, put the environment
  variables directly in front of `node`, not behind a shell function - `$!`
  would otherwise be the wrapper's id and `kill` would leave the app running.

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
src/crm.js           Every CRM query. All of them filter by vendor id.
src/handle.js        Wrapper that keeps a failing page from killing the app
src/bookings.js      Booking request validation and creation
src/money.js         Cents to dollars, and the platform fee split
scripts/demo-data.js 24 fake vendors and a full CRM (npm run demo-data)
test/e2e.sh          The checks. Runs against either database.
test/with-real-postgres.sh  Sets up a real Postgres and runs them (npm run test:server)
test/stripe-wiring.js       Tests the Stripe path with a stand-in (npm run test:stripe)
```

---

## Build status

- [x] Database structure - 7 tables, validated against real Postgres
- [x] 12 vendor categories
- [x] Zero-setup local Postgres fallback
- [x] Vendor signup and login
- [x] Admin login (`npm run create-admin`)
- [x] Password hashing, identical errors for wrong-email and wrong-password,
      lockout after 8 failed tries
- [x] Stripe live-key guard, with tests proving it refuses to start
- [x] Customer browse: all vendors, by category, single vendor profile
- [x] Booking requests, with validation and a receipt page
- [x] Demo data (`npm run demo-data`) - 24 vendors, all 12 categories
- [x] Vendor CRM: pipeline with filters, lead pages, quoting, notes, stage moves
- [x] Fee split shown to the vendor before they quote
- [x] 123 end-to-end tests (`npm test`)
- [x] Whole suite also passes against a real Postgres server over verified TLS
      (`npm run test:server`)
- [x] Payments: pretend mode and the full Stripe test-mode path
- [x] Private per-booking links for customers
- [x] Admin money view: taken, fees kept, owed to vendors
- [x] Logins survive a restart on Neon
- [x] 156 end-to-end checks + 34 Stripe checks
- [ ] Deploy to app.eventvendora.com

The app itself is finished. Only deployment is left, which needs the user's
DNS access and a host.

Nothing left needs a live Neon connection to build.

### Things already handled, so do not "fix" them again
- Booking receipts are keyed off the session, not a booking id in the URL.
  Booking ids run 1, 2, 3..., so `/booking/7` would let anyone read a
  stranger's request.
- Public listings never select a vendor's email.
- `/vendor` is the CRM. A vendor's own details are on `/vendor/account`.

### Known gap to close later
No CSRF tokens on forms. Right now the session cookie is `sameSite: 'lax'`,
which stops another website posting our forms, so this is covered for the
common case but should get real tokens before real money flows.
