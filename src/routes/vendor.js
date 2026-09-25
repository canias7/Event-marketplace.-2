/* ===================================================================
   VENDOR PAGES - signup, login, logout, dashboard.
   =================================================================== */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { handle } = require('../handle');

const router = express.Router();

const listCategories = () => db.query('select id, name from categories order by name').then(r => r.rows);

/* ---------------- SIGN UP ---------------- */

router.get('/signup', handle(async (req, res) => {
  res.render('vendor/signup', {
    title: 'Create a vendor account',
    categories: await listCategories(),
    form: {},
  });
}));

router.post('/signup', handle(async (req, res) => {
  const result = await auth.signUpVendor(req.body);

  if (result.error) {
    // Send back what they typed so they don't lose it. Never the password.
    const form = { ...req.body };
    delete form.password;
    return res.status(400).render('vendor/signup', {
      title: 'Create a vendor account',
      categories: await listCategories(),
      error: result.error,
      form,
    });
  }

  // Start a brand new session on login so an old session id can't be reused.
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.vendorId = result.vendor.id;
    res.redirect('/vendor');
  });
}));

/* ---------------- LOG IN ---------------- */

router.get('/login', (req, res) => {
  res.render('vendor/login', { title: 'Vendor login', form: {} });
});

router.post('/login', handle(async (req, res) => {
  const { email, password } = req.body;
  const result = await auth.logInVendor(email, password);

  if (result.error) {
    return res.status(401).render('vendor/login', {
      title: 'Vendor login',
      error: result.error,
      form: { email: auth.cleanEmail(email) },
    });
  }

  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.vendorId = result.user.id;
    res.redirect('/vendor');
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ---------------- DASHBOARD (login required) ---------------- */

router.get('/', auth.requireVendor, handle(auth.loadVendor), (req, res) => {
  res.render('vendor/dashboard', { title: 'My dashboard', vendor: req.vendor });
});

module.exports = router;
