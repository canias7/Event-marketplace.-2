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

/* ---------------------------------------------------------------
   WHERE LOGINS ARE REMEMBERED

   The cookie in the browser only holds a reference. The actual "this
   person is logged in" record is kept here.

   On Neon it goes in the database, so restarting or redeploying the app
   does NOT log everybody out, and several copies of the app can share
   one set of logins.

   On the local database it stays in memory, because the local database
   can only be opened by one program and the session library needs its
   own connection. That means a restart logs you out while developing,
   which is a fair trade for needing no setup.
   --------------------------------------------------------------- */
let sessionStore;                       // undefined = keep it in memory

if (config.databaseUrl) {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({
    conString: config.databaseUrl,
    createTableIfMissing: true,
    tableName: 'user_sessions',
    pruneSessionInterval: 60 * 60,      // tidy up expired logins hourly
  });
  sessionStore.on('error', (err) => console.error('SESSION STORE PROBLEM:', err.message));
  console.log('LOGINS: kept in the database');
} else {
  console.log('LOGINS: kept in memory (a restart logs everyone out)');
}

/* Storing logins in the database only helps if the cookies can still be
   checked afterwards. They are checked against SESSION_SECRET, so a
   throwaway secret undoes the whole thing - quietly, which is worse. */
if (config.sessionSecretIsTemporary) {
  console.log('        ...but SESSION_SECRET is not set, so a new one is made each');
  console.log('        startup and a restart still logs everyone out.');
  console.log('        Put a long random value in .env as SESSION_SECRET to stop that.');
  console.log('        Generate one:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

// Remembers who is logged in, using a signed cookie.
app.use(session({
  name: 'eventvendora.sid',
  store: sessionStore,
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
  /* A one-off message left over from the last page, e.g. "Quote sent".
     Read it, then clear it, so it shows exactly once. */
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  res.locals.currentVendor = null;
  if (req.session.vendorId) {
    res.locals.currentVendor = await db.one(
      'select id, business_name from vendors where id = $1', [req.session.vendorId]
    );
  }
  next();
});

/* A page for the hosting service to check, rather than a person. It
   answers "am I well?" including whether the database is reachable.
   Deliberately says nothing else - it is public. */
app.get('/healthz', async (req, res) => {
  const dbOk = await db.healthy();
  res.status(dbOk ? 200 : 503).type('text').send(dbOk ? 'ok' : 'database unreachable');
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

/* LAST RESORT. Every page should be wrapped in handle() so its failures
   land on the error page above. If one ever slips through, Node's default
   is to shut the whole app down - which would log out every vendor over a
   single bad request. We log it loudly and keep serving instead. */
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROBLEM - a page was not wrapped in handle().');
  console.error('The app is still running, but this needs fixing:', reason);
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
