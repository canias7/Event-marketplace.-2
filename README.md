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
home page -> pick a category -> pick a vendor -> fill in the request form ->
see your reference number.

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
Neon. Switching is one line in `.env`.

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

---

## Checking things work

```bash
npm test          # clicks through every page and checks what comes back
npm run db:check  # checks the SQL files are valid, without needing Neon
```

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
  e2e.sh             The 123 checks
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
- [x] 123 end-to-end tests
- [ ] Payments
- [ ] Deploy to app.eventvendora.com
