import { Hono } from 'hono';
import { html } from 'hono/html';
import { createAccountLink, createExpressAccount, requireTestKey, retrieveAccount, StripeError } from '../lib/stripe';
import { CRM_STAGES, field, fmtDate, fmtDateTime, money, parseMoney, withError, withMsg } from '../lib/util';
import { layout, options } from '../lib/views';
import type { VendorEnv } from '../types';

export const vendorRoutes = new Hono<VendorEnv>();

vendorRoutes.get('/', async (c) => {
  const { sql, vendor } = c.var;
  const [stages, [money_], upcoming, tasks, [services]] = await sql.transaction([
    sql`SELECT stage, count(*)::int AS n FROM crm_contacts WHERE vendor_id = ${vendor.id} GROUP BY stage`,
    sql`SELECT coalesce(sum(amount_cents), 0)::bigint AS gross, coalesce(sum(platform_fee_cents), 0)::bigint AS fees, count(*)::int AS n
        FROM bookings WHERE vendor_id = ${vendor.id} AND status IN ('paid', 'completed')`,
    sql`SELECT id, customer_name, service_title, event_date::text AS event_date, contact_id FROM bookings
        WHERE vendor_id = ${vendor.id} AND status = 'paid' AND event_date >= current_date ORDER BY event_date LIMIT 10`,
    sql`SELECT t.id, t.title, t.due_date::text AS due_date, t.contact_id, ct.name AS contact_name FROM crm_tasks t
        LEFT JOIN crm_contacts ct ON ct.id = t.contact_id
        WHERE t.vendor_id = ${vendor.id} AND NOT t.done ORDER BY t.due_date NULLS LAST, t.id LIMIT 10`,
    sql`SELECT count(*)::int AS n FROM services WHERE vendor_id = ${vendor.id} AND active`,
  ]);
  const byStage = Object.fromEntries(stages.map((r) => [r.stage, r.n]));

  return c.html(
    layout(
      'Dashboard',
      html`<h1>${vendor.business_name}</h1>
        <p class="muted">Public page: <a href="/v/${vendor.slug}">/v/${vendor.slug}</a></p>
        ${services.n === 0 ? html`<p class="error">You have no active packages, so customers can't book you yet. <a href="/vendor/services">Add one</a>.</p>` : ''}
        ${!vendor.stripe_charges_enabled
          ? html`<p class="muted">Payouts: not connected. Payments are collected by the platform; <a href="/vendor/payments">connect Stripe</a> for automatic payouts.</p>`
          : ''}
        <h2>Earnings</h2>
        <table>
          <tr><th>Paid bookings</th><th>Gross</th><th>Platform fees</th><th>Your net</th></tr>
          <tr><td>${money_.n}</td><td>${money(money_.gross)}</td><td>${money(money_.fees)}</td><td>${money(Number(money_.gross) - Number(money_.fees))}</td></tr>
        </table>
        <h2>CRM pipeline</h2>
        <table>
          <tr>${CRM_STAGES.map((s) => html`<th><a href="/vendor/crm?stage=${s}">${s}</a></th>`)}</tr>
          <tr>${CRM_STAGES.map((s) => html`<td>${byStage[s] ?? 0}</td>`)}</tr>
        </table>
        <div class="cols">
          <div>
            <h2>Upcoming events</h2>
            ${upcoming.length === 0 ? html`<p class="muted">None yet.</p>` : ''}
            <ul>${upcoming.map((b) => html`<li>${fmtDate(b.event_date)} — ${b.contact_id ? html`<a href="/vendor/crm/${b.contact_id}">${b.customer_name}</a>` : b.customer_name} (${b.service_title})</li>`)}</ul>
          </div>
          <div>
            <h2>Open tasks</h2>
            ${tasks.length === 0 ? html`<p class="muted">Nothing to do.</p>` : ''}
            <ul>${tasks.map((t) => html`<li>${t.due_date ? html`<b>${fmtDate(t.due_date)}</b> ` : ''}${t.title}${t.contact_id ? html` — <a href="/vendor/crm/${t.contact_id}">${t.contact_name}</a>` : ''}</li>`)}</ul>
            <p><a href="/vendor/tasks">All tasks →</a></p>
          </div>
        </div>`,
      { vendor, msg: c.req.query('msg') },
    ),
  );
});

// ---- Profile ----

vendorRoutes.get('/profile', async (c) => {
  const { sql, vendor } = c.var;
  const categories = await sql`SELECT id, name FROM categories ORDER BY sort_order`;
  return c.html(
    layout(
      'Profile',
      html`<h1>Business profile</h1>
        <form method="post" action="/vendor/profile" class="stack">
          <label>Business name <input name="business_name" required maxlength="120" value="${vendor.business_name}"></label>
          <label>Category <select name="category_id">${options(categories.map((r) => ({ value: r.id, label: r.name })), vendor.category_id)}</select></label>
          <label>City <input name="city" maxlength="80" value="${vendor.city}"></label>
          <label>Phone <input name="phone" maxlength="40" value="${vendor.phone}"></label>
          <label>Website <input name="website" type="url" maxlength="300" value="${vendor.website}"></label>
          <label>Description <textarea name="description" maxlength="4000" rows="8">${vendor.description}</textarea></label>
          <button>Save</button>
        </form>`,
      { vendor, msg: c.req.query('msg'), error: c.req.query('error') },
    ),
  );
});

vendorRoutes.post('/profile', async (c) => {
  const { sql, vendor } = c.var;
  const f = await c.req.parseBody();
  const name = field(f, 'business_name', 120);
  const categoryId = field(f, 'category_id', 10);
  const website = field(f, 'website', 300);
  if (!name) return c.redirect(withError('/vendor/profile', 'Business name is required.'), 303);
  if (website && !/^https?:\/\//.test(website)) return c.redirect(withError('/vendor/profile', 'Website must start with http:// or https://'), 303);
  const [cat] = /^\d+$/.test(categoryId) ? await sql`SELECT id FROM categories WHERE id = ${categoryId}` : [];
  await sql`
    UPDATE vendors SET business_name = ${name}, category_id = ${cat?.id ?? vendor.category_id}, city = ${field(f, 'city', 80)},
      phone = ${field(f, 'phone', 40)}, website = ${website}, description = ${field(f, 'description', 4000)}
    WHERE id = ${vendor.id}`;
  return c.redirect(withMsg('/vendor/profile', 'Profile saved.'), 303);
});

// ---- Services / packages ----

vendorRoutes.get('/services', async (c) => {
  const { sql, vendor } = c.var;
  const services = await sql`SELECT * FROM services WHERE vendor_id = ${vendor.id} ORDER BY active DESC, price_cents`;
  return c.html(
    layout(
      'Services',
      html`<h1>Services &amp; packages</h1>
        <p class="muted">Active packages appear on your public page and can be booked and paid for online.</p>
        ${services.map(
          (s) => html`<form method="post" action="/vendor/services/${s.id}" class="stack card" style="margin-bottom:12px">
            <label>Title <input name="title" required maxlength="120" value="${s.title}"></label>
            <label>Price (USD) <input name="price" required value="${(s.price_cents / 100).toFixed(2)}"></label>
            <label>Description <textarea name="description" maxlength="2000">${s.description}</textarea></label>
            <label><span><input type="checkbox" name="active" value="1" ${s.active ? 'checked' : ''}> Active (bookable)</span></label>
            <div><button>Save</button> <button formaction="/vendor/services/${s.id}/delete">Delete</button></div>
          </form>`,
        )}
        <h2>Add a package</h2>
        <form method="post" action="/vendor/services" class="stack">
          <label>Title <input name="title" required maxlength="120" placeholder="e.g. 6-hour wedding coverage"></label>
          <label>Price (USD) <input name="price" required placeholder="1500.00"></label>
          <label>Description <textarea name="description" maxlength="2000"></textarea></label>
          <button>Add package</button>
        </form>`,
      { vendor, msg: c.req.query('msg'), error: c.req.query('error') },
    ),
  );
});

function serviceInput(f: Record<string, unknown>) {
  const form = f as Parameters<typeof field>[0];
  const title = field(form, 'title', 120);
  const price = parseMoney(field(form, 'price', 20));
  if (!title) return 'Title is required.';
  if (price === null || price < 50) return 'Price must be at least $0.50.';
  return { title, price, description: field(form, 'description', 2000), active: field(form, 'active') === '1' } as const;
}

vendorRoutes.post('/services', async (c) => {
  const { sql, vendor } = c.var;
  const input = serviceInput(await c.req.parseBody());
  if (typeof input === 'string') return c.redirect(withError('/vendor/services', input), 303);
  await sql`INSERT INTO services (vendor_id, title, description, price_cents) VALUES (${vendor.id}, ${input.title}, ${input.description}, ${input.price})`;
  return c.redirect(withMsg('/vendor/services', 'Package added.'), 303);
});

vendorRoutes.post('/services/:id{[0-9]+}', async (c) => {
  const { sql, vendor } = c.var;
  const input = serviceInput(await c.req.parseBody());
  if (typeof input === 'string') return c.redirect(withError('/vendor/services', input), 303);
  await sql`
    UPDATE services SET title = ${input.title}, description = ${input.description}, price_cents = ${input.price}, active = ${input.active}
    WHERE id = ${c.req.param('id')!} AND vendor_id = ${vendor.id}`;
  return c.redirect(withMsg('/vendor/services', 'Package saved.'), 303);
});

vendorRoutes.post('/services/:id{[0-9]+}/delete', async (c) => {
  const { sql, vendor } = c.var;
  await sql`DELETE FROM services WHERE id = ${c.req.param('id')!} AND vendor_id = ${vendor.id}`;
  return c.redirect(withMsg('/vendor/services', 'Package deleted.'), 303);
});

// ---- Bookings ----

vendorRoutes.get('/bookings', async (c) => {
  const { sql, vendor } = c.var;
  const status = c.req.query('status');
  const bookings = status
    ? await sql`SELECT *, event_date::text AS event_date FROM bookings WHERE vendor_id = ${vendor.id} AND status = ${status} ORDER BY created_at DESC LIMIT 200`
    : await sql`SELECT *, event_date::text AS event_date FROM bookings WHERE vendor_id = ${vendor.id} AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 200`;
  return c.html(
    layout(
      'Bookings',
      html`<h1>Bookings</h1>
        <p>Filter: <a href="/vendor/bookings">active</a> · ${['pending_payment', 'paid', 'completed', 'cancelled'].map((s) => html`<a href="/vendor/bookings?status=${s}">${s}</a> · `)}</p>
        <table>
          <tr><th>Created</th><th>Customer</th><th>Package</th><th>Event date</th><th>Amount</th><th>Fee</th><th>Status</th><th></th></tr>
          ${bookings.map(
            (b) => html`<tr>
              <td>${fmtDateTime(b.created_at)}</td>
              <td>${b.contact_id ? html`<a href="/vendor/crm/${b.contact_id}">${b.customer_name}</a>` : b.customer_name}<div class="muted">${b.customer_email} ${b.customer_phone}</div></td>
              <td>${b.service_title}${b.notes ? html`<div class="muted">${b.notes}</div>` : ''}</td>
              <td>${fmtDate(b.event_date)}</td>
              <td>${money(b.amount_cents)}</td>
              <td>${money(b.platform_fee_cents)}</td>
              <td><span class="badge">${b.status}</span>${b.stripe_destination ? html`<div class="muted">paid out via Stripe Connect</div>` : ''}</td>
              <td>${b.status === 'paid'
                ? html`<form method="post" action="/vendor/bookings/${b.id}/complete" class="inline"><button>Mark completed</button></form>`
                : ''}</td>
            </tr>`,
          )}
        </table>
        ${bookings.length === 0 ? html`<p class="muted">No bookings.</p>` : ''}`,
      { vendor, msg: c.req.query('msg') },
    ),
  );
});

vendorRoutes.post('/bookings/:id{[0-9]+}/complete', async (c) => {
  const { sql, vendor } = c.var;
  const [b] = await sql`
    UPDATE bookings SET status = 'completed' WHERE id = ${c.req.param('id')!} AND vendor_id = ${vendor.id} AND status = 'paid'
    RETURNING contact_id, service_title`;
  if (b?.contact_id) {
    await sql.transaction([
      sql`UPDATE crm_contacts SET stage = 'completed', updated_at = now() WHERE id = ${b.contact_id} AND vendor_id = ${vendor.id}`,
      sql`INSERT INTO crm_activities (vendor_id, contact_id, kind, body)
          VALUES (${vendor.id}, ${b.contact_id}, 'stage_change', ${`Booking "${b.service_title}" marked completed.`})`,
    ]);
  }
  return c.redirect(withMsg('/vendor/bookings', b ? 'Booking marked completed.' : 'Booking not found or not paid.'), 303);
});

// ---- Payments / Stripe Connect (test mode) ----

vendorRoutes.get('/payments', async (c) => {
  const { sql, vendor } = c.var;
  const [totals] = await sql`
    SELECT coalesce(sum(amount_cents), 0)::bigint AS gross,
           coalesce(sum(platform_fee_cents), 0)::bigint AS fees,
           coalesce(sum(amount_cents - platform_fee_cents) FILTER (WHERE stripe_destination IS NULL), 0)::bigint AS held
    FROM bookings WHERE vendor_id = ${vendor.id} AND status IN ('paid', 'completed')`;
  return c.html(
    layout(
      'Payments',
      html`<h1>Payments</h1>
        <p>All customer payments go through EventVendora's Stripe checkout (<b>Stripe test mode</b> — no real money moves).
          The platform keeps a ${(Number(c.env.PLATFORM_FEE_BPS ?? 1000) / 100).toFixed(1)}% fee.</p>
        <table>
          <tr><th>Gross collected</th><td>${money(totals.gross)}</td></tr>
          <tr><th>Platform fees</th><td>${money(totals.fees)}</td></tr>
          <tr><th>Your net</th><td>${money(Number(totals.gross) - Number(totals.fees))}</td></tr>
          <tr><th>Held by platform (collected before Stripe was connected)</th><td>${money(totals.held)}</td></tr>
        </table>
        <h2>Payout account</h2>
        ${vendor.stripe_charges_enabled
          ? html`<p>✅ Stripe Connect account <code>${vendor.stripe_account_id}</code> is active. New bookings are paid out to it automatically.</p>`
          : html`<p>${vendor.stripe_account_id
                ? html`Stripe account <code>${vendor.stripe_account_id}</code> created, but onboarding isn't finished.`
                : 'No payout account connected yet.'}</p>
              <form method="post" action="/vendor/payments/connect"><button>${vendor.stripe_account_id ? 'Continue' : 'Start'} Stripe onboarding (test mode)</button></form>
              <p class="muted">In test mode you can use Stripe's test data during onboarding (e.g. phone 000 000 0000, SMS code 000000, routing 110000000, account 000123456789).</p>`}`,
      { vendor, msg: c.req.query('msg'), error: c.req.query('error') },
    ),
  );
});

vendorRoutes.post('/payments/connect', async (c) => {
  const { sql, vendor, user } = c.var;
  const origin = new URL(c.req.url).origin;
  try {
    const key = requireTestKey(c.env.STRIPE_SECRET_KEY);
    let accountId = vendor.stripe_account_id;
    if (!accountId) {
      accountId = (await createExpressAccount(key, user.email, vendor.id)).id;
      await sql`UPDATE vendors SET stripe_account_id = ${accountId} WHERE id = ${vendor.id}`;
    }
    const link = await createAccountLink(key, accountId, `${origin}/vendor/payments?msg=Onboarding+link+expired%2C+please+try+again.`, `${origin}/vendor/payments/return`);
    return c.redirect(link.url, 303);
  } catch (e) {
    if (e instanceof StripeError) return c.redirect(withError('/vendor/payments', e.message), 303);
    throw e;
  }
});

vendorRoutes.get('/payments/return', async (c) => {
  const { sql, vendor } = c.var;
  if (!vendor.stripe_account_id || !c.env.STRIPE_SECRET_KEY) return c.redirect('/vendor/payments', 303);
  const account = await retrieveAccount(c.env.STRIPE_SECRET_KEY, vendor.stripe_account_id);
  await sql`UPDATE vendors SET stripe_charges_enabled = ${account.charges_enabled} WHERE id = ${vendor.id}`;
  return c.redirect(
    withMsg('/vendor/payments', account.charges_enabled ? 'Stripe connected — you will be paid out automatically.' : 'Onboarding not complete yet.'),
    303,
  );
});
