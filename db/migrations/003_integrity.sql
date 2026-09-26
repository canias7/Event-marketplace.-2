-- ===================================================================
-- MIGRATION 003 - RULES THE DATABASE ENFORCES ITSELF
--
-- Everything here could be checked in the app code instead. The point
-- of putting it in the database is that the database is the last line:
-- a bug, a hand-typed SQL statement or a future change cannot get
-- around it.
-- ===================================================================


-- -------------------------------------------------------------------
-- ONE CUSTOMER ROW PER EMAIL
--
-- The app looks for an existing customer before making a new one, but
-- two requests arriving at the same instant could both look, both find
-- nothing, and both insert. A unique rule makes that impossible.
--
-- First, tidy any duplicates already there: point their bookings at the
-- oldest row for that email, then remove the leftovers.
-- -------------------------------------------------------------------
update bookings b
   set customer_id = keep.id
  from customers dup
  join (select min(id) as id, email from customers group by email) keep
    on keep.email = dup.email
 where b.customer_id = dup.id
   and dup.id <> keep.id;

delete from customers c
 where c.id <> (select min(id) from customers c2 where c2.email = c.email)
   and not exists (select 1 from bookings b where b.customer_id = c.id);

create unique index if not exists customers_email_unique on customers (email);

-- The old plain index is now redundant - the unique one does both jobs.
drop index if exists customers_email_idx;


-- -------------------------------------------------------------------
-- EVERY BOOKING MUST HAVE ITS PRIVATE LINK
--
-- Without one the customer has no way back to their booking at all.
-- Migration 002 filled in any that were missing; this makes it a rule.
-- -------------------------------------------------------------------
update bookings
   set public_token = md5(random()::text || id::text || clock_timestamp()::text)
 where public_token is null;

alter table bookings alter column public_token set not null;


-- -------------------------------------------------------------------
-- MONEY CANNOT BE NEGATIVE
-- -------------------------------------------------------------------
alter table vendors
  add constraint vendors_price_not_negative
  check (price_from_cents >= 0);

alter table bookings
  add constraint bookings_quote_not_negative
  check (quoted_amount_cents is null or quoted_amount_cents >= 0);

alter table bookings
  add constraint bookings_guests_not_negative
  check (guest_count is null or guest_count >= 0);

alter table payments
  add constraint payments_amounts_not_negative
  check (amount_cents >= 0 and fee_cents >= 0 and vendor_payout_cents >= 0);


-- -------------------------------------------------------------------
-- THE SPLIT MUST ADD UP
--
-- This is the most valuable rule in the file. Every payment records
-- what the customer paid, what the marketplace kept, and what the
-- vendor is owed. If those three ever stop agreeing, somebody's money
-- has gone missing. The database now refuses to store such a row at
-- all, so the books cannot silently drift.
-- -------------------------------------------------------------------
alter table payments
  add constraint payments_split_adds_up
  check (fee_cents + vendor_payout_cents = amount_cents);
