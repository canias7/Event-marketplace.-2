/* ===================================================================
   CHECKS THE DATABASE IS SOUND - without needing Neon.

   Runs every migration against an in-memory copy of Postgres, then
   tries to store bad data and confirms the database refuses it.

   Run with: npm run db:check
   =================================================================== */

const fs = require('fs');
const path = require('path');
const migrate = require('../src/migrate');

let pass = 0, fail = 0;
const ok  = (what) => { console.log('  PASS  ' + what); pass++; };
const bad = (what, detail) => { console.log('  FAIL  ' + what + (detail ? '  -> ' + detail : '')); fail++; };

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  const runner = { exec: (sql) => db.exec(sql), query: (sql, v) => db.query(sql, v) };

  /* Confirms the database REFUSES something. A silent success is a failure. */
  const mustRefuse = async (what, sql, values) => {
    try { await db.query(sql, values); bad(what, 'it was accepted'); }
    catch { ok(what); }
  };

  console.log('\n1. RUNNING THE MIGRATIONS');
  const first = await migrate.run(runner, () => {});
  ok(`all ${first.total} migrations applied`);
  if (first.applied.length !== first.total) bad('every migration ran', `${first.applied.length} of ${first.total}`);
  else ok('none were skipped on a fresh database');

  console.log('\n2. RUNNING THEM AGAIN CHANGES NOTHING');
  const second = await migrate.run(runner, () => {});
  if (second.applied.length === 0) ok('nothing re-applied the second time');
  else bad('migrations re-ran', second.applied.join(', '));

  console.log('\n3. THE CATEGORIES');
  await db.exec(fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8'));
  const cats = await db.query('select slug from categories order by id');
  if (cats.rows.length === 12) ok('12 categories present');
  else bad('12 categories', 'found ' + cats.rows.length);
  await db.exec(fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8'));
  const again = await db.query('select count(*)::int as n from categories');
  if (again.rows[0].n === 12) ok('re-seeding makes no duplicates');
  else bad('re-seeding is safe', 'now ' + again.rows[0].n);

  console.log('\n4. STORING ONE OF EVERYTHING');
  const v = await db.query(
    `insert into vendors (email, password_hash, business_name, category_id, city, price_from_cents)
     values ('test@example.com','fake-hash','Test Photos',
             (select id from categories where slug='photography'), 'Austin', 150000)
     returning id`);
  const vendorId = v.rows[0].id;

  const c = await db.query(
    `insert into customers (email, name) values ('bride@example.com','Sam Rivera') returning id`);
  const customerId = c.rows[0].id;

  const b = await db.query(
    `insert into bookings (vendor_id, customer_id, event_date, event_type, guest_count,
                           details, status, quoted_amount_cents, public_token)
     values ($1,$2,'2099-06-20','wedding',80,'Outdoor ceremony','quoted',250000,'a'||repeat('b',47))
     returning id`, [vendorId, customerId]);
  const bookingId = b.rows[0].id;

  await db.query(`insert into crm_notes (booking_id, vendor_id, body) values ($1,$2,'Called Tuesday.')`,
    [bookingId, vendorId]);

  // $2,500.00 with a 10% fee: 25000 kept, 225000 owed on.
  await db.query(
    `insert into payments (booking_id, amount_cents, fee_cents, vendor_payout_cents, status, provider)
     values ($1, 250000, 25000, 225000, 'paid', 'pretend')`, [bookingId]);
  ok('vendor, customer, booking, note and payment all stored');

  console.log('\n5. THE DATABASE REFUSES BAD DATA');
  await mustRefuse('a made-up booking status',
    `update bookings set status='banana' where id=$1`, [bookingId]);
  await mustRefuse('a second vendor with the same email',
    `insert into vendors (email,password_hash,business_name,category_id)
     values ('test@example.com','x','Dupe',1)`);
  await mustRefuse('a vendor in a category that does not exist',
    `insert into vendors (email,password_hash,business_name,category_id)
     values ('new@example.com','x','No Such Category',9999)`);
  await mustRefuse('a second customer with the same email',
    `insert into customers (email,name) values ('bride@example.com','Impostor')`);
  await mustRefuse('a booking with no private link',
    `insert into bookings (vendor_id,customer_id,details,status)
     values ($1,$2,'no token','new')`, [vendorId, customerId]);
  await mustRefuse('two bookings sharing a private link',
    `insert into bookings (vendor_id,customer_id,details,status,public_token)
     values ($1,$2,'copy','new','a'||repeat('b',47))`, [vendorId, customerId]);
  await mustRefuse('a negative starting price',
    `update vendors set price_from_cents = -1 where id=$1`, [vendorId]);
  await mustRefuse('a negative quote',
    `update bookings set quoted_amount_cents = -500 where id=$1`, [bookingId]);
  await mustRefuse('a negative guest count',
    `update bookings set guest_count = -5 where id=$1`, [bookingId]);
  await mustRefuse('a negative payment',
    `insert into payments (booking_id,amount_cents,fee_cents,vendor_payout_cents)
     values ($1,-100,0,-100)`, [bookingId]);

  console.log('\n6. THE MOST IMPORTANT RULE: THE SPLIT MUST ADD UP');
  await mustRefuse('a fee that skims money (100 = 30 + 30)',
    `insert into payments (booking_id,amount_cents,fee_cents,vendor_payout_cents)
     values ($1,100,30,30)`, [bookingId]);
  await mustRefuse('a split that invents money (100 = 30 + 90)',
    `insert into payments (booking_id,amount_cents,fee_cents,vendor_payout_cents)
     values ($1,100,30,90)`, [bookingId]);
  await mustRefuse('changing a stored payment so it stops adding up',
    `update payments set fee_cents = 1 where booking_id=$1`, [bookingId]);
  const good = await db.query(
    `insert into payments (booking_id,amount_cents,fee_cents,vendor_payout_cents,provider_ref)
     values ($1,100,10,90,'ref-1') returning id`, [bookingId]);
  if (good.rows.length) ok('a split that does add up is accepted (100 = 10 + 90)');
  await mustRefuse('recording the same Stripe payment twice',
    `insert into payments (booking_id,amount_cents,fee_cents,vendor_payout_cents,provider_ref)
     values ($1,100,10,90,'ref-1')`, [bookingId]);

  console.log('\n7. updated_at LOOKS AFTER ITSELF');
  await db.query(`update bookings set updated_at = '2000-01-01' where id=$1`, [bookingId]);
  const before = (await db.query('select updated_at from bookings where id=$1', [bookingId])).rows[0].updated_at;
  await db.query(`update bookings set event_type='changed' where id=$1`, [bookingId]);
  const after = (await db.query('select updated_at from bookings where id=$1', [bookingId])).rows[0].updated_at;
  if (new Date(after) > new Date(before)) ok('changing a booking stamps the time automatically');
  else bad('updated_at was stamped', `${before} -> ${after}`);

  console.log('\n8. THE LOOKUP SHORTCUTS EXIST');
  const wanted = [
    'bookings_vendor_status_idx', 'bookings_vendor_recent_idx', 'bookings_customer_idx',
    'bookings_public_token_idx', 'vendors_active_category_idx', 'customers_email_unique',
    'payments_booking_idx', 'payments_recent_idx', 'payments_provider_ref_idx',
    'crm_notes_booking_idx', 'crm_notes_vendor_idx',
  ];
  const have = new Set((await db.query('select indexname from pg_indexes')).rows.map((r) => r.indexname));
  for (const name of wanted) {
    if (have.has(name)) ok(name);
    else bad(name, 'missing');
  }

  console.log('\n================================');
  console.log(` PASSED: ${pass}    FAILED: ${fail}`);
  console.log('================================');
  await db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\nCHECK CRASHED:\n', err); process.exit(1); });
