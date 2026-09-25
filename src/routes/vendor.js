/* ===================================================================
   VENDOR PAGES - signup, login, and the CRM.

   Every page that waits on the database is wrapped in handle().
   See src/handle.js for why that is not optional.
   =================================================================== */

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const crm = require('../crm');
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

/* ===================================================================
   EVERYTHING BELOW NEEDS A LOGIN.

   requireVendor bounces anyone not logged in. loadVendor then puts
   their details on req.vendor. From here on, req.vendor.id is the only
   vendor id we ever trust - never one taken from the address bar.
   =================================================================== */

router.use(auth.requireVendor, handle(auth.loadVendor));

/* ---------------- THE CRM ---------------- */

router.get('/', handle(async (req, res) => {
  const status = req.query.status || '';

  res.render('vendor/crm', {
    title: 'My leads',
    vendor: req.vendor,
    counts: await crm.pipelineCounts(req.vendor.id),
    leads: await crm.listLeads(req.vendor.id, status),
    activeStatus: crm.PIPELINE.includes(status) ? status : '',
    pipeline: crm.PIPELINE,
    labels: crm.STATUS_LABELS,
  });
}));

/* ---------------- ONE LEAD ---------------- */

router.get('/leads/:id', handle(async (req, res) => {
  const lead = await crm.getLead(req.vendor.id, req.params.id);
  if (!lead) return res.status(404).render('not-found', { title: 'Lead not found' });

  res.render('vendor/lead', {
    title: 'Lead #' + lead.id,
    vendor: req.vendor,
    lead,
    labels: crm.STATUS_LABELS,
  });
}));

/* The three things a vendor does to a lead. Each one reports back with
   a short message on the next page, kept on the session. */
const report = (req, res, result, leadId) => {
  req.session.flash = result.error ? { error: result.error } : { ok: result.ok };
  res.redirect('/vendor/leads/' + leadId);
};

router.post('/leads/:id/quote', handle(async (req, res) => {
  report(req, res, await crm.setQuote(req.vendor.id, req.params.id, req.body.price), req.params.id);
}));

router.post('/leads/:id/status', handle(async (req, res) => {
  report(req, res, await crm.setStatus(req.vendor.id, req.params.id, req.body.status), req.params.id);
}));

router.post('/leads/:id/note', handle(async (req, res) => {
  report(req, res, await crm.addNote(req.vendor.id, req.params.id, req.body.body), req.params.id);
}));

/* ---------------- THEIR ACCOUNT ---------------- */

router.get('/account', (req, res) => {
  res.render('vendor/account', { title: 'My account', vendor: req.vendor });
});

module.exports = router;
