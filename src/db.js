/* ===================================================================
   THE DATABASE CONNECTION

   This app can talk to two kinds of database, and the code above it
   never knows the difference:

     DATABASE_URL is set    -> your real Neon database
     DATABASE_URL is empty  -> a Postgres that lives in a folder on
                               this machine (.localdb), so the app
                               runs with no signup at all

   It is the SAME Postgres either way, so anything that works locally
   works on Neon. Switching is one line in .env.
   =================================================================== */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const migrate = require('./migrate');

let client = null;
let backend = null;              // 'neon' or 'local'

/* Strips the password out of a connection string so we can safely
   print where we connected without leaking the credentials. */
function safeHost(url) {
  try { return new URL(url).host; } catch { return '(unreadable connection string)'; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));


/* -------------------------------------------------------------------
   CONNECTING TO A REAL SERVER (Neon)

   Two things about Neon in particular:

   1. It goes to sleep when nobody is using it, to save you money. The
      first request after that has to wake it up, which takes a few
      seconds. So the first connection is retried rather than treated
      as a failure.

   2. It limits how many connections you may hold open. A pool is a
      small set of reusable connections - without a limit the app could
      open hundreds and be cut off.
   ------------------------------------------------------------------- */
async function connectToServer() {
  const { Pool } = require('pg');

  client = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,   // generous: Neon may be waking up
  });

  /* A connection sitting idle can fail on its own, for instance when
     Neon goes to sleep. Without this listener Node treats that as an
     unhandled error and shuts the app down. */
  client.on('error', (err) => {
    console.error('DATABASE CONNECTION DROPPED (a new one will be opened):', err.message);
  });

  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.query('select 1');
      backend = 'neon';
      console.log(`DATABASE: Neon at ${safeHost(config.databaseUrl)}  (up to ${config.dbPoolMax} connections)`);
      return;
    } catch (err) {
      if (attempt === attempts) {
        console.error('\n' + '='.repeat(62));
        console.error('CANNOT REACH THE DATABASE');
        console.error('='.repeat(62));
        console.error('  Tried to connect to: ' + safeHost(config.databaseUrl));
        console.error('  Gave up after ' + attempts + ' attempts.');
        console.error('  Postgres said: ' + err.message);
        console.error('');
        console.error('  Things to check in your .env file:');
        console.error('   - DATABASE_URL is the full string Neon gave you');
        console.error('   - you revealed the password before copying it');
        console.error('     (Neon hides it behind dots by default)');
        console.error('   - the string ends with ?sslmode=require');
        console.error('='.repeat(62) + '\n');
        process.exit(1);
      }
      const pause = attempt * 2000;
      console.log(`  database not answering yet (${err.message}) - waking it up, retrying in ${pause / 1000}s`);
      await wait(pause);
    }
  }
}


/* -------------------------------------------------------------------
   THE LOCAL DATABASE, AND WHY ONLY ONE PROGRAM MAY OPEN IT

   It is not a server - it is a database built into the program itself.
   So if the app is running and you also run "npm run create-admin",
   the second one writes to its own stale copy and its changes are
   silently lost.

   To stop that we leave a note saying which program is using it, and
   refuse to open it twice.

   None of this applies to Neon. Neon IS a server, so as many programs
   as you like can talk to it at once.
   ------------------------------------------------------------------- */
const localDir = () =>
  process.env.LOCAL_DB_DIR || path.join(__dirname, '..', '.localdb');

/* The note lives NEXT TO the database folder, never inside it - Postgres
   refuses to open a data folder that has unexpected files in it. */
const lockPath = (dir) => dir.replace(/[\\/]+$/, '') + '.in-use-by-pid';

/* Returns the pid using this folder, or null if nobody is. */
function currentHolder(dir) {
  try {
    const pid = Number(fs.readFileSync(lockPath(dir), 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0);       // throws if that program is gone
    return pid;
  } catch {
    return null;                // no note, or the program that left it has exited
  }
}

function claimLocalDatabase(dir) {
  const holder = currentHolder(dir);

  if (holder && holder !== process.pid) {
    console.error('\n' + '='.repeat(62));
    console.error('CANNOT OPEN THE LOCAL DATABASE');
    console.error('='.repeat(62));
    console.error('  Another program is already using it (process ' + holder + ').');
    console.error('  That is almost certainly the app itself, started with "npm start".');
    console.error('');
    console.error('  The local database is built into the program rather than');
    console.error('  being a separate server, so only one program can open it.');
    console.error('');
    console.error('  Fix: stop the app (press Ctrl+C in its window), run this');
    console.error('  command again, then start the app back up.');
    console.error('');
    console.error('  This limit does not exist on Neon. Neon is a real server, so');
    console.error('  you can run commands while the app is running.');
    console.error('='.repeat(62) + '\n');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(lockPath(dir)), { recursive: true });
  fs.writeFileSync(lockPath(dir), String(process.pid));

  /* Tidy the note away when we finish, however we finish. */
  const release = () => {
    try {
      if (fs.readFileSync(lockPath(dir), 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(lockPath(dir));
      }
    } catch { /* already gone */ }
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { release(); process.exit(0); });
  }
}

async function connectToLocal() {
  const dir = localDir();
  claimLocalDatabase(dir);
  const { PGlite } = await import('@electric-sql/pglite');
  client = await PGlite.create(dir);
  backend = 'local';
  console.log('DATABASE: local folder ' + path.relative(process.cwd(), dir) + '  (no Neon needed)');
  console.log('          Data survives restarts. Delete the folder to start over.');
}


/* -------------------------------------------------------------------
   RUNNING THE MIGRATIONS

   Migrations use transactions, and a transaction only covers statements
   sent down ONE connection. A pool hands out a different connection
   each time, so for Neon we borrow a single one and hold it until the
   migrations are done.
   ------------------------------------------------------------------- */
async function runMigrations() {
  if (backend === 'neon') {
    const single = await client.connect();
    try {
      await migrate.run({
        exec: (sql) => single.query(sql),
        query: (sql, values) => single.query(sql, values),
      });
    } finally {
      single.release();
    }
  } else {
    await migrate.run({
      exec: (sql) => client.exec(sql),
      query: (sql, values) => client.query(sql, values),
    });
  }
}

/* The category list. Separate from the migrations because it is data,
   not structure, and it is safe to re-apply. */
async function seedCategories() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  if (backend === 'neon') await client.query(sql);
  else await client.exec(sql);
}


/* -------------------------------------------------------------------
   WHAT THE REST OF THE APP USES

   Always pass values as $1, $2 ... never glue them into the SQL text -
   that is how SQL injection attacks get in.
   ------------------------------------------------------------------- */
async function query(sql, params = []) {
  const res = await client.query(sql, params);
  return {
    rows: res.rows || [],
    rowCount: res.rowCount ?? res.affectedRows ?? (res.rows || []).length,
  };
}

/* Shorthand for "give me one row or nothing". */
async function one(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

/* Used by the /healthz page so a host can tell whether we are well. */
async function healthy() {
  try {
    await client.query('select 1');
    return true;
  } catch {
    return false;
  }
}

async function init() {
  if (config.databaseUrl) await connectToServer();
  else await connectToLocal();

  await runMigrations();
  await seedCategories();
}

module.exports = { init, query, one, healthy, get backend() { return backend; } };
