-- ===================================================================
-- EVENT VENDOR MARKETPLACE - DATABASE STRUCTURE
--
-- Read this file top to bottom and you will understand the whole app.
-- There are only 7 tables.
--
-- A "table" is a spreadsheet. Each row is one record.
-- Money is ALWAYS stored in whole cents (integers), never decimals,
-- because decimals cause rounding bugs with money.
-- ===================================================================


-- -------------------------------------------------------------------
-- 1. CATEGORIES - the kinds of vendors. Photography, catering, etc.
--    This list is fixed. We fill it in seed.sql.
-- -------------------------------------------------------------------
create table if not exists categories (
  id          serial primary key,
  slug        text not null unique,   -- url-safe name, e.g. "dj-music"
  name        text not null,          -- display name, e.g. "DJ & Music"
  description text not null default ''
);


-- -------------------------------------------------------------------
-- 2. VENDORS - the businesses. Each one gets their own login.
--
--    password_hash is a scrambled version of the password. We never
--    store the real password, so even we cannot read it.
-- -------------------------------------------------------------------
create table if not exists vendors (
  id            serial primary key,
  email         text not null unique,
  password_hash text not null,
  business_name text not null,
  category_id   integer not null references categories(id),
  city          text not null default '',
  description   text not null default '',
  phone         text not null default '',
  -- Their starting price, shown on their listing. In cents.
  price_from_cents integer not null default 0,
  -- false = hidden from customers. Lets you approve vendors later.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Makes "show me all photographers" fast.
create index if not exists vendors_category_idx on vendors(category_id);


-- -------------------------------------------------------------------
-- 3. ADMINS - you. Sees everything. Separate table from vendors so
--    a vendor can never accidentally become an admin.
-- -------------------------------------------------------------------
create table if not exists admins (
  id            serial primary key,
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);


-- -------------------------------------------------------------------
-- 4. CUSTOMERS - people booking vendors. No password: they just leave
--    their details when they make a request. Keeps things simple.
-- -------------------------------------------------------------------
create table if not exists customers (
  id         serial primary key,
  email      text not null,
  name       text not null,
  phone      text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists customers_email_idx on customers(email);


-- -------------------------------------------------------------------
-- 5. BOOKINGS - the heart of the app. One row = one customer asking
--    one vendor to do one event.
--
--    THIS TABLE IS ALSO THE VENDOR'S CRM. A vendor's CRM is simply
--    "all the bookings pointing at me, grouped by status". We do not
--    need a second set of tables for the CRM.
--
--    status moves through a pipeline:
--      new       -> request just came in, vendor has not replied
--      quoted    -> vendor sent a price
--      booked    -> customer accepted, not paid yet
--      paid      -> customer paid through the app
--      completed -> event happened
--      cancelled -> fell through
--      lost      -> customer went elsewhere
-- -------------------------------------------------------------------
create table if not exists bookings (
  id          serial primary key,
  vendor_id   integer not null references vendors(id),
  customer_id integer not null references customers(id),

  event_date  date,
  event_type  text not null default '',   -- "wedding", "birthday", ...
  guest_count integer,
  details     text not null default '',   -- what the customer wrote

  status      text not null default 'new'
              check (status in ('new','quoted','booked','paid','completed','cancelled','lost')),

  -- The price the vendor quoted, in cents. Null until they quote.
  quoted_amount_cents integer,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The single most important index: "show me MY leads" for a vendor.
create index if not exists bookings_vendor_status_idx on bookings(vendor_id, status);


-- -------------------------------------------------------------------
-- 6. CRM_NOTES - a vendor's private notes on a lead.
--    "Called her Tuesday, wants outdoor shots, budget is tight."
--    Only the vendor who owns the booking can see these.
-- -------------------------------------------------------------------
create table if not exists crm_notes (
  id         serial primary key,
  booking_id integer not null references bookings(id) on delete cascade,
  vendor_id  integer not null references vendors(id),
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists crm_notes_booking_idx on crm_notes(booking_id);


-- -------------------------------------------------------------------
-- 7. PAYMENTS - money that moved. One row per payment attempt.
--
--    The customer pays the MARKETPLACE. We keep a fee, the rest is
--    owed to the vendor. We record all three numbers so the math is
--    never a guess:
--       amount_cents = fee_cents + vendor_payout_cents
--
--    provider tells you how it was paid:
--       'pretend' = fake payment, no Stripe involved
--       'stripe'  = real Stripe test-mode payment
-- -------------------------------------------------------------------
create table if not exists payments (
  id         serial primary key,
  booking_id integer not null references bookings(id),

  amount_cents         integer not null,
  fee_cents            integer not null,
  vendor_payout_cents  integer not null,

  status     text not null default 'pending'
             check (status in ('pending','paid','failed','refunded')),

  provider   text not null default 'pretend'
             check (provider in ('pretend','stripe')),

  -- Stripe's own id for this payment, so we can look it up in Stripe.
  provider_ref text,

  created_at timestamptz not null default now()
);

create index if not exists payments_booking_idx on payments(booking_id);
