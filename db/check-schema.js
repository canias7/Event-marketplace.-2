/* ===================================================================
   CHECKS THE DATABASE FILES ARE VALID - without needing Neon.
   Runs schema.sql + seed.sql against an in-memory copy of Postgres,
   then inserts one of everything to prove the tables link up.
   Run with: npm run db:check
   =================================================================== */

const fs = require('fs');
const path = require('path');

async function main() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();

  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

  console.log('1. running schema.sql ...');
  await db.exec(read('schema.sql'));
  console.log('   OK - tables created');

  console.log('2. running seed.sql ...');
  await db.exec(read('seed.sql'));
  const cats = await db.query('select slug, name from categories order by id');
  console.log(`   OK - ${cats.rows.length} categories:`);
  for (const c of cats.rows) console.log(`      - ${c.name}  (${c.slug})`);

  console.log('3. re-running both files to check they are safe to repeat ...');
  await db.exec(read('schema.sql'));
  await db.exec(read('seed.sql'));
  const again = await db.query('select count(*)::int as n from categories');
  if (again.rows[0].n !== cats.rows.length) throw new Error('re-running created duplicates!');
  console.log('   OK - no duplicates');

  console.log('4. inserting one of everything to prove the tables link up ...');
  const v = await db.query(
    `insert into vendors (email, password_hash, business_name, category_id, city, price_from_cents)
     values ('test@example.com','fake-hash','Test Photos',
             (select id from categories where slug='photography'), 'Austin', 150000)
     returning id`
  );
  const vendorId = v.rows[0].id;

  const c = await db.query(
    `insert into customers (email, name) values ('bride@example.com','Sam Rivera') returning id`
  );
  const customerId = c.rows[0].id;

  const b = await db.query(
    `insert into bookings (vendor_id, customer_id, event_date, event_type, guest_count, details, status, quoted_amount_cents)
     values ($1,$2,'2026-06-20','wedding',80,'Outdoor ceremony, 6 hours','quoted',250000)
     returning id`,
    [vendorId, customerId]
  );
  const bookingId = b.rows[0].id;

  await db.query(
    `insert into crm_notes (booking_id, vendor_id, body) values ($1,$2,'Called Tuesday. Wants golden hour shots.')`,
    [bookingId, vendorId]
  );

  // 250000 cents = $2500. 10% fee = 25000. Vendor gets 225000.
  await db.query(
    `insert into payments (booking_id, amount_cents, fee_cents, vendor_payout_cents, status, provider)
     values ($1, 250000, 25000, 225000, 'paid', 'pretend')`,
    [bookingId]
  );
  console.log('   OK - vendor, customer, booking, note and payment all saved');

  console.log('5. checking the rules actually block bad data ...');
  let blocked = 0;

  try {
    await db.query(`update bookings set status='banana' where id=$1`, [bookingId]);
    console.log('   FAIL - accepted a bad status');
  } catch { blocked++; console.log('   OK - refused status "banana"'); }

  try {
    await db.query(`insert into vendors (email,password_hash,business_name,category_id)
                    values ('test@example.com','x','Dupe',1)`);
    console.log('   FAIL - accepted a duplicate vendor email');
  } catch { blocked++; console.log('   OK - refused a duplicate vendor email'); }

  try {
    await db.query(`insert into vendors (email,password_hash,business_name,category_id)
                    values ('new@example.com','x','No Such Category',9999)`);
    console.log('   FAIL - accepted a category that does not exist');
  } catch { blocked++; console.log('   OK - refused a made-up category'); }

  if (blocked !== 3) throw new Error('the database is not enforcing its rules');

  console.log('6. reading back a vendor CRM view ...');
  const crm = await db.query(
    `select b.id, b.status, b.event_date, b.quoted_amount_cents,
            cu.name as customer, count(n.id)::int as notes
       from bookings b
       join customers cu on cu.id = b.customer_id
       left join crm_notes n on n.booking_id = b.id
      where b.vendor_id = $1
      group by b.id, cu.name
      order by b.created_at desc`,
    [vendorId]
  );
  console.log('   ', JSON.stringify(crm.rows[0]));

  console.log('\nALL CHECKS PASSED. The database files are valid Postgres.');
  await db.close();
}

main().catch((err) => { console.error('\nCHECK FAILED:\n', err); process.exit(1); });
