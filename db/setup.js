/* ===================================================================
   SETS UP THE DATABASE

   Creates any missing tables by running the migrations in order, then
   adds the 12 categories. Safe to run as many times as you like -
   anything already done is skipped.

   Works the same on Neon and on the local database.

   Usage:  npm run db:setup
           npm run db:setup -- --reset     (wipes everything first)
   =================================================================== */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const migrate = require('../src/migrate');

(async () => {
  const wipeFirst = process.argv.includes('--reset');

  if (wipeFirst) {
    if (!config.databaseUrl) {
      console.log('Wiping the local database (deleting its folder)...');
      const dir = process.env.LOCAL_DB_DIR || path.join(__dirname, '..', '.localdb');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dir.replace(/[\\/]+$/, '') + '.in-use-by-pid', { force: true });
    } else {
      console.log('Wiping every table...');
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
      await pool.query(fs.readFileSync(path.join(__dirname, 'reset.sql'), 'utf8'));
      await pool.end();
      console.log('  done');
    }
    console.log('');
  }

  /* Required after the wipe, so it picks up the now-empty database. */
  const db = require('../src/db');

  console.log('Applying migrations:');
  const before = Date.now();
  await db.init();
  console.log(`  finished in ${Date.now() - before}ms`);

  console.log('');
  console.log('What is in the database now:');
  const counts = await db.query(`
    select 'categories' as table_name, count(*)::int as rows from categories
    union all select 'vendors',   count(*)::int from vendors
    union all select 'admins',    count(*)::int from admins
    union all select 'customers', count(*)::int from customers
    union all select 'bookings',  count(*)::int from bookings
    union all select 'crm_notes', count(*)::int from crm_notes
    union all select 'payments',  count(*)::int from payments`);

  for (const row of counts.rows) {
    console.log('  ' + row.table_name.padEnd(12) + row.rows);
  }

  const applied = await db.query('select version from schema_migrations order by version');
  console.log('');
  console.log('Migrations applied:');
  for (const row of applied.rows) console.log('  ' + row.version);

  console.log('');
  console.log('Database is ready.');
  process.exit(0);
})().catch((err) => {
  console.error('\nSETUP FAILED\n');
  console.error(err.message);
  process.exit(1);
});
