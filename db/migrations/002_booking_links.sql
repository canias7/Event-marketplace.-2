-- ===================================================================
-- MIGRATION 002 - PRIVATE LINKS FOR CUSTOMERS
-- ===================================================================

-- -------------------------------------------------------------------
-- A PRIVATE LINK FOR EACH BOOKING
--
-- Customers have no login, so they need some way back to their own
-- booking to see the price and pay it.
--
-- Booking numbers run 1, 2, 3..., so a link built from the number
-- would let anyone read strangers' bookings just by counting. Instead
-- each booking gets a long random token and the customer's link holds
-- that. Unguessable, and it opens exactly one booking.
-- -------------------------------------------------------------------
alter table bookings add column if not exists public_token text;

-- Any booking made before this column existed gets a token now.
update bookings
   set public_token = md5(random()::text || id::text || clock_timestamp()::text)
 where public_token is null;

create unique index if not exists bookings_public_token_idx
  on bookings(public_token);

-- Stops the same Stripe payment being recorded twice, for instance if
-- someone reloads the "thanks for paying" page or replays the link.
create unique index if not exists payments_provider_ref_idx
  on payments(provider_ref) where provider_ref is not null;
