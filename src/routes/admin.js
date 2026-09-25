/* ===================================================================
   ADMIN PAGES - login, logout, overview of everything.
   =================================================================== */

const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

router.get('/login', async (req, res) => {
  // If no admin exists yet, tell them how to make one.
  const any = await db.one('select id from admins limit 1');
  res.render('admin/login', { title: 'Admin login', form: {}, noAdminYet: !any });
});

router.post('/login', async (req, res) => {
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
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/', auth.requireAdmin, async (req, res) => {
  const countOf = async (table) =>
    (await db.one(`select count(*)::int as n from ${table}`)).n;

  const vendors = await db.query(
    `select v.*, c.name as category_name
       from vendors v join categories c on c.id = v.category_id
      order by v.created_at desc limit 100`
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
  });
});

module.exports = router;
