-- ===================================================================
-- WIPES THE WHOLE DATABASE. Only for development.
--
-- This also removes the record of which migrations have run, so the
-- next startup rebuilds everything from db/migrations in order.
--
-- Order matters: you cannot delete a table another table points at,
-- so we delete in reverse order of how they were created.
-- ===================================================================

drop trigger if exists bookings_set_updated_at on bookings;
drop function if exists set_updated_at();

drop table if exists payments          cascade;
drop table if exists crm_notes         cascade;
drop table if exists bookings          cascade;
drop table if exists customers         cascade;
drop table if exists admins            cascade;
drop table if exists vendors           cascade;
drop table if exists categories        cascade;

-- Where logins are kept, on Neon only.
drop table if exists user_sessions      cascade;

-- The list of applied migrations. Dropping this makes them all run again.
drop table if exists schema_migrations  cascade;
