/* ===================================================================
   PAYMENTS

   The customer pays the MARKETPLACE. We keep a fee and record what is
   owed to the vendor.

   There are two ways a payment can happen, decided once at startup by
   looking at the Stripe key (see src/config.js):

     'pretend'  no Stripe key set. Clicking Pay records the payment
                straight away. Nothing leaves the app. Good for
                building and demos.

     'stripe'   real Stripe TEST mode. The customer goes to a Stripe
                checkout page, pays with a fake card, and comes back.

   The rest of the app does not care which is in use.
   =================================================================== */

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const { splitFee } = require('./money');

/* A long random string for a booking's private link. 48 characters of
   randomness - not something anyone is going to guess. */
const newToken = () => crypto.randomBytes(24).toString('hex');

/* A booking can only be paid once a price exists and before it is paid. */
const PAYABLE = ['quoted', 'booked'];


/* -------------------------------------------------------------------
   FINDING A BOOKING FROM ITS PRIVATE LINK
   ------------------------------------------------------------------- */
async function findByToken(token) {
  const text = String(token || '');
  // Tokens are always 48 hex characters. Anything else cannot be one.
  if (!/^[0-9a-f]{32,64}$/.test(text)) return null;

  const booking = await db.one(
    `select b.*, v.business_name as vendor_name, v.phone as vendor_phone,
            c.name as category_name, cu.name as customer_name, cu.email as customer_email
       from bookings b
       join vendors v on v.id = b.vendor_id
       join categories c on c.id = v.category_id
       join customers cu on cu.id = b.customer_id
      where b.public_token = $1`,
    [text]
  );
  if (!booking) return null;

  booking.payments = (await db.query(
    `select amount_cents, fee_cents, vendor_payout_cents, status, provider, created_at
       from payments where booking_id = $1 order by created_at desc`,
    [booking.id]
  )).rows;

  booking.canPay = PAYABLE.includes(booking.status)
                   && booking.quoted_amount_cents > 0;

  booking.split = booking.quoted_amount_cents
    ? splitFee(booking.quoted_amount_cents, config.feePercent)
    : null;

  return booking;
}


/* -------------------------------------------------------------------
   RECORDING A SUCCESSFUL PAYMENT

   The update below is the important bit. It only changes the row if the
   booking is STILL waiting to be paid. If two payments arrive at the
   same moment, only one of them can win - the other gets nothing back
   and knows to stop. That is safer than checking first and then
   updating, where both could pass the check.
   ------------------------------------------------------------------- */
async function recordPayment(bookingId, provider, providerRef) {
  const claimed = await db.one(
    `update bookings set status = 'paid', updated_at = now()
      where id = $1
        and status = any($2)
        and quoted_amount_cents is not null
        and quoted_amount_cents > 0
      returning id, quoted_amount_cents`,
    [bookingId, PAYABLE]
  );

  if (!claimed) return { error: 'This booking has already been paid for.' };

  const split = splitFee(claimed.quoted_amount_cents, config.feePercent);

  await db.query(
    `insert into payments (booking_id, amount_cents, fee_cents, vendor_payout_cents,
                           status, provider, provider_ref)
     values ($1,$2,$3,$4,'paid',$5,$6)`,
    [claimed.id, split.amountCents, split.feeCents, split.vendorPayoutCents,
     provider, providerRef || null]
  );

  return { ok: true, split };
}


/* -------------------------------------------------------------------
   PRETEND MODE - no Stripe involved at all
   ------------------------------------------------------------------- */
async function payPretend(token) {
  const booking = await findByToken(token);
  if (!booking) return { error: 'That booking was not found.' };
  if (!booking.canPay) {
    return { error: booking.status === 'paid'
      ? 'This booking has already been paid for.'
      : 'This booking cannot be paid yet. The vendor has not sent a price.' };
  }
  return recordPayment(booking.id, 'pretend', 'pretend-' + newToken().slice(0, 12));
}


/* -------------------------------------------------------------------
   STRIPE TEST MODE

   The Stripe client is fetched through a function so tests can put a
   stand-in in its place and check what we send, without a network.
   ------------------------------------------------------------------- */
let stripeClient = null;

function getStripe() {
  if (!stripeClient) stripeClient = require('stripe')(config.stripeSecret);
  return stripeClient;
}

/* Used by the tests only. */
function _useStripeClient(client) { stripeClient = client; }

/* Step 1: send the customer to Stripe. Returns the address to send
   them to, which Stripe hosts - we never see their card details. */
async function startStripeCheckout(token, origin) {
  const booking = await findByToken(token);
  if (!booking) return { error: 'That booking was not found.' };
  if (!booking.canPay) {
    return { error: booking.status === 'paid'
      ? 'This booking has already been paid for.'
      : 'This booking cannot be paid yet. The vendor has not sent a price.' };
  }

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: booking.quoted_amount_cents,   // Stripe also works in cents
        product_data: {
          name: `${booking.vendor_name} - booking #${booking.id}`,
          description: booking.event_type || booking.category_name,
        },
      },
    }],
    /* Tying the session to this booking, so a session cannot be reused
       to mark a different booking paid. */
    client_reference_id: String(booking.id),
    customer_email: booking.customer_email,
    success_url: `${origin}/booking/${token}/paid?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/booking/${token}`,
  });

  return { redirectTo: session.url };
}

/* Step 2: the customer comes back. Never trust the browser to tell us
   the payment worked - ask Stripe directly. */
async function finishStripeCheckout(token, sessionId) {
  const booking = await findByToken(token);
  if (!booking) return { error: 'That booking was not found.' };

  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) {
    return { error: 'That payment could not be checked. Please try again.' };
  }

  const session = await getStripe().checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== 'paid') {
    return { error: 'Stripe says that payment did not complete.' };
  }
  if (String(session.client_reference_id) !== String(booking.id)) {
    return { error: 'That payment belongs to a different booking.' };
  }
  if (Number(session.amount_total) !== Number(booking.quoted_amount_cents)) {
    return { error: 'The amount paid does not match the price. Nothing has been changed.' };
  }

  return recordPayment(booking.id, 'stripe', session.id);
}


/* -------------------------------------------------------------------
   ONE DOOR FOR THE REST OF THE APP
   ------------------------------------------------------------------- */
const isStripe = () => config.paymentMode === 'stripe';

module.exports = {
  newToken, findByToken, recordPayment,
  payPretend, startStripeCheckout, finishStripeCheckout,
  isStripe, _useStripeClient,
};
