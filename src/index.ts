import { neon } from '@neondatabase/serverless';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { html } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import { getSessionUser, SESSION_COOKIE } from './lib/auth';
import { layout } from './lib/views';
import { authRoutes } from './routes/auth';
import { crmRoutes, taskRoutes } from './routes/crm';
import { publicRoutes } from './routes/public';
import { vendorRoutes } from './routes/vendor';
import { webhookRoutes } from './routes/webhook';
import type { AppEnv, Vendor, VendorEnv } from './types';

const app = new Hono<AppEnv>();

// Reject cross-site form posts (Stripe's webhook is JSON, which this middleware ignores).
app.use('*', csrf());

app.use('*', async (c, next) => {
  const sql = neon(c.env.DATABASE_URL);
  c.set('sql', sql);
  c.set('user', null);
  c.set('vendor', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    const user = await getSessionUser(sql, token);
    if (user) {
      c.set('user', user);
      const [vendor] = await sql`SELECT * FROM vendors WHERE user_id = ${user.id}`;
      if (vendor) c.set('vendor', { ...vendor, id: Number(vendor.id), user_id: Number(vendor.user_id) } as Vendor);
    }
  }
  await next();
  c.header('X-Frame-Options', 'DENY');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
});

// Everything under /vendor requires a logged-in vendor and is private (no caching).
app.use('/vendor/*', async (c, next) => {
  if (!c.var.vendor) return c.redirect('/login', 303);
  await next();
  c.header('Cache-Control', 'private, no-store');
});

app.route('/', publicRoutes);
app.route('/', authRoutes);
app.route('/stripe', webhookRoutes);
// The middleware above guarantees user/vendor are set for these sub-apps.
const vendorApp = new Hono<VendorEnv>();
vendorApp.route('/crm', crmRoutes);
vendorApp.route('/tasks', taskRoutes);
vendorApp.route('/', vendorRoutes);
app.route('/vendor', vendorApp as unknown as Hono<AppEnv>);

app.get('/healthz', (c) => c.text('ok'));

app.notFound((c) => c.html(layout('Not found', html`<h1>Not found</h1><p><a href="/">Back to the marketplace</a></p>`, { vendor: c.var.vendor }), 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.html(layout('Error', html`<h1>Something went wrong</h1><p>Please try again.</p>`, { vendor: c.var.vendor ?? null }), 500);
});

export default app;
