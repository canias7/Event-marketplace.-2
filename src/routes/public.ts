import { Hono } from 'hono';
import { html } from 'hono/html';
import { randomToken } from '../lib/auth';
import { logActivity, markBookingPaid, upsertContact } from '../lib/crm';
import { createCheckoutSession, requireTestKey, retrieveCheckoutSession, StripeError } from '../lib/stripe';
import { field, fmtDate, isEmail, money, parseDate, platformFee, todayUtc, withMsg } from '../lib/util';
import { layout } from '../lib/views';
import type { AppEnv } from '../types';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/', async (c) => {
  const sql = c.var.sql;
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const categories = await sql`
    SELECT c.slug, c.name, c.description, count(v.id)::int AS vendor_count
    FROM categories c LEFT JOIN vendors v ON v.category_id = c.id
    GROUP BY c.id ORDER BY c.sort_order`;
  const results = q
    ? await sql`
        SELECT v.slug, v.business_name, v.city, c.name AS category
        FROM vendors v JOIN categories c ON c.id = v.category_id
        WHERE v.business_name ILIKE ${'%' + q + '%'} OR v.city ILIKE ${'%' + q + '%'} OR v.description ILIKE ${'%' + q + '%'}
        ORDER BY v.business_name LIMIT 50`
    : null;

  return c.html(
    layout(
      'Find event vendors',
      html`<h1>Find vendors for your event</h1>
        <form method="get" action="/">
          <input name="q" value="${q}" placeholder="Search by name, city or keyword" size="40">
          <button>Search</button>
        </form>
        ${results
          ? html`<h2>Results for "${q}"</h2>
              ${results.length === 0 ? html`<p>No vendors matched.</p>` : ''}
              <ul>
                ${results.map((v) => html`<li><a href="/v/${v.slug}">${v.business_name}</a> — ${v.category}${v.city ? html`, ${v.city}` : ''}</li>`)}
              </ul>`
          : ''}
        <h2>Categories</h2>
        <div class="grid">
          ${categories.map(
            (cat) => html`<div class="card">
              <a href="/c/${cat.slug}"><b>${cat.name}</b></a>
              <div class="muted">${cat.description}</div>
              <div class="muted">${cat.vendor_count} vendor${cat.vendor_count === 1 ? '' : 's'}</div>
            </div>`,
          )}
        </div>`,
      { vendor: c.var.vendor, msg: c.req.query('msg') },
    ),
  );
});

publicRoutes.get('/c/:slug', async (c) => {
  const sql = c.var.sql;
  const [category] = await sql`SELECT id, name, description FROM categories WHERE slug = ${c.req.param('slug')}`;
  if (!category) return c.notFound();
  const vendors = await sql`
    SELECT v.slug, v.business_name, v.city, v.description, min(s.price_cents) AS from_price
    FROM vendors v LEFT JOIN services s ON s.vendor_id = v.id AND s.active
    WHERE v.category_id = ${category.id}
    GROUP BY v.id ORDER BY v.business_name`;
  return c.html(
    layout(
      category.name,
      html`<p><a href="/">← All categories</a></p>
        <h1>${category.name}</h1>
        <p class="muted">${category.description}</p>
        ${vendors.length === 0 ? html`<p>No vendors in this category yet. <a href="/signup">List your business</a>.</p>` : ''}
        <div class="grid">
          ${vendors.map(
            (v) => html`<div class="card">
              <a href="/v/${v.slug}"><b>${v.business_name}</b></a>
              <div class="muted">${v.city}</div>
              <p>${v.description.slice(0, 160)}</p>
              <div>${v.from_price ? html`From ${money(v.from_price)}` : html`<span class="muted">No packages yet</span>`}</div>
            </div>`,
          )}
        </div>`,
      { vendor: c.var.vendor },
    ),
  );
});

publicRoutes.get('/v/:slug', async (c) => {
  const sql = c.var.sql;
  const [v] = await sql`
    SELECT v.*, c.name AS category, c.slug AS category_slug
    FROM vendors v JOIN categories c ON c.id = v.category_id WHERE v.slug = ${c.req.param('slug')}`;
  if (!v) return c.notFound();
  const services = await sql`
    SELECT id, title, description, price_cents FROM services WHERE vendor_id = ${v.id} AND active ORDER BY price_cents`;

  return c.html(
    layout(
      v.business_name,
      html`<p><a href="/c/${v.category_slug}">← ${v.category}</a></p>
        <h1>${v.business_name}</h1>
        <p><span class="badge">${v.category}</span> ${v.city}</p>
        <p style="white-space:pre-line">${v.description}</p>
        <p class="muted">
          ${v.phone ? html`Phone: ${v.phone} · ` : ''}
          ${/^https?:\/\//.test(v.website) ? html`<a href="${v.website}" rel="nofollow noopener" target="_blank">Website</a>` : ''}
        </p>
        <h2>Packages</h2>
        ${services.length === 0 ? html`<p class="muted">This vendor hasn't published packages yet — send an inquiry below.</p>` : ''}
        <table>
          ${services.map(
            (s) => html`<tr>
              <td><b>${s.title}</b><div class="muted" style="white-space:pre-line">${s.description}</div></td>
              <td>${money(s.price_cents)}</td>
              <td><a href="/book/${s.id}">Book &amp; pay</a></td>
            </tr>`,
          )}
        </table>
        <h2>Send an inquiry</h2>
        <form method="post" action="/v/${v.slug}/inquire" class="stack">
          <label>Your name <input name="name" required maxlength="120"></label>
          <label>Email <input name="email" type="email" required maxlength="254"></label>
          <label>Phone <input name="phone" maxlength="40"></label>
          <label>Event type <input name="event_type" placeholder="Wedding, birthday, corporate…" maxlength="80"></label>
          <label>Event date <input name="event_date" type="date"></label>
          <label>Message <textarea name="message" required maxlength="4000"></textarea></label>
          <button>Send inquiry</button>
        </form>`,
      { vendor: c.var.vendor, msg: c.req.query('msg'), error: c.req.query('error') },
    ),
  );
});

publicRoutes.post('/v/:slug/inquire', async (c) => {
  const sql = c.var.sql;
  const slug = c.req.param('slug');
  const [v] = await sql`SELECT id FROM vendors WHERE slug = ${slug}`;
  if (!v) return c.notFound();
  const f = await c.req.parseBody();
  const name = field(f, 'name', 120);
  const email = field(f, 'email', 254).toLowerCase();
  const message = field(f, 'message', 4000);
  const eventDate = field(f, 'event_date') ? parseDate(field(f, 'event_date')) : null;
  if (!name || !isEmail(email) || !message) {
    return c.redirect(`/v/${slug}?error=${encodeURIComponent('Please provide your name, a valid email and a message.')}`, 303);
  }
  const contactId = await upsertContact(sql, Number(v.id), {
    name,
    email,
    phone: field(f, 'phone', 40),
    source: 'marketplace inquiry',
    eventDate,
    eventType: field(f, 'event_type', 80),
  });
  await logActivity(sql, Number(v.id), contactId, 'inquiry', message);
  return c.redirect(withMsg(`/v/${slug}`, 'Thanks! Your inquiry was sent to the vendor.'), 303);
});

async function loadService(c: { var: AppEnv['Variables'] }, id: string) {
  if (!/^\d+$/.test(id)) return null;
  const [s] = await c.var.sql`
    SELECT s.id, s.title, s.description, s.price_cents, v.id AS vendor_id, v.business_name, v.slug AS vendor_slug,
           v.stripe_account_id, v.stripe_charges_enabled
    FROM services s JOIN vendors v ON v.id = s.vendor_id
    WHERE s.id = ${id} AND s.active`;
  return s ?? null;
}

publicRoutes.get('/book/:serviceId', async (c) => {
  const s = await loadService(c, c.req.param('serviceId'));
  if (!s) return c.notFound();
  return c.html(
    layout(
      `Book ${s.title}`,
      html`<p><a href="/v/${s.vendor_slug}">← ${s.business_name}</a></p>
        <h1>Book: ${s.title}</h1>
        <p>${s.business_name} · <b>${money(s.price_cents)}</b></p>
        <p class="muted">Payment is processed securely by Stripe (test mode — use card 4242 4242 4242 4242, any future expiry, any CVC).</p>
        <form method="post" action="/book/${s.id}" class="stack">
          <label>Your name <input name="name" required maxlength="120"></label>
          <label>Email <input name="email" type="email" required maxlength="254"></label>
          <label>Phone <input name="phone" maxlength="40"></label>
          <label>Event date <input name="event_date" type="date" required min="${todayUtc()}"></label>
          <label>Notes for the vendor <textarea name="notes" maxlength="4000"></textarea></label>
          <button>Continue to payment</button>
        </form>`,
      { vendor: c.var.vendor, error: c.req.query('error') },
    ),
  );
});

publicRoutes.post('/book/:serviceId', async (c) => {
  const sql = c.var.sql;
  const s = await loadService(c, c.req.param('serviceId'));
  if (!s) return c.notFound();
  const back = (error: string) => c.redirect(`/book/${s.id}?error=${encodeURIComponent(error)}`, 303);

  const f = await c.req.parseBody();
  const name = field(f, 'name', 120);
  const email = field(f, 'email', 254).toLowerCase();
  const phone = field(f, 'phone', 40);
  const notes = field(f, 'notes', 4000);
  const eventDate = parseDate(field(f, 'event_date'));
  if (!name || !isEmail(email)) return back('Please provide your name and a valid email.');
  if (!eventDate || eventDate < todayUtc()) return back('Please choose an event date in the future.');

  let stripeKey: string;
  try {
    stripeKey = requireTestKey(c.env.STRIPE_SECRET_KEY);
  } catch (e) {
    return back((e as Error).message);
  }

  const vendorId = Number(s.vendor_id);
  const amount = Number(s.price_cents);
  const fee = platformFee(amount, c.env.PLATFORM_FEE_BPS);
  const destination = s.stripe_charges_enabled ? (s.stripe_account_id as string) : null;
  const token = randomToken(16);

  const contactId = await upsertContact(sql, vendorId, { name, email, phone, source: 'marketplace booking', eventDate });
  const [booking] = await sql`
    INSERT INTO bookings (vendor_id, service_id, contact_id, public_token, service_title, customer_name, customer_email,
                          customer_phone, event_date, notes, amount_cents, platform_fee_cents, stripe_destination)
    VALUES (${vendorId}, ${s.id}, ${contactId}, ${token}, ${s.title}, ${name}, ${email},
            ${phone}, ${eventDate}, ${notes}, ${amount}, ${fee}, ${destination})
    RETURNING id`;
  await logActivity(sql, vendorId, contactId, 'booking',
    `Started checkout for "${s.title}" (${money(amount)}) on ${eventDate}.${notes ? ` Notes: ${notes}` : ''}`);

  const origin = new URL(c.req.url).origin;
  try {
    const session = await createCheckoutSession(stripeKey, {
      bookingId: Number(booking.id),
      productName: `${s.title} — ${s.business_name} (${eventDate})`,
      amountCents: amount,
      customerEmail: email,
      successUrl: `${origin}/booking/${token}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/booking/${token}`,
      destination,
      applicationFeeCents: fee,
    });
    await sql`UPDATE bookings SET stripe_checkout_session_id = ${session.id} WHERE id = ${booking.id}`;
    return c.redirect(session.url!, 303);
  } catch (e) {
    await sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${booking.id}`;
    if (e instanceof StripeError) return back(`Payment could not be started: ${e.message}`);
    throw e;
  }
});

publicRoutes.get('/booking/:token', async (c) => {
  const sql = c.var.sql;
  const token = c.req.param('token');
  const load = async () =>
    (
      await sql`
        SELECT b.*, b.event_date::text AS event_date, v.business_name, v.slug AS vendor_slug
        FROM bookings b JOIN vendors v ON v.id = b.vendor_id WHERE b.public_token = ${token}`
    )[0];
  let b = await load();
  if (!b) return c.notFound();

  // Confirm payment on return from Checkout so the page is accurate even before the webhook lands.
  const sessionId = c.req.query('session_id');
  if (b.status === 'pending_payment' && sessionId && sessionId === b.stripe_checkout_session_id && c.env.STRIPE_SECRET_KEY) {
    try {
      const session = await retrieveCheckoutSession(c.env.STRIPE_SECRET_KEY, sessionId);
      if (session.payment_status === 'paid') {
        await markBookingPaid(sql, session.id, session.payment_intent);
        b = await load();
      }
    } catch (e) {
      if (!(e instanceof StripeError)) throw e; // the webhook will still confirm the payment
    }
  }

  const statusText: Record<string, string> = {
    pending_payment: 'Awaiting payment',
    paid: 'Paid — confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return c.html(
    layout(
      'Your booking',
      html`<h1>Booking with ${b.business_name}</h1>
        <table>
          <tr><th>Status</th><td><b>${statusText[b.status] ?? b.status}</b></td></tr>
          <tr><th>Package</th><td>${b.service_title}</td></tr>
          <tr><th>Event date</th><td>${fmtDate(b.event_date)}</td></tr>
          <tr><th>Amount</th><td>${money(b.amount_cents)}</td></tr>
          <tr><th>Name</th><td>${b.customer_name}</td></tr>
          <tr><th>Email</th><td>${b.customer_email}</td></tr>
        </table>
        ${b.status === 'pending_payment'
          ? html`<p>Payment not completed.${b.service_id ? html` <a href="/book/${b.service_id}">Try again</a>.` : ''}</p>`
          : ''}
        <p><a href="/v/${b.vendor_slug}">Back to ${b.business_name}</a></p>
        <p class="muted">Keep this page's link as your receipt.</p>`,
      { vendor: c.var.vendor },
    ),
  );
});
