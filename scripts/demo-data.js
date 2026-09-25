/* ===================================================================
   FILLS THE APP WITH FAKE DATA so you can click around.

   Creates 24 vendors across all 12 categories, some customers, and a
   spread of bookings at every stage so a vendor CRM has content.

   Usage:  npm run demo-data
   Every demo vendor's password is:  demo1234
   =================================================================== */

const db = require('../src/db');
const auth = require('../src/auth');
const { splitFee } = require('../src/money');
const config = require('../src/config');

const PASSWORD = 'demo1234';

// [category slug, business name, city, starting price in dollars]
const VENDORS = [
  ['photography',    'Golden Hour Photography',  'Austin, TX',    1800],
  ['photography',    'Marlowe & Field Photo',    'Portland, OR',  2400],
  ['videography',    'Second Take Films',        'Austin, TX',    3200],
  ['videography',    'Northlight Video',         'Denver, CO',    2750],
  ['catering',       'Copper Spoon Catering',    'Austin, TX',    45],
  ['catering',       'Harvest Table Kitchen',    'Nashville, TN', 62],
  ['dj-music',       'Eastside Sound',           'Austin, TX',    900],
  ['dj-music',       'The Mainline Quartet',     'Chicago, IL',   2100],
  ['venues',         'The Old Mill Barn',        'Dripping Springs, TX', 4500],
  ['venues',         'Rooftop 41',               'Chicago, IL',   6000],
  ['florists',       'Wildhaven Flowers',        'Austin, TX',    750],
  ['florists',       'Stem & Vine',              'Seattle, WA',   1100],
  ['event-planners', 'Kindred Events',           'Austin, TX',    3500],
  ['event-planners', 'Rowan Planning Co.',       'Atlanta, GA',   5200],
  ['decor-rentals',  'Lantern & Linen Rentals',  'Austin, TX',    1200],
  ['decor-rentals',  'Grand Marquee Hire',       'Dallas, TX',    2800],
  ['cakes-desserts', 'Butter & Bloom Bakery',    'Austin, TX',    450],
  ['cakes-desserts', 'Sugarhouse Desserts',      'Boston, MA',    600],
  ['hair-makeup',    'Bridal Glow Studio',       'Austin, TX',    400],
  ['hair-makeup',    'Ash & Rose Beauty',        'Miami, FL',     550],
  ['transportation', 'Bluebonnet Limo',          'Austin, TX',    650],
  ['transportation', 'Classic Ride Co.',         'Phoenix, AZ',   800],
  ['entertainment',  'Pocketful of Magic',       'Austin, TX',    700],
  ['entertainment',  'Snapbox Photo Booths',     'Austin, TX',    550],
];

const CUSTOMERS = [
  ['sam.rivera@example.com',   'Sam Rivera',    '512-555-0111'],
  ['dana.okafor@example.com',  'Dana Okafor',   '512-555-0122'],
  ['jules.tan@example.com',    'Jules Tan',     '773-555-0133'],
  ['riley.brooks@example.com', 'Riley Brooks',  '303-555-0144'],
  ['noor.haddad@example.com',  'Noor Haddad',   '617-555-0155'],
  ['casey.lindqvist@example.com', 'Casey Lindqvist', '206-555-0166'],
];

/* Bookings for the FIRST vendor, so their CRM shows every stage.
   [customer index, days from now, event type, guests, status, quote in dollars] */
const BOOKINGS = [
  [0,  95, 'Wedding',        120, 'new',       null],
  [1,  40, 'Birthday party',  35, 'new',       null],
  [2, 150, 'Wedding',         80, 'quoted',    2600],
  [3,  62, 'Corporate event',200, 'quoted',    4100],
  [4, 210, 'Wedding',        140, 'booked',    3200],
  [5,  28, 'Anniversary',     20, 'paid',      1800],
  [0, -30, 'Engagement shoot',  2, 'completed', 900],
  [1, -75, 'Wedding',         90, 'completed', 2400],
  [2,  18, 'Baby shower',     30, 'cancelled', 1200],
  [3,  55, 'Wedding',        110, 'lost',      2900],
];

const NOTES = {
  0: ['Called Tuesday, left a voicemail.', 'Emailed the pricing guide.'],
  2: ['Wants golden hour portraits. Venue is 40 min out - travel fee applies.'],
  4: ['Deposit agreed. Second shooter confirmed for the day.'],
  5: ['Paid in full. Gallery delivered.'],
  7: ['Delivered 480 edited photos. Asked for a review.'],
  9: ['Went with a cheaper photographer. Follow up next season.'],
};

const dateFromNow = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

(async () => {
  const force = process.argv.includes('--force');
  await db.init();

  const existing = await db.one('select count(*)::int as n from vendors');
  if (existing.n > 0 && !force) {
    console.log(`There are already ${existing.n} vendors in the database.`);
    console.log('Run "npm run demo-data -- --force" to add the demo data anyway.');
    process.exit(0);
  }

  const categories = {};
  for (const row of (await db.query('select id, slug from categories')).rows) {
    categories[row.slug] = row.id;
  }

  const passwordHash = await auth.hashPassword(PASSWORD);
  const vendorIds = [];

  console.log('Adding vendors...');
  for (const [slug, name, city, priceDollars] of VENDORS) {
    const email = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') + '@example.com';

    const already = await db.one('select id from vendors where email = $1', [email]);
    if (already) { vendorIds.push(already.id); continue; }

    const row = await db.one(
      `insert into vendors (email, password_hash, business_name, category_id, city, phone, description, price_from_cents)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [email, passwordHash, name, categories[slug], city, '512-555-0100',
       `${name} - demo listing for the ${slug.replace(/-/g, ' ')} category.`,
       priceDollars * 100]
    );
    vendorIds.push(row.id);
  }
  console.log(`  ${vendorIds.length} vendors`);

  console.log('Adding customers...');
  const customerIds = [];
  for (const [email, name, phone] of CUSTOMERS) {
    let row = await db.one('select id from customers where email = $1', [email]);
    if (!row) {
      row = await db.one('insert into customers (email,name,phone) values ($1,$2,$3) returning id',
        [email, name, phone]);
    }
    customerIds.push(row.id);
  }
  console.log(`  ${customerIds.length} customers`);

  console.log('Adding bookings for the first vendor...');
  const firstVendor = vendorIds[0];
  let bookingCount = 0, paymentCount = 0, noteCount = 0;

  for (let i = 0; i < BOOKINGS.length; i++) {
    const [customerIndex, days, eventType, guests, status, quoteDollars] = BOOKINGS[i];

    const booking = await db.one(
      `insert into bookings (vendor_id, customer_id, event_date, event_type, guest_count, details, status, quoted_amount_cents)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [firstVendor, customerIds[customerIndex], dateFromNow(days), eventType, guests,
       `${eventType} for about ${guests} guests. Demo request.`,
       status, quoteDollars === null ? null : quoteDollars * 100]
    );
    bookingCount++;

    for (const body of (NOTES[i] || [])) {
      await db.query('insert into crm_notes (booking_id, vendor_id, body) values ($1,$2,$3)',
        [booking.id, firstVendor, body]);
      noteCount++;
    }

    /* Anything paid or completed has money against it. */
    if (status === 'paid' || status === 'completed') {
      const split = splitFee(quoteDollars * 100, config.feePercent);
      await db.query(
        `insert into payments (booking_id, amount_cents, fee_cents, vendor_payout_cents, status, provider)
         values ($1,$2,$3,$4,'paid','pretend')`,
        [booking.id, split.amountCents, split.feeCents, split.vendorPayoutCents]
      );
      paymentCount++;
    }
  }
  console.log(`  ${bookingCount} bookings, ${noteCount} notes, ${paymentCount} payments`);

  const first = await db.one('select email, business_name from vendors where id = $1', [firstVendor]);
  console.log('');
  console.log('Done. Log in as the vendor with the full CRM:');
  console.log('  email:    ' + first.email);
  console.log('  password: ' + PASSWORD);
  console.log('');
  console.log('Every demo vendor uses the same password.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
