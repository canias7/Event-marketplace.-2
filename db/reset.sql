-- ===================================================================
-- WIPES THE WHOLE DATABASE. Only for development.
--
-- Order matters: you cannot delete a table another table points at,
-- so we delete in reverse order of how they were created.
-- ===================================================================

drop table if exists payments   cascade;
drop table if exists crm_notes  cascade;
drop table if exists bookings   cascade;
drop table if exists customers  cascade;
drop table if exists admins     cascade;
drop table if exists vendors    cascade;
drop table if exists categories cascade;
