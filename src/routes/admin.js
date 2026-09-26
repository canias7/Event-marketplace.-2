/* ===================================================================
   ADMIN PAGES - login, logout, overview of everything.
   =================================================================== */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { handle } = require('../handle');

const router = express.Router();

router.get('/login', handle(async (req, res) => {
  // If no admin exists yet, tell them how to make one.
  const any = await db.one('select id from admins limit 1');
  res.render('admin/login', { title: 'Admin login', form: {}, noAdminYet: !any });
}));

router.post('/login', handle(async (req, res) => {
  const { email, password } = req.body;
  const result = await auth.logInAdmin(email, password);

  if (result.error) {
    const any = await db.one('select id from admins limit 1');
    return res.status(401).render('admin/login', {
      title: 'Admin login',
      error: result.error,
      form: { email: auth.cleanEmail(email) },
      noAdminYet: !any,
    });
  }

  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.adminId = result.user.id;
    res.redirect('/admin');
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/', auth.requireAdmin, handle(async (req, res) => {
  const countOf = async (table) =>
    (await db.one(`select count(*)::int as n from ${table}`)).n;

  const vendors = await db.query(
    `select v.*, c.name as category_name
       from vendors v join categories c on c.id = v.category_id
      order by v.created_at desc limit 100`
  );

  /* The money. sum() returns a bigint, which arrives as text, so each
     one is turned back into a number here. */
  const totals = await db.one(
    `select coalesce(sum(amount_cents),0)::bigint        as taken,
            coalesce(sum(fee_cents),0)::bigint           as fees,
            coalesce(sum(vendor_payout_cents),0)::bigint as owed_to_vendors
       from payments where status = 'paid'`
  );

  const money = {
    taken:         Number(totals.taken),
    fees:          Number(totals.fees),
    owedToVendors: Number(totals.owed_to_vendors),
  };

  const recentPayments = await db.query(
    `select p.amount_cents, p.fee_cents, p.vendor_payout_cents, p.status, p.provider,
            p.created_at, p.booking_id, v.business_name as vendor_name
       from payments p
       join bookings b on b.id = p.booking_id
       join vendors v on v.id = b.vendor_id
      order by p.created_at desc limit 25`
  );

  res.render('admin/dashboard', {
    title: 'Admin',
    counts: {
      vendors:   await countOf('vendors'),
      customers: await countOf('customers'),
      bookings:  await countOf('bookings'),
      payments:  await countOf('payments'),
    },
    vendors: vendors.rows,
    totals: money,
    recentPayments: recentPayments.rows,
    paymentMode: require('../config').paymentMode,
  });
}));

module.exports = router;
