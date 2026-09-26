# Event Vendor Marketplace

A marketplace where customers find and book event vendors. Vendors get their
own login and a built-in CRM. Payments run through the app.

Will live at **app.eventvendora.com**.

---

## Run it right now (no signup, no keys, nothing to configure)

```bash
npm install
npm start
```

Open **http://localhost:3000**.

That works because when no Neon connection string is set, the app runs its own
Postgres inside a folder called `.localdb`. Real Postgres, real SQL, no account.
Your data stays there between restarts.

To fill it with something to look at:

```bash
npm run demo-data
```

That adds 24 vendors across all 12 categories, plus customers, bookings at
every stage, notes and payments. It prints a vendor login you can use - every
demo vendor's password is `demo1234`.

To get an admin account (stop the app first - see the note below):

```bash
npm run create-admin -- you@example.com yourpassword
```

Then log in at `/admin/login`.

## What you can click through today

**As a customer** - no login needed:
home page -> pick a category -> pick a vendor -> send a request -> get a
private link -> come back to it, see the vendor's price, and pay.

**As a vendor** - `/vendor/signup` or log in as a demo vendor:
your CRM. See every lead grouped by stage, click one to open it, send a price,
add private notes, and move it along the pipeline.

**As the admin** - `/admin/login`:
see every vendor, and counts of customers, bookings and payments.

---

## The four pieces (plain English)

Think of a small office:

| Piece | What it is |
|---|---|
| **Database** | The filing cabinet. Holds vendors, customers, bookings, payments, notes. |
| **Backend** | The clerk. Opens the cabinet, checks passwords, talks to Stripe. |
| **API** | The counter the clerk stands behind. Just the list of requests it accepts. Part of the backend, not a separate product. |
| **Frontend** | The forms you fill in. Plain HTML. Deliberately not pretty. |

## The three kinds of user

- **Customer** - browses vendors, requests a booking, pays. No login needed.
- **Vendor** - own login. Gets a dashboard and a CRM of their leads.
- **Admin** - you. Sees everything.

## The 12 vendor categories

Photography, Videography, Catering, DJ & Music, Venues, Florists,
Event Planners, Decor & Rentals, Cakes & Desserts, Hair & Makeup,
Transportation, Entertainment.

---

## The database

Seven tables. Read `db/schema.sql` top to bottom and you'll understand the
whole app - it's commented in plain English.

| Table | Holds |
|---|---|
| `categories` | The 12 vendor types |
| `vendors` | Businesses + their login |
| `admins` | Your login |
| `customers` | People booking |
| `bookings` | Who asked whom to do what. **This is also the vendor CRM.** |
| `crm_notes` | A vendor's private notes on a lead |
| `payments` | Money that moved, split into fee vs vendor payout |

**The CRM is not a separate system.** A vendor's CRM is just "all the bookings
pointing at me, grouped by status". One table does both jobs.

### What a vendor does in the CRM

| Screen | What they can do |
|---|---|
| `/vendor` | See all leads, and a count at each stage. Click a stage to filter. |
| `/vendor/leads/7` | Read the request, get the customer's email and phone, send a price, add private notes, move the lead along. |

When they enter a price the CRM shows them the arithmetic before they commit:

```
You quoted          $2,750.00
Marketplace fee   -   $275.00
You receive         $2,475.00
```

The fee comes out of the quote rather than being added on top, so the number
the customer sees is the number the vendor typed.

**Two rules the CRM will not let a vendor break:**

- A vendor can never mark a job **paid**. Only a real payment does that.
  Otherwise a vendor could claim money had arrived when it had not.
- A **paid** job cannot be cancelled from the CRM. The customer's money is
  involved, so that needs a refund rather than a button.

Quoting also locks once a job is booked, so a price cannot move after both
sides have agreed on it.

**A vendor only ever sees their own leads.** Every CRM query filters on the
logged-in vendor, so changing the number in the address bar to a stranger's
lead gives a 404. The tests check this by logging in as a second vendor and
trying to both read and overwrite the first one's lead.

A booking moves through these statuses, and the database refuses any other:

```
new -> quoted -> booked -> paid -> completed
                              \-> cancelled / lost
```

**Money is always stored in whole cents**, never decimals. `$2,500.00` is
stored as `250000`. Decimals quietly lose pennies.

### Two places the database can live

| `DATABASE_URL` | Where the data goes |
|---|---|
| Empty | The `.localdb` folder on this machine. No signup. |
| Set | Your Neon database. |

It is the same Postgres either way, so anything that works locally works on
Neon. Switching is one line in `.env`, and `npm run test:server` proves the
whole app on a real server before you rely on it.

**One catch with the local option:** it is built into the app rather than being
a separate server, so only one program can open it at a time. If the app is
running, commands like `npm run create-admin` will refuse to run and tell you
to stop the app first. This does not happen on Neon, which is a real server and
accepts as many connections as you like.

---

## Moving to Neon

1. Sign up at [neon.tech](https://neon.tech) (free tier is fine).
2. Create a project.
3. Copy the connection string. It looks like:
   ```
   postgresql://user:password@ep-something-123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   That one string holds the address, username, password and database name.
4. `cp .env.example .env`, then paste it in as `DATABASE_URL`.
5. `npm run db:setup`

`.env` is gitignored, so the password can never be pushed to GitHub.
`db/setup.sh` prints only the hostname, never the password.

To wipe and start over: `npm run db:setup -- --reset`

---

## How a customer comes back without a password

Customers do not sign up. When a request is sent, the booking gets a long
random link like:

```
/booking/8f3c1a9e42b7d05c6e1f8a3b9d4c7e20a5b6f1c8d3e9a2b4
```

That link is the only way in, which is why it is random rather than
`/booking/7`. Booking numbers run 1, 2, 3... - a link built from the number
would let anyone read other people's bookings just by counting.

The customer's page shows where things stand, the price once the vendor sends
one, and the Pay button.

## Payments

Three modes, decided at startup by looking at your Stripe key:

| What the app finds | What happens |
|---|---|
| No Stripe key | **Pretend mode.** Clicking Pay records the payment and marks the booking paid. Nothing leaves the app. |
| Key starts with `sk_test_` | Real Stripe **test** mode. Fake cards like `4242 4242 4242 4242`. |
| Anything else, including `sk_live_` | **The app refuses to start.** Prints an error and serves nothing. |

That last row is deliberate and tested. The Stripe account is shared with a
real business, so a live key must be incapable of moving real money here. It is
not a warning you can click past - the app simply will not run.

### What happens on a payment

The customer pays the marketplace. One payment row records all three numbers so
the split is never recalculated or guessed:

```
Customer pays      $2,600.00
Your fee (10%)       $260.00
Vendor is owed     $2,340.00
```

The vendor sees this on their lead. You see the running totals on `/admin`.

A booking can only be paid once. The app claims the booking and the payment in
a single step, so two payments arriving at the same moment cannot both succeed.
Reloading the "thanks for paying" page does not pay twice either.

### About the Stripe half

Coming back from Stripe, the app asks **Stripe** whether the payment happened
rather than believing the browser, and refuses unless the payment is complete,
belongs to this exact booking, and the amount matches the quote to the cent.

`npm run test:stripe` proves that logic with a stand-in for Stripe - including
dishonest replies, to check the app does not simply trust them. **The live
Stripe path still needs your real test keys to confirm end to end.** Everything
up to that point is tested.

---

## Checking things work

```bash
npm test             # every page, on the local database (156 + 34 checks)
npm run test:server  # the same tests, against a REAL Postgres server
npm run test:stripe  # the Stripe path, with a stand-in for Stripe
npm run db:check     # checks the SQL files are valid
```

**Why there are two.** Neon is a real Postgres server on the other end of a
network connection, reached with a different driver than the local database
uses. Testing only locally would leave that whole path unproven. `test:server`
sets up a throwaway Postgres on this machine and runs every test against it,
including over an encrypted, certificate-checked connection - the same shape as
Neon. Both are green.

`npm test` starts the app on a spare port with a throwaway database, runs 123
checks, then tidies up. It covers signups, logins, wrong passwords, locked-out
pages, password-guessing protection, admin access, browsing, booking requests
and their validation, the whole CRM, that one vendor cannot touch another's
leads, that data survives a restart, and that a failing page cannot take the
whole site down.

---

## Project layout

```
CLAUDE.md            Decisions and context for anyone picking this up
db/
  schema.sql         The 7 tables, commented in plain English
  seed.sql           The 12 categories
  reset.sql          Wipes everything (development only)
  setup.sh           Runs the SQL against Neon
  check-schema.js    Validates the SQL without needing Neon
src/
  server.js          Starts the web server
  config.js          Reads .env. Refuses to start on a live Stripe key.
  db.js              Talks to Neon, or to the local folder
  auth.js            Passwords, logins, who-is-allowed-where
  bookings.js        Checking and saving a booking request
  crm.js             Every CRM query. All filter by vendor id.
  payments.js        Pretend and Stripe payments, and booking links
  money.js           Cents to dollars, and the fee split
  handle.js          Keeps a failing page from killing the whole app
  routes/
    public.js        Home, browse, vendor profiles, booking requests
    vendor.js        Vendor signup, login, and the CRM
    admin.js         Admin login, overview
views/               The HTML pages
scripts/
  create-admin.js    Creates your admin account
  demo-data.js       Fills the app with fake vendors and bookings
test/
  e2e.sh             The checks. Runs against either database.
  with-real-postgres.sh  Sets up a real Postgres and runs them
  stripe-wiring.js       Tests the Stripe path with a stand-in
```

---

## Status

- [x] Database - 7 tables, validated against real Postgres
- [x] 12 vendor categories
- [x] Runs with zero setup (local Postgres fallback)
- [x] Vendor signup and login
- [x] Admin login
- [x] Password protection: hashing, vague errors, lockout after 8 tries
- [x] Customer browse: all vendors, by category, vendor profiles
- [x] Booking requests with validation
- [x] Demo data
- [x] Vendor CRM: pipeline, lead pages, quoting, notes, stage moves
- [x] Payments: pretend mode and the full Stripe test-mode path
- [x] Private per-booking links, so customers need no password
- [x] Admin money view: taken, fees kept, owed to vendors
- [x] Logins survive a restart on Neon
- [x] 156 end-to-end checks + 34 Stripe checks, also passing on real Postgres
- [ ] Deploy to app.eventvendora.com

**The app is finished.** Only deployment is left.
