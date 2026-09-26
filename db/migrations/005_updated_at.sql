-- ===================================================================
-- MIGRATION 005 - KEEP updated_at HONEST
--
-- The app sets bookings.updated_at by hand on every change. That works
-- until somebody adds a new update and forgets, and then the column
-- quietly lies.
--
-- A trigger is a small piece of code the database runs itself. This one
-- stamps the time on every change to a booking, whatever caused it.
-- ===================================================================

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bookings_set_updated_at on bookings;

create trigger bookings_set_updated_at
  before update on bookings
  for each row execute function set_updated_at();
