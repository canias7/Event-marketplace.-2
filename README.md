# Event Vendor Marketplace

A marketplace where customers find and book event vendors. Vendors get their
own login and a built-in CRM. Payments run through the app.

Will live at **app.eventvendora.com**.

---

## The four pieces (plain English)

Think of a small office:

| Piece | What it is |
|---|---|
| **Database** | The filing cabinet. Holds vendors, customers, bookings, payments, notes. Lives in Neon (hosted Postgres). |
| **Backend** | The clerk. Opens the cabinet, checks passwords, talks to Stripe. |
| **API** | The counter the clerk stands behind. Just the list of requests it accepts. Part of the backend, not a separate product. |
| **Frontend** | The forms you fill in. Plain HTML pages. Deliberately not pretty. |

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

A booking moves through these statuses:

```
new -> quoted -> booked -> paid -> completed
                              \-> cancelled / lost
```

**Money is always stored in whole cents**, never decimals. `$2,500.00` is
stored as `250000`. Decimals cause rounding bugs with money.

---

## Setup

### 1. Get a Neon database

1. Sign up at [neon.tech](https://neon.tech) (free tier is fine).
2. Create a project.
3. Copy the connection string it gives you. It looks like:
   ```
   postgresql://user:password@ep-something-123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   That one string contains the address, username, password and database name.

### 2. Configure the app

```bash
cp .env.example .env
```

Open `.env` and paste your Neon string in as `DATABASE_URL`.

`.env` is ignored by git, so your password can never get pushed to GitHub.

### 3. Create the tables

```bash
npm install
npm run db:setup
```

To wipe and start over: `npm run db:setup -- --reset`

---

## Payments

Payments have three modes, decided automatically at startup by looking at your
Stripe key:

| What the app finds | What happens |
|---|---|
| No Stripe key | **Pretend mode.** Clicking Pay records the payment and marks the booking paid. Nothing leaves the app. |
| Key starts with `sk_test_` | Real Stripe **test** mode. Fake card numbers like `4242 4242 4242 4242`. |
| Anything else, including `sk_live_` | **The app refuses to start.** Prints an error and serves nothing. |

That last row is deliberate. A live key cannot be used by mistake, because the
app simply won't run with one. No real money can ever move.

---

## Checking things work

```bash
npm run db:check
```

This runs the schema against an in-memory copy of Postgres - no Neon needed.
It creates the tables, inserts one of everything, and confirms the database
rejects bad data (invalid statuses, duplicate emails, made-up categories).

---

## Project layout

```
db/
  schema.sql        The 7 tables, commented in plain English
  seed.sql          The 12 categories
  reset.sql         Wipes everything (development only)
  setup.sh          Runs the above against Neon
  check-schema.js   Proves the SQL is valid without needing Neon
.env.example        Template for your settings. Copy to .env
```

---

## Status

- [x] Database structure (7 tables)
- [x] 12 vendor categories
- [x] Validated against real Postgres
- [ ] Vendor / admin logins
- [ ] Customer browse + booking request
- [ ] Vendor dashboard + CRM
- [ ] Payments
- [ ] Demo data
- [ ] Deploy to app.eventvendora.com
