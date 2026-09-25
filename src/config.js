/* ===================================================================
   SETTINGS - read once when the app starts.

   This file also contains the SAFETY GUARD that stops a real
   ("live") Stripe key from ever being used. See below.
   =================================================================== */

require('dotenv').config();

const stop = (title, lines) => {
  console.error('\n' + '='.repeat(62));
  console.error('REFUSING TO START: ' + title);
  console.error('='.repeat(62));
  for (const l of lines) console.error('  ' + l);
  console.error('='.repeat(62) + '\n');
  process.exit(1);
};

/* -------------------------------------------------------------------
   PAYMENTS - the guard.

   The Stripe account being used belongs to a real, live business, so
   this check is a safety feature, not a convenience. Do not weaken it.

     no keys            -> "pretend" mode, nothing leaves the app
     sk_test_ / pk_test_ -> real Stripe TEST mode, fake cards only
     anything else       -> the app refuses to start
   ------------------------------------------------------------------- */
const stripeSecret = (process.env.STRIPE_SECRET_KEY || '').trim();
const stripePublic = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();

// Show enough of a key to identify it, never enough to use it.
const peek = (k) => (k ? k.slice(0, 8) + '...' : '(empty)');

let paymentMode;

if (!stripeSecret && !stripePublic) {
  paymentMode = 'pretend';
} else {
  const problems = [];

  if (!stripeSecret) problems.push('STRIPE_SECRET_KEY is empty, but a publishable key was set.');
  else if (!stripeSecret.startsWith('sk_test_'))
    problems.push(`STRIPE_SECRET_KEY starts with "${peek(stripeSecret)}" - it must start with "sk_test_".`);

  if (!stripePublic) problems.push('STRIPE_PUBLISHABLE_KEY is empty, but a secret key was set.');
  else if (!stripePublic.startsWith('pk_test_'))
    problems.push(`STRIPE_PUBLISHABLE_KEY starts with "${peek(stripePublic)}" - it must start with "pk_test_".`);

  if (problems.length) {
    stop('Stripe keys are not TEST keys', [
      ...problems,
      '',
      'This app only accepts Stripe TEST keys, because the Stripe account',
      'is shared with a real business. A live key could move real money,',
      'so the app will not run with one.',
      '',
      'Fix: open .env and use the keys from Stripe\'s TEST mode',
      '(turn on "Test mode" in the Stripe dashboard, then Developers > API keys).',
      '',
      'Or leave both keys empty to run in pretend-payment mode.',
    ]);
  }
  paymentMode = 'stripe';
}

/* -------------------------------------------------------------------
   LOGIN COOKIES - signed with a secret so nobody can forge one.
   Fine to auto-generate while developing. Never in production: the
   secret would change on every restart and log everyone out.
   ------------------------------------------------------------------- */
const isProduction = process.env.NODE_ENV === 'production';
const placeholder = 'change-me-to-something-long-and-random';
let sessionSecret = (process.env.SESSION_SECRET || '').trim();

if (!sessionSecret || sessionSecret === placeholder) {
  if (isProduction) {
    stop('SESSION_SECRET is not set', [
      'Login cookies are signed with this. Without a real one, anyone',
      'could forge a login.',
      '',
      'Fix: put a long random value in .env as SESSION_SECRET.',
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    ]);
  }
  sessionSecret = require('crypto').randomBytes(32).toString('hex');
}

/* -------------------------------------------------------------------
   THE PLATFORM FEE - what the marketplace keeps from each booking.
   ------------------------------------------------------------------- */
const feePercent = Number(process.env.PLATFORM_FEE_PERCENT ?? 10);
if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 100) {
  stop('PLATFORM_FEE_PERCENT is not a sensible number', [
    `Got "${process.env.PLATFORM_FEE_PERCENT}". It must be between 0 and 100.`,
  ]);
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  isProduction,
  databaseUrl: (process.env.DATABASE_URL || '').trim(),
  sessionSecret,
  feePercent,
  paymentMode,                 // 'pretend' or 'stripe'
  stripeSecret,
  stripePublic,
};
