// End-to-end flow against a real Neon database with Stripe's API stubbed.
// Run with: TEST_DATABASE_URL=postgres://... npm test  (point it at a disposable Neon branch)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { hmacSha256Hex } from '../src/lib/auth';

const DB = process.env.TEST_DATABASE_URL;
const ORIGIN = 'http://localhost';
const env = {
  DATABASE_URL: DB!,
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  PLATFORM_FEE_BPS: '1000',
};
const run = Date.now().toString(36);
const stripeCalls: { url: string; body: URLSearchParams }[] = [];

function req(path: string, init: { method?: string; form?: Record<string, string>; cookie?: string; headers?: Record<string, string>; body?: string } = {}) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  let body: BodyInit | undefined = init.body;
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers.origin ??= ORIGIN;
    body = new URLSearchParams(init.form);
  }
  return app.request(`${ORIGIN}${path}`, { method: init.method ?? (init.form || init.body ? 'POST' : 'GET'), headers, body, redirect: 'manual' }, env);
}

function cookieOf(res: Response): string {
  const m = /ev_session=([0-9a-f]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no session cookie');
  return `ev_session=${m[1]}`;
}

async function signup(name: string, email: string, category = '1') {
  const res = await req('/signup', { form: { business_name: name, category_id: category, city: 'Austin', email, password: 'password123' } });
  expect(res.status).toBe(303);
  return cookieOf(res);
}

async function webhook(event: object) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256Hex('whsec_test', `${t}.${payload}`);
  return req('/stripe/webhook', { body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` } });
}

describe.skipIf(!DB)('marketplace end-to-end', () => {
  let vendorA: string;
  let vendorB: string;
  let slugA: string;
  let serviceId: string;
  let contactId: string;

  beforeAll(() => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.stripe.com/')) return realFetch(input, init);
      stripeCalls.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
      if (url.endsWith('/checkout/sessions')) {
        return Response.json({ id: `cs_test_${run}`, url: 'https://checkout.stripe.com/c/pay/cs_test_x', payment_status: 'unpaid', payment_intent: null, metadata: {} });
      }
      return Response.json({ error: { message: 'unexpected stripe call' } }, { status: 400 });
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('lists at least 10 categories on the home page', async () => {
    const res = await req('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const name of ['Photography', 'Videography', 'Catering', 'DJs', 'Live Music', 'Venues', 'Florists', 'Event Planners', 'Decor &amp; Rentals', 'Hair &amp; Makeup']) {
      expect(body).toContain(name);
    }
  });

  it('rejects cross-site form posts', async () => {
    const res = await req('/signup', { form: { email: 'x@example.com' }, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('requires login for the vendor area', async () => {
    const res = await req('/vendor/crm');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('signs up vendors and logs in', async () => {
    vendorA = await signup(`Lens Co ${run}`, `a-${run}@example.com`);
    vendorB = await signup(`Rival Co ${run}`, `b-${run}@example.com`);
    const dup = await req('/signup', { form: { business_name: 'Dup', category_id: '1', email: `A-${run}@example.com`, password: 'password123' } });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('already registered');

    const bad = await req('/login', { form: { email: `a-${run}@example.com`, password: 'wrong-password' } });
    expect(bad.status).toBe(401);
    const good = await req('/login', { form: { email: `a-${run}@example.com`, password: 'password123' } });
    expect(good.status).toBe(303);
    cookieOf(good);

    const dash = await (await req('/vendor', { cookie: vendorA })).text();
    slugA = /\/v\/([a-z0-9-]+)/.exec(dash)![1];
    expect(slugA).toContain('lens-co');
  });

  it('lets a vendor publish a package', async () => {
    const res = await req('/vendor/services', { cookie: vendorA, form: { title: 'Full-day coverage', price: '1,500', description: '8 hours' } });
    expect(res.status).toBe(303);
    const page = await (await req(`/v/${slugA}`)).text();
    expect(page).toContain('Full-day coverage');
    expect(page).toContain('$1,500.00');
    serviceId = /\/book\/(\d+)/.exec(page)![1];
  });

  it('turns inquiries into CRM leads, escaping user input', async () => {
    const res = await req(`/v/${slugA}/inquire`, {
      form: { name: '<script>alert(1)</script> Pat', email: `pat-${run}@example.com`, message: 'Do you have June 5 free?', event_type: 'Wedding', event_date: '2030-06-05' },
    });
    expect(res.status).toBe(303);
    const crm = await (await req('/vendor/crm', { cookie: vendorA })).text();
    expect(crm).not.toContain('<script>alert(1)</script>');
    expect(crm).toContain('&lt;script&gt;');
    contactId = /\/vendor\/crm\/(\d+)/.exec(crm)![1];
    const detail = await (await req(`/vendor/crm/${contactId}`, { cookie: vendorA })).text();
    expect(detail).toContain('Do you have June 5 free?');
    expect(detail).toContain('inquiry');
  });

  it("isolates each vendor's CRM", async () => {
    expect((await req(`/vendor/crm/${contactId}`, { cookie: vendorB })).status).toBe(404);
    const crmB = await (await req('/vendor/crm', { cookie: vendorB })).text();
    expect(crmB).not.toContain(`pat-${run}@example.com`);
    // Vendor B cannot write to vendor A's contact either.
    await req(`/vendor/crm/${contactId}/activities`, { cookie: vendorB, form: { kind: 'note', body: 'hijack' } });
    await req(`/vendor/crm/${contactId}/delete`, { cookie: vendorB, form: {} });
    const detail = await (await req(`/vendor/crm/${contactId}`, { cookie: vendorA })).text();
    expect(detail).not.toContain('hijack');
    const csvB = await (await req('/vendor/crm/export.csv', { cookie: vendorB })).text();
    expect(csvB).not.toContain(`pat-${run}`);
  });

  it('supports manual contacts, stage changes, notes and tasks', async () => {
    const created = await req('/vendor/crm', { cookie: vendorA, form: { name: 'Sam Walk-in', email: '', phone: '555', stage: 'lead', note: 'Met at expo' } });
    expect(created.status).toBe(303);
    const id = /\/vendor\/crm\/(\d+)/.exec(created.headers.get('location')!)![1];
    await req(`/vendor/crm/${id}`, { cookie: vendorA, form: { name: 'Sam Walk-in', email: '', phone: '555', stage: 'proposal', budget: '2000' } });
    await req(`/vendor/crm/${id}/activities`, { cookie: vendorA, form: { kind: 'call', body: 'Discussed pricing' } });
    await req('/vendor/tasks', { cookie: vendorA, form: { title: 'Send contract', due_date: '2030-01-01', contact_id: id } });
    const detail = await (await req(`/vendor/crm/${id}`, { cookie: vendorA })).text();
    expect(detail).toContain('Stage changed from lead to proposal.');
    expect(detail).toContain('Discussed pricing');
    expect(detail).toContain('Send contract');
    expect(detail).toContain('Met at expo');
    // Vendor B cannot attach a task to vendor A's contact.
    expect((await req('/vendor/tasks', { cookie: vendorB, form: { title: 'x', contact_id: id } })).status).toBe(404);
  });

  it('takes payment through Stripe Checkout and records it in the CRM', async () => {
    const res = await req(`/book/${serviceId}`, {
      form: { name: 'Pat', email: `PAT-${run}@example.com`, phone: '555-0100', event_date: '2030-06-05', notes: 'Outdoor ceremony' },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_x');

    const call = stripeCalls.at(-1)!;
    expect(call.body.get('line_items[0][price_data][unit_amount]')).toBe('150000');
    expect(call.body.get('customer_email')).toBe(`pat-${run}@example.com`);
    expect(call.body.get('payment_intent_data[transfer_data][destination]')).toBeNull(); // vendor not connected
    const receipt = new URL(call.body.get('success_url')!.replace('{CHECKOUT_SESSION_ID}', 'x')).pathname;

    expect(await (await req(receipt)).text()).toContain('Awaiting payment');

    const session = { id: `cs_test_${run}`, payment_status: 'paid', payment_intent: `pi_test_${run}`, metadata: {} };
    const event = { type: 'checkout.session.completed', livemode: false, data: { object: session } };
    expect((await webhook(event)).status).toBe(200);
    expect((await webhook(event)).status).toBe(200); // replay is idempotent

    expect(await (await req(receipt)).text()).toContain('Paid — confirmed');

    const detail = await (await req(`/vendor/crm/${contactId}`, { cookie: vendorA })).text();
    expect(detail.match(/Paid \$1500\.00/g)).toHaveLength(1);
    expect(detail).toMatch(/<h1>.*<span class="badge">booked<\/span><\/h1>/s);

    const dash = await (await req('/vendor', { cookie: vendorA })).text();
    expect(dash).toContain('$1,500.00');
    expect(dash).toContain('$150.00'); // 10% platform fee
    expect(dash).toContain('$1,350.00');

    const bookings = await (await req('/vendor/bookings', { cookie: vendorA })).text();
    const bookingId = /\/vendor\/bookings\/(\d+)\/complete/.exec(bookings)![1];
    expect((await req(`/vendor/bookings/${bookingId}/complete`, { cookie: vendorB, form: {} })).headers.get('location')).toContain('not%20found');
    await req(`/vendor/bookings/${bookingId}/complete`, { cookie: vendorA, form: {} });
    expect(await (await req(`/vendor/crm/${contactId}`, { cookie: vendorA })).text()).toContain('<span class="badge">completed</span>');
  });

  it('rejects unsigned or forged webhooks', async () => {
    const res = await req('/stripe/webhook', { body: '{}', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' } });
    expect(res.status).toBe(400);
  });

  it('refuses live Stripe keys', async () => {
    const res = await app.request(`${ORIGIN}/book/${serviceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({ name: 'X', email: 'x@example.com', event_date: '2030-01-01' }),
      redirect: 'manual',
    }, { ...env, STRIPE_SECRET_KEY: 'sk_live_nope' });
    expect(res.headers.get('location')).toContain('live');
  });

  it('exports the CRM as CSV with formula injection neutralised', async () => {
    await req('/vendor/crm', { cookie: vendorA, form: { name: '=HYPERLINK("x")', stage: 'lead' } });
    const csv = await (await req('/vendor/crm/export.csv', { cookie: vendorA })).text();
    expect(csv.split('\r\n')[0]).toBe('name,email,phone,stage,source,event_type,event_date,budget_cents,created_at');
    expect(csv).toContain(`pat-${run}@example.com`);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('logs out', async () => {
    await req('/logout', { cookie: vendorB, form: {} });
    expect((await req('/vendor', { cookie: vendorB })).status).toBe(303);
  });
});
