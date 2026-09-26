-- ===================================================================
-- MIGRATION 004 - INDEXES FOR THE QUESTIONS THE APP ACTUALLY ASKS
--
-- An index is a lookup shortcut. Without one, the database reads every
-- row to answer a question, which is fine with 10 vendors and slow with
-- 10,000. Each index below matches a real query in the code.
-- ===================================================================

-- src/crm.js listLeads: a vendor's leads, newest first.
-- The existing (vendor_id, status) index handles the stage filter but
-- not the sort, so the sort was being done by hand every time.
create index if not exists bookings_vendor_recent_idx
  on bookings (vendor_id, created_at desc);

-- Every lead page joins the booking to its customer.
create index if not exists bookings_customer_idx
  on bookings (customer_id);

-- routes/public.js browse: active vendors in one category, by name.
-- Partial ("where is_active") so hidden vendors are not even indexed.
create index if not exists vendors_active_category_idx
  on vendors (category_id, business_name) where is_active;

-- routes/admin.js: the 25 most recent payments.
create index if not exists payments_recent_idx
  on payments (created_at desc);

-- A vendor's own notes.
create index if not exists crm_notes_vendor_idx
  on crm_notes (vendor_id);
