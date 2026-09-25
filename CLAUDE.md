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
src/handle.js        Wrapper that keeps a failing page from killing the app
src/bookings.js      Booking request validation and creation
src/money.js         Cents to dollars, and the platform fee split
scripts/demo-data.js 24 fake vendors and a full CRM (npm run demo-data)
test/e2e.sh          The 79 checks (npm test)
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
- [x] 79 end-to-end tests (`npm test`)
- [ ] Vendor CRM (leads pipeline and notes)
- [ ] Payments
- [ ] Deploy to app.eventvendora.com

Nothing left needs a live Neon connection to build.

### Things already handled, so do not "fix" them again
- Booking receipts are keyed off the session, not a booking id in the URL.
  Booking ids run 1, 2, 3..., so `/booking/7` would let anyone read a
  stranger's request.
- Public listings never select a vendor's email.

### Known gap to close later
No CSRF tokens on forms. Right now the session cookie is `sameSite: 'lax'`,
which stops another website posting our forms, so this is covered for the
common case but should get real tokens before real money flows.
