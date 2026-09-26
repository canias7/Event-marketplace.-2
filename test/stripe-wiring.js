/* ===================================================================
   TESTS THE STRIPE PATH WITHOUT TOUCHING STRIPE

   The real Stripe path needs API keys, which we do not have here. But
   the part that can go wrong is OUR code: do we send Stripe the right
   amount, and do we check hard enough when the customer comes back?

   So this puts a stand-in in place of Stripe. It records what we sent,
   and replies with whatever the test wants - including dishonest
   replies, to prove we do not simply believe them.

   Run with: npm run test:stripe
   =================================================================== */

/* Settings are read once when config.js is first loaded, so the keys
   have to be in place before anything else is required. */
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_testing';
process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_fake_for_testing';
process.env.DATABASE_URL = '';
process.env.LOCAL_DB_DIR = require('fs').mkdtempSync('/tmp/stripe-test-');
process.env.PLATFORM_FEE_PERCENT = '10';

const db = require('../src/db');
const config = require('../src/config');
const payments = require('../src/payments');
const auth = require('../src/auth');

let pass = 0, fail = 0;

const check = (what, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  PASS  ' + what); pass++; }
  else {
    console.log('  FAIL  ' + what);
    console.log('          got:    ' + JSON.stringify(got));
    console.log('          wanted: ' + JSON.stringify(want));
    fail++;
  }
};

/* ---------- the stand-in for Stripe ---------- */
function makeFakeStripe() {
  const fake = {
    sentToStripe: null,          // what we asked Stripe to create
    replyWith: null,             // what Stripe should say on the way back
    checkout: {
      sessions: {
        create: async (payload) => {
          fake.sentToStripe = payload;
          return { id: 'cs_test_session_1', url: 'https://checkout.stripe.com/pay/cs_test_session_1' };
        },
        retrieve: async (id) => {
          if (!fake.replyWith) throw new Error('test did not set a reply');
          return { id, ...fake.replyWith };
        },
      },
    },
  };
  return fake;
}

(async () => {
  await db.init();

  console.log('\n0. THE APP IS IN STRIPE MODE');
  check('payment mode is stripe', config.paymentMode, 'stripe');
  check('payments module agrees', payments.isStripe(), true);

  /* ---------- something to pay for ---------- */
  const hash = await auth.hashPassword('supersecret123');
  const vendor = await db.one(
    `insert into vendors (email, password_hash, business_name, category_id, price_from_cents)
     values ('v@test.com',$1,'Golden Hour Photography',
             (select id from categories where slug='photography'), 180000)
     returning id`, [hash]);
  const customer = await db.one(
    `insert into customers (email,name) values ('buyer@test.com','Avery Chen') returning id`);

  const token = payments.newToken();
  const booking = await db.one(
    `insert into bookings (vendor_id, customer_id, event_type, details, status,
                           quoted_amount_cents, public_token)
     values ($1,$2,'Wedding','Full day','quoted',260000,$3) returning id`,
    [vendor.id, customer.id, token]);

  const fake = makeFakeStripe();
  payments._useStripeClient(fake);

  console.log('\n1. WHAT WE SEND TO STRIPE');
  const started = await payments.startStripeCheckout(token, 'https://app.eventvendora.com');
  check('we get a Stripe address back', started.redirectTo, 'https://checkout.stripe.com/pay/cs_test_session_1');

  const sent = fake.sentToStripe;
  const line = sent.line_items[0];
  check('it is a one-off payment',          sent.mode, 'payment');
  check('the amount is in whole cents',     line.price_data.unit_amount, 260000);
  check('  ...matching the quote exactly',  line.price_data.unit_amount, booking.quoted_amount_cents ?? 260000);
  check('currency is dollars',              line.price_data.currency, 'usd');
  check('quantity is one',                  line.quantity, 1);
  check('the booking is named for Stripe',  line.price_data.product_data.name, 'Golden Hour Photography - booking #' + booking.id);
  check('the session is tied to OUR booking', sent.client_reference_id, String(booking.id));
  check('the customer email is passed on',  sent.customer_email, 'buyer@test.com');
  check('success sends them back to us',    sent.success_url,
        'https://app.eventvendora.com/booking/' + token + '/paid?session_id={CHECKOUT_SESSION_ID}');
  check('cancel sends them back too',       sent.cancel_url,
        'https://app.eventvendora.com/booking/' + token);
  check('no card details pass through us',  JSON.stringify(sent).includes('card_number'), false);

  console.log('\n2. WE DO NOT BELIEVE THE BROWSER');

  const stillUnpaid = async () => (await db.one('select status from bookings where id=$1', [booking.id])).status;

  fake.replyWith = { payment_status: 'unpaid', client_reference_id: String(booking.id), amount_total: 260000 };
  check('an unpaid session is refused',
        (await payments.finishStripeCheckout(token, 'cs_test_session_1')).error,
        'Stripe says that payment did not complete.');
  check('  ...and the booking is untouched', await stillUnpaid(), 'quoted');

  fake.replyWith = { payment_status: 'paid', client_reference_id: '99999', amount_total: 260000 };
  check('a session for another booking is refused',
        (await payments.finishStripeCheckout(token, 'cs_test_session_1')).error,
        'That payment belongs to a different booking.');
  check('  ...and the booking is untouched', await stillUnpaid(), 'quoted');

  fake.replyWith = { payment_status: 'paid', client_reference_id: String(booking.id), amount_total: 100 };
  check('paying $1 for a $2,600 job is refused',
        (await payments.finishStripeCheckout(token, 'cs_test_session_1')).error,
        'The amount paid does not match the price. Nothing has been changed.');
  check('  ...and the booking is untouched', await stillUnpaid(), 'quoted');

  check('a made-up session id is refused',
        (await payments.finishStripeCheckout(token, 'not-a-session-id')).error,
        'That payment could not be checked. Please try again.');
  check('an empty session id is refused',
        (await payments.finishStripeCheckout(token, '')).error,
        'That payment could not be checked. Please try again.');
  check('a wrong booking link is refused',
        (await payments.findByToken('deadbeef'.repeat(6)) === null), true);

  console.log('\n3. A GENUINE PAYMENT');
  fake.replyWith = { payment_status: 'paid', client_reference_id: String(booking.id), amount_total: 260000 };
  const done = await payments.finishStripeCheckout(token, 'cs_test_session_1');
  check('it is accepted', done.ok, true);
  check('the booking is now paid', await stillUnpaid(), 'paid');

  const row = await db.one(
    `select amount_cents, fee_cents, vendor_payout_cents, status, provider, provider_ref
       from payments where booking_id=$1`, [booking.id]);
  check('the amount is recorded',        row.amount_cents, 260000);
  check('the 10% fee is recorded',       row.fee_cents, 26000);
  check('the vendor share is recorded',  row.vendor_payout_cents, 234000);
  check('fee + share = amount exactly',  row.fee_cents + row.vendor_payout_cents, row.amount_cents);
  check('it is marked paid',             row.status, 'paid');
  check('it is marked as Stripe',        row.provider, 'stripe');
  check('the Stripe id is kept',         row.provider_ref, 'cs_test_session_1');

  console.log('\n4. THE SAME PAYMENT CANNOT COUNT TWICE');
  const replay = await payments.finishStripeCheckout(token, 'cs_test_session_1');
  check('replaying the link is refused', replay.error, 'This booking has already been paid for.');
  const howMany = await db.one('select count(*)::int n from payments where booking_id=$1', [booking.id]);
  check('still only one payment recorded', howMany.n, 1);

  console.log('\n================================');
  console.log(` PASSED: ${pass}    FAILED: ${fail}`);
  console.log('================================');
  console.log(' Stripe itself was stood in for. The live path needs real');
  console.log(' test keys to confirm end to end.');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
