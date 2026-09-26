/* ===================================================================
   PUBLIC PAGES - anyone can see these, no login.

   A note on the two similar-looking addresses:
     /vendor/...     = "me, the logged-in vendor"  (see routes/vendor.js)
     /vendors/123    = "a vendor I am looking at"  (this file)

   Every page here is wrapped in handle() - see src/handle.js.
   =================================================================== */

const express = require('express');
const db = require('../db');
const { handle } = require('../handle');
const { findPublicVendor, requestBooking } = require('../bookings');
const payments = require('../payments');

const router = express.Router();

/* The columns we show on a listing. Never the vendor's email - that
   would hand every vendor's address to anyone who visits. */
const LISTING_COLUMNS = `
  v.id, v.business_name, v.city, v.description, v.price_from_cents,
  c.name as category_name, c.slug as category_slug`;

/* ---------------- HOME ---------------- */

router.get('/', handle(async (req, res) => {
  const categories = await db.query(
    `select c.id, c.slug, c.name,
            count(v.id) filter (where v.is_active)::int as vendor_count
       from categories c
       left join vendors v on v.category_id = c.id
      group by c.id
      order by c.name`
  );
  res.render('home', { title: 'Find event vendors', categories: categories.rows });
}));

/* ---------------- BROWSE EVERYTHING ---------------- */

router.get('/browse', handle(async (req, res) => {
  const vendors = await db.query(
    `select ${LISTING_COLUMNS}
       from vendors v join categories c on c.id = v.category_id
      where v.is_active
      order by v.business_name`
  );
  res.render('browse', {
    title: 'All vendors',
    heading: 'All vendors',
    blurb: 'Every vendor on the marketplace.',
    vendors: vendors.rows,
    showCategory: true,
  });
}));

/* ---------------- BROWSE ONE CATEGORY ---------------- */

router.get('/browse/:slug', handle(async (req, res) => {
  const category = await db.one('select * from categories where slug = $1', [req.params.slug]);
  if (!category) return res.status(404).render('not-found', { title: 'Not found' });

  const vendors = await db.query(
    `select ${LISTING_COLUMNS}
       from vendors v join categories c on c.id = v.category_id
      where v.is_active and v.category_id = $1
      order by v.business_name`,
    [category.id]
  );

  res.render('browse', {
    title: category.name,
    heading: category.name,
    blurb: category.description,
    vendors: vendors.rows,
    showCategory: false,
  });
}));

/* ---------------- ONE VENDOR, WITH THE REQUEST FORM ---------------- */

router.get('/vendors/:id', handle(async (req, res) => {
  const vendor = await findPublicVendor(req.params.id);
  if (!vendor) return res.status(404).render('not-found', { title: 'Vendor not found' });

  res.render('vendor-profile', { title: vendor.business_name, vendor, form: {} });
}));

router.post('/vendors/:id/request', handle(async (req, res) => {
  const result = await requestBooking(req.params.id, req.body);

  if (result.error) {
    const vendor = await findPublicVendor(req.params.id);
    if (!vendor) return res.status(404).render('not-found', { title: 'Vendor not found' });
    return res.status(400).render('vendor-profile', {
      title: vendor.business_name,
      vendor,
      error: result.error,
      form: req.body,          // give them back what they typed
    });
  }

  /* Remember the booking on the session rather than putting its number
     in the address bar. Booking numbers run 1, 2, 3..., so a visitor
     could otherwise change the number and read someone else's request. */
  req.session.lastBooking = {
    id: result.booking.id,
    token: result.booking.token,
    vendorName: result.booking.vendor.business_name,
  };
  res.redirect('/request-sent');
}));

router.get('/request-sent', (req, res) => {
  const sent = req.session.lastBooking;
  if (!sent) return res.redirect('/');
  res.render('request-sent', { title: 'Request sent', sent });
});

/* ===================================================================
   THE CUSTOMER'S OWN BOOKING PAGE

   Reached by the long random link in /booking/<token>. No login: the
   link IS the proof, which is why it has to be unguessable.
   =================================================================== */

router.get('/booking/:token', handle(async (req, res) => {
  const booking = await payments.findByToken(req.params.token);
  if (!booking) return res.status(404).render('not-found', { title: 'Booking not found' });

  res.render('booking', { title: 'Your booking', booking, usingStripe: payments.isStripe() });
}));

/* The Pay button. Which of the two things happens depends only on
   whether a Stripe test key was set when the app started. */
router.post('/booking/:token/pay', handle(async (req, res) => {
  const token = req.params.token;

  if (payments.isStripe()) {
    const origin = `${req.protocol}://${req.get('host')}`;
    const started = await payments.startStripeCheckout(token, origin);
    if (started.error) {
      req.session.flash = { error: started.error };
      return res.redirect('/booking/' + token);
    }
    return res.redirect(started.redirectTo);
  }

  const paid = await payments.payPretend(token);
  req.session.flash = paid.error ? { error: paid.error } : { ok: 'Payment received. Thank you!' };
  res.redirect('/booking/' + token);
}));

/* Where Stripe sends the customer back to. We ask Stripe whether the
   payment really happened rather than believing the browser. */
router.get('/booking/:token/paid', handle(async (req, res) => {
  const token = req.params.token;
  const done = await payments.finishStripeCheckout(token, req.query.session_id);
  req.session.flash = done.error ? { error: done.error } : { ok: 'Payment received. Thank you!' };
  res.redirect('/booking/' + token);
}));

module.exports = router;
