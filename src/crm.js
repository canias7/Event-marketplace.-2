/* ===================================================================
   THE VENDOR CRM

   A vendor's CRM is simply "every booking pointing at me". There is no
   separate leads table - the booking the customer sent IS the lead the
   vendor works.

   THE ONE RULE IN THIS FILE: every single function takes a vendorId and
   filters on it. A vendor must never be able to see or touch another
   vendor's leads, even by typing a different number in the address bar.
   =================================================================== */

const db = require('./db');
const { splitFee } = require('./money');
const config = require('./config');

/* The stages a lead moves through, in order. */
const PIPELINE = ['new', 'quoted', 'booked', 'paid', 'completed', 'cancelled', 'lost'];

const STATUS_LABELS = {
  new: 'New', quoted: 'Quoted', booked: 'Booked', paid: 'Paid',
  completed: 'Completed', cancelled: 'Cancelled', lost: 'Lost',
};

/* What a VENDOR is allowed to change a lead to, from where it is now.

   Note what is missing: a vendor can never set 'paid'. Only a real
   payment does that. Otherwise a vendor could mark a job paid without
   any money having moved.

   A paid job also cannot be cancelled here - the customer's money is
   involved, so that needs a refund, not a dropdown. */
const ALLOWED_MOVES = {
  new:       ['booked', 'cancelled', 'lost'],
  quoted:    ['booked', 'cancelled', 'lost'],
  booked:    ['completed', 'cancelled', 'lost'],
  paid:      ['completed'],
  completed: [],
  cancelled: ['booked'],        // reopened
  lost:      ['booked'],        // won back
};

/* Quoting a price is only sensible before the job is agreed. */
const CAN_QUOTE = ['new', 'quoted'];


/* -------------------------------------------------------------------
   HOW MANY LEADS AT EACH STAGE
   ------------------------------------------------------------------- */
async function pipelineCounts(vendorId) {
  const { rows } = await db.query(
    `select status, count(*)::int as n from bookings where vendor_id = $1 group by status`,
    [vendorId]
  );

  const counts = {};
  for (const stage of PIPELINE) counts[stage] = 0;
  for (const row of rows) counts[row.status] = row.n;
  counts.total = rows.reduce((sum, r) => sum + r.n, 0);
  return counts;
}


/* -------------------------------------------------------------------
   THE LEADS LIST. Pass a status to show only that stage.
   ------------------------------------------------------------------- */
async function listLeads(vendorId, status) {
  const wanted = PIPELINE.includes(status) ? status : null;

  const { rows } = await db.query(
    `select b.id, b.status, b.event_date, b.event_type, b.guest_count,
            b.quoted_amount_cents, b.created_at,
            cu.name as customer_name,
            (select count(*) from crm_notes n where n.booking_id = b.id)::int as note_count
       from bookings b
       join customers cu on cu.id = b.customer_id
      where b.vendor_id = $1
        and ($2::text is null or b.status = $2)
      order by b.created_at desc`,
    [vendorId, wanted]
  );
  return rows;
}


/* -------------------------------------------------------------------
   ONE LEAD, IN FULL. Returns null if it is not this vendor's - which
   is what makes guessing numbers in the address bar useless.
   ------------------------------------------------------------------- */
async function getLead(vendorId, bookingId) {
  const id = Number(bookingId);
  if (!Number.isInteger(id) || id < 1) return null;

  const lead = await db.one(
    `select b.*, cu.name as customer_name, cu.email as customer_email,
            cu.phone as customer_phone
       from bookings b
       join customers cu on cu.id = b.customer_id
      where b.id = $1 and b.vendor_id = $2`,
    [id, vendorId]
  );
  if (!lead) return null;

  lead.notes = (await db.query(
    `select body, created_at from crm_notes
      where booking_id = $1 and vendor_id = $2
      order by created_at desc`,
    [id, vendorId]
  )).rows;

  lead.payments = (await db.query(
    `select amount_cents, fee_cents, vendor_payout_cents, status, provider, created_at
       from payments where booking_id = $1 order by created_at desc`,
    [id]
  )).rows;

  lead.allowedMoves = ALLOWED_MOVES[lead.status] || [];
  lead.canQuote = CAN_QUOTE.includes(lead.status);

  /* If there is a quote, show the vendor what they would actually keep. */
  lead.split = lead.quoted_amount_cents
    ? splitFee(lead.quoted_amount_cents, config.feePercent)
    : null;

  return lead;
}


/* -------------------------------------------------------------------
   ADDING A NOTE
   ------------------------------------------------------------------- */
async function addNote(vendorId, bookingId, body) {
  const lead = await getLead(vendorId, bookingId);
  if (!lead) return { error: 'That lead was not found.' };

  const text = String(body || '').trim();
  if (!text) return { error: 'Please write something in the note.' };
  if (text.length > 2000) return { error: 'Please keep notes under 2000 characters.' };

  await db.query(
    'insert into crm_notes (booking_id, vendor_id, body) values ($1,$2,$3)',
    [lead.id, vendorId, text]
  );
  return { ok: 'Note added.' };
}


/* -------------------------------------------------------------------
   SENDING A QUOTE. Moves the lead to 'quoted'.
   ------------------------------------------------------------------- */
async function setQuote(vendorId, bookingId, priceInDollars) {
  const lead = await getLead(vendorId, bookingId);
  if (!lead) return { error: 'That lead was not found.' };
  if (!lead.canQuote) return { error: `You cannot change the price of a ${STATUS_LABELS[lead.status].toLowerCase()} job.` };

  const text = String(priceInDollars ?? '').replace(/[$,\s]/g, '');
  if (!text) return { error: 'Please enter a price.' };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { error: 'Enter the price as a number, for example 2500 or 2500.00' };

  const dollars = Number(text);
  if (dollars <= 0) return { error: 'The price must be more than zero.' };
  if (dollars > 10_000_000) return { error: 'That price is too large.' };

  const cents = Math.round(dollars * 100);

  await db.query(
    `update bookings set quoted_amount_cents = $1, status = 'quoted', updated_at = now()
      where id = $2 and vendor_id = $3`,
    [cents, lead.id, vendorId]
  );
  return { ok: 'Quote sent.' };
}


/* -------------------------------------------------------------------
   MOVING A LEAD ALONG
   ------------------------------------------------------------------- */
async function setStatus(vendorId, bookingId, newStatus) {
  const lead = await getLead(vendorId, bookingId);
  if (!lead) return { error: 'That lead was not found.' };

  const target = String(newStatus || '');

  if (!lead.allowedMoves.includes(target)) {
    if (target === 'paid') {
      return { error: 'Only a real payment can mark a job as paid.' };
    }
    if (lead.status === 'paid') {
      return { error: 'This job has been paid for. It cannot be cancelled here - that needs a refund.' };
    }
    return { error: `A ${STATUS_LABELS[lead.status].toLowerCase()} job cannot be moved to ${STATUS_LABELS[target] || 'that'}.` };
  }

  await db.query(
    `update bookings set status = $1, updated_at = now() where id = $2 and vendor_id = $3`,
    [target, lead.id, vendorId]
  );
  return { ok: `Moved to ${STATUS_LABELS[target]}.` };
}

module.exports = {
  PIPELINE, STATUS_LABELS,
  pipelineCounts, listLeads, getLead, addNote, setQuote, setStatus,
};
