/* ===================================================================
   THE WEB SERVER - starts everything up.

   Order of events when you run "npm start":
     1. read settings from .env  (and refuse to start on a live Stripe key)
     2. connect to the database, creating any missing tables
     3. start listening for browser requests
   =================================================================== */

const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const db = require('./db');
const { money } = require('./money');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Reads submitted form fields into req.body.
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Remembers who is logged in, using a signed cookie.
app.use(session({
  name: 'eventvendora.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                 // JavaScript in the page cannot read it
    sameSite: 'lax',                // blocks other websites posting our forms
    secure: config.isProduction,    // only send over https in production
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

/* Values every page can use without each route passing them in. */
app.use(async (req, res, next) => {
  res.locals.title = 'Event Vendora';
  res.locals.error = null;
  res.locals.notice = null;
  res.locals.form = {};
  res.locals.money = money;
  res.locals.paymentMode = config.paymentMode;
  res.locals.dbBackend = db.backend;
  res.locals.currentVendor = null;
  if (req.session.vendorId) {
    res.locals.currentVendor = await db.one(
      'select id, business_name from vendors where id = $1', [req.session.vendorId]
    );
  }
  next();
});

app.use('/', require('./routes/public'));
app.use('/vendor', require('./routes/vendor'));
app.use('/admin', require('./routes/admin'));

/* Page not found. */
app.use((req, res) => {
  res.status(404).send('<h1>404 - page not found</h1><p><a href="/">Go home</a></p>');
});

/* Something broke. Log the real reason for us, show the visitor
   something harmless - error details can leak how the app works. */
app.use((err, req, res, next) => {
  console.error('ERROR on ' + req.method + ' ' + req.originalUrl + ':', err);
  res.status(500).send('<h1>Something went wrong</h1><p><a href="/">Go home</a></p>');
});

async function start() {
  console.log('');
  console.log('PAYMENTS: ' + (config.paymentMode === 'pretend'
    ? 'pretend mode (no Stripe key set - nothing leaves the app)'
    : 'Stripe TEST mode'));

  await db.init();

  app.listen(config.port, () => {
    console.log('');
    console.log('Ready. Open http://localhost:' + config.port);
    console.log('');
  });
}

start();
