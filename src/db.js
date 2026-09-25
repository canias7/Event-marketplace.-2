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

let client = null;
let backend = null;              // 'neon' or 'local'

const SQL_DIR = path.join(__dirname, '..', 'db');
const readSql = (f) => fs.readFileSync(path.join(SQL_DIR, f), 'utf8');

/* Strips the password out of a connection string so we can safely
   print where we connected without leaking the credentials. */
function safeHost(url) {
  try { return new URL(url).host; } catch { return '(unreadable connection string)'; }
}

async function connect() {
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    client = new Pool({ connectionString: config.databaseUrl });
    try {
      await client.query('select 1');
    } catch (err) {
      console.error('\n' + '='.repeat(62));
      console.error('CANNOT REACH THE DATABASE');
      console.error('='.repeat(62));
      console.error('  Tried to connect to: ' + safeHost(config.databaseUrl));
      console.error('  Postgres said: ' + err.message);
      console.error('');
      console.error('  Check DATABASE_URL in your .env file. Neon strings must');
      console.error('  end with ?sslmode=require');
      console.error('='.repeat(62) + '\n');
      process.exit(1);
    }
    backend = 'neon';
    console.log('DATABASE: Neon at ' + safeHost(config.databaseUrl));
  } else {
    const dir = localDir();
    claimLocalDatabase(dir);
    const { PGlite } = await import('@electric-sql/pglite');
    client = await PGlite.create(dir);
    backend = 'local';
    console.log('DATABASE: local folder ' + path.relative(process.cwd(), dir) + '  (no Neon needed)');
    console.log('          Data survives restarts. Delete the folder to start over.');
  }
}

/* -------------------------------------------------------------------
   THE LOCAL DATABASE CAN ONLY BE OPENED BY ONE PROGRAM AT A TIME.

   It is not a server - it is a database built into the program itself.
   So if the app is running and you also run "npm run create-admin",
   the second one writes to its own stale copy and its changes are
   silently lost.

   To stop that happening we leave a note in the folder saying which
   program is using it, and refuse to open it twice.

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

/* Runs a whole .sql file. The two database drivers want this done
   slightly differently, which is the only place they differ. */
async function runFile(file) {
  const sql = readSql(file);
  if (backend === 'neon') await client.query(sql);
  else await client.exec(sql);
}

/* Creates any missing tables and adds the categories.
   Safe to run every startup - everything in those files is written as
   "only if it does not already exist". */
async function ensureTables() {
  await runFile('schema.sql');
  await runFile('seed.sql');
}

/* The one function the rest of the app uses.
   Always pass values as $1, $2 ... never glue them into the SQL text -
   that is how SQL injection attacks get in. */
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

async function init() {
  await connect();
  await ensureTables();
}

module.exports = { init, query, one, get backend() { return backend; } };
