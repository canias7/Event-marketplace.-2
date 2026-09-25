/* ===================================================================
   BOOKING REQUESTS - a customer asking a vendor to do their event.

   A booking request is the start of everything. It is what the
   customer sends, and it is also the "lead" that shows up in the
   vendor's CRM. Same row, two points of view.
   =================================================================== */

const db = require('./db');
const { cleanEmail, emailProblem } = require('./auth');

/* Today as YYYY-MM-DD, so we can tell if an event date is in the past. */
const today = () => new Date().toISOString().slice(0, 10);

/* Checks the date the customer picked. Blank is allowed - plenty of
   people are still deciding. Returns { value } or { error }. */
function readEventDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return { value: null };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: 'Please give the date as YYYY-MM-DD.' };

  /* A date like 2027-02-31 looks fine but does not exist. JavaScript
     quietly rolls it forward to 3 March instead of complaining, so we
     build the date and check it still reads back the same. Without this
     Postgres rejects it later, which is much harder to recover from. */
  const [year, month, day] = text.split('-').map(Number);
  const built = new Date(Date.UTC(year, month - 1, day));
  if (built.getUTCFullYear() !== year || built.getUTCMonth() !== month - 1 || built.getUTCDate() !== day) {
    return { error: 'That date does not exist. Please check the day and month.' };
  }

  if (text < today()) return { error: 'That date has already passed.' };
  if (text > '2100-01-01') return { error: 'That date is too far in the future.' };

  return { value: text };
}

/* Checks the guest count. Blank is allowed. */
function readGuestCount(raw) {
  const text = String(raw || '').trim();
  if (!text) return { value: null };

  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) return { error: 'Guest count must be a whole number.' };
  if (n > 1000000) return { error: 'That guest count is too large.' };

  return { value: n };
}

/* The public vendor listing. Only active vendors - a hidden vendor
   should be invisible to customers, not just unlinked. */
function findPublicVendor(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return Promise.resolve(null);

  return db.one(
    `select v.id, v.business_name, v.city, v.description, v.phone,
            v.price_from_cents, c.name as category_name, c.slug as category_slug
       from vendors v
       join categories c on c.id = v.category_id
      where v.id = $1 and v.is_active`,
    [n]
  );
}

/* Creates the booking request.
   Returns { booking } on success, or { error } with a message to show. */
async function requestBooking(vendorId, form) {
  const vendor = await findPublicVendor(vendorId);
  if (!vendor) return { error: 'That vendor is no longer available.' };

  const name = String(form.name || '').trim();
  if (!name) return { error: 'Please enter your name.' };
  if (name.length > 120) return { error: 'That name is too long.' };

  const email = cleanEmail(form.email);
  const badEmail = emailProblem(email);
  if (badEmail) return { error: badEmail };

  const date = readEventDate(form.eventDate);
  if (date.error) return { error: date.error };

  const guests = readGuestCount(form.guestCount);
  if (guests.error) return { error: guests.error };

  const details = String(form.details || '').trim();
  if (!details) return { error: 'Please tell the vendor what you need.' };
  if (details.length > 2000) return { error: 'Please keep the details under 2000 characters.' };

  /* Reuse the customer if we have seen this email before, so the same
     person's requests stay joined up. */
  let customer = await db.one('select id from customers where email = $1 order by id limit 1', [email]);
  if (!customer) {
    customer = await db.one(
      'insert into customers (email, name, phone) values ($1,$2,$3) returning id',
      [email, name, String(form.phone || '').trim().slice(0, 40)]
    );
  }

  const booking = await db.one(
    `insert into bookings (vendor_id, customer_id, event_date, event_type, guest_count, details, status)
     values ($1,$2,$3,$4,$5,$6,'new')
     returning id`,
    [vendor.id, customer.id, date.value,
     String(form.eventType || '').trim().slice(0, 120),
     guests.value, details]
  );

  return { booking: { id: booking.id, vendor } };
}

module.exports = { findPublicVendor, requestBooking, readEventDate, readGuestCount };
