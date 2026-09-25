/* ===================================================================
   LOGINS - passwords, sessions, and "who is allowed in here".

   How a password is stored:
   We never save the password itself. We save a scrambled version
   called a "hash". Scrambling only works one way, so even someone
   holding our whole database cannot read anyone's password.

   When someone logs in we scramble what they typed and compare the
   two scrambles.
   =================================================================== */

const bcrypt = require('bcryptjs');
const db = require('./db');

const SCRAMBLE_ROUNDS = 10;   // higher = slower to crack, slower to log in

/* A throwaway hash. Used to keep the timing of a failed login the same
   whether the email exists or not - otherwise someone could work out
   which emails are registered by watching how fast we say no. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SCRAMBLE_ROUNDS);

const hashPassword  = (plain) => bcrypt.hash(plain, SCRAMBLE_ROUNDS);
const checkPassword = (plain, hash) => bcrypt.compare(plain, hash || DUMMY_HASH);


/* -------------------------------------------------------------------
   CHECKING WHAT THE USER TYPED
   ------------------------------------------------------------------- */
const cleanEmail = (e) => String(e || '').trim().toLowerCase();

function emailProblem(email) {
  if (!email) return 'Please enter your email address.';
  if (email.length > 254) return 'That email address is too long.';
  // Good enough: something, an @, something, a dot, something.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That does not look like an email address.';
  return null;
}

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Your password must be at least 8 characters.';
  if (p.length > 200) return 'That password is too long.';
  return null;
}


/* -------------------------------------------------------------------
   SLOWING DOWN PASSWORD GUESSING

   Counts failed logins per email address. After 8 failures it refuses
   to try for 15 minutes, so nobody can sit there guessing passwords.

   Kept in memory, so it resets when the app restarts. Fine for now;
   for real traffic this would move into the database.
   ------------------------------------------------------------------- */
const MAX_TRIES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map();

function lockoutMinutesLeft(key) {
  const rec = failures.get(key);
  if (!rec) return 0;
  if (Date.now() - rec.firstAt > LOCKOUT_MS) { failures.delete(key); return 0; }
  if (rec.count < MAX_TRIES) return 0;
  return Math.ceil((LOCKOUT_MS - (Date.now() - rec.firstAt)) / 60000);
}

function recordFailure(key) {
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.firstAt > LOCKOUT_MS) failures.set(key, { count: 1, firstAt: Date.now() });
  else rec.count++;
}

const clearFailures = (key) => failures.delete(key);


/* -------------------------------------------------------------------
   SIGNING UP A VENDOR
   Returns { vendor } on success, or { error } with a message to show.
   ------------------------------------------------------------------- */
async function signUpVendor({ email, password, businessName, categoryId, city, phone, description, priceFrom }) {
  email = cleanEmail(email);

  const problem = emailProblem(email) || passwordProblem(password);
  if (problem) return { error: problem };

  businessName = String(businessName || '').trim();
  if (!businessName) return { error: 'Please enter your business name.' };
  if (businessName.length > 120) return { error: 'That business name is too long.' };

  const category = await db.one('select id from categories where id = $1', [Number(categoryId) || 0]);
  if (!category) return { error: 'Please choose a category.' };

  // "price from" is typed in dollars but stored in whole cents.
  const dollars = Number(String(priceFrom ?? '').replace(/[^0-9.]/g, '')) || 0;
  if (dollars < 0 || dollars > 10_000_000) return { error: 'That starting price is not a sensible number.' };
  const priceFromCents = Math.round(dollars * 100);

  const taken = await db.one('select id from vendors where email = $1', [email]);
  if (taken) return { error: 'An account with that email already exists.' };

  const passwordHash = await hashPassword(password);

  try {
    const vendor = await db.one(
      `insert into vendors (email, password_hash, business_name, category_id, city, phone, description, price_from_cents)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, email, business_name, category_id`,
      [email, passwordHash, businessName, category.id,
       String(city || '').trim().slice(0, 120),
       String(phone || '').trim().slice(0, 40),
       String(description || '').trim().slice(0, 2000),
       priceFromCents]
    );
    return { vendor };
  } catch (err) {
    // Covers the rare case where two people sign up with the same email
    // at the same instant and both passed the check above.
    if (err.code === '23505' || /unique/i.test(err.message)) {
      return { error: 'An account with that email already exists.' };
    }
    throw err;
  }
}


/* -------------------------------------------------------------------
   LOGGING IN

   Note the error message is identical for "no such email" and "wrong
   password". Telling them apart would let someone discover which
   emails are registered.
   ------------------------------------------------------------------- */
const WRONG = 'Email or password is incorrect.';

async function logIn(table, email, password) {
  email = cleanEmail(email);
  if (!email || !password) return { error: WRONG };

  const key = table + ':' + email;
  const wait = lockoutMinutesLeft(key);
  if (wait) return { error: `Too many failed attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` };

  const row = await db.one(`select * from ${table} where email = $1`, [email]);
  const ok = await checkPassword(password, row && row.password_hash);

  if (!row || !ok) { recordFailure(key); return { error: WRONG }; }
  if (table === 'vendors' && row.is_active === false) {
    return { error: 'This account has been deactivated. Please contact support.' };
  }

  clearFailures(key);
  return { user: row };
}

const logInVendor = (email, password) => logIn('vendors', email, password);
const logInAdmin  = (email, password) => logIn('admins',  email, password);


/* -------------------------------------------------------------------
   WHO IS LOGGED IN

   Vendor and admin logins are stored in two different places on the
   session, so a vendor can never accidentally count as an admin.
   ------------------------------------------------------------------- */
function requireVendor(req, res, next) {
  if (!req.session.vendorId) return res.redirect('/vendor/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.redirect('/admin/login');
  next();
}

/* Loads the logged-in vendor's details and attaches them to the
   request, so pages can say "Hello, Sam's Photography". */
async function loadVendor(req, res, next) {
  req.vendor = await db.one(
    `select v.*, c.name as category_name, c.slug as category_slug
       from vendors v join categories c on c.id = v.category_id
      where v.id = $1`,
    [req.session.vendorId]
  );
  if (!req.vendor) { req.session.destroy(() => res.redirect('/vendor/login')); return; }
  next();
}

module.exports = {
  hashPassword, checkPassword,
  cleanEmail, emailProblem, passwordProblem,
  signUpVendor, logInVendor, logInAdmin,
  requireVendor, requireAdmin, loadVendor,
};
