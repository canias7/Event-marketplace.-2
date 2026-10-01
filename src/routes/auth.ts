import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { createSession, deleteSession, hashPassword, SESSION_COOKIE, SESSION_DAYS, verifyPassword } from '../lib/auth';
import { field, isEmail, isUniqueViolation, randomSuffix, slugify } from '../lib/util';
import { layout, options } from '../lib/views';
import type { AppEnv } from '../types';

export const authRoutes = new Hono<AppEnv>();

// A real hash so unknown-email logins take as long as wrong-password logins.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function startSession(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

async function signupPage(c: Context<AppEnv>, error?: string, values: Record<string, string> = {}) {
  const categories = await c.var.sql`SELECT id, name FROM categories ORDER BY sort_order`;
  return c.html(
    layout(
      'List your business',
      html`<h1>List your business</h1>
        <p class="muted">Create a vendor account to get a public profile, accept paid bookings and manage clients in your own CRM.</p>
        <form method="post" action="/signup" class="stack">
          <label>Business name <input name="business_name" required maxlength="120" value="${values.business_name ?? ''}"></label>
          <label>Category
            <select name="category_id" required>
              ${options(categories.map((r) => ({ value: r.id, label: r.name })), values.category_id)}
            </select>
          </label>
          <label>City <input name="city" maxlength="80" value="${values.city ?? ''}"></label>
          <label>Email <input name="email" type="email" required maxlength="254" value="${values.email ?? ''}"></label>
          <label>Password (min 8 characters) <input name="password" type="password" required minlength="8" maxlength="200"></label>
          <button>Create vendor account</button>
        </form>
        <p>Already have an account? <a href="/login">Log in</a></p>`,
      { error },
    ),
    error ? 400 : 200,
  );
}

authRoutes.get('/signup', (c) => (c.var.vendor ? c.redirect('/vendor') : signupPage(c)));

authRoutes.post('/signup', async (c) => {
  const sql = c.var.sql;
  const f = await c.req.parseBody();
  const values = {
    business_name: field(f, 'business_name', 120),
    category_id: field(f, 'category_id', 10),
    city: field(f, 'city', 80),
    email: field(f, 'email', 254).toLowerCase(),
  };
  const password = typeof f.password === 'string' ? f.password : '';
  if (!values.business_name) return signupPage(c, 'Business name is required.', values);
  if (!isEmail(values.email)) return signupPage(c, 'Please enter a valid email.', values);
  if (password.length < 8 || password.length > 200) return signupPage(c, 'Password must be 8–200 characters.', values);
  const [category] = /^\d+$/.test(values.category_id)
    ? await sql`SELECT id FROM categories WHERE id = ${values.category_id}`
    : [];
  if (!category) return signupPage(c, 'Please choose a category.', values);

  let slug = slugify(values.business_name);
  const [taken] = await sql`SELECT 1 FROM vendors WHERE slug = ${slug}`;
  if (taken) slug = `${slug}-${randomSuffix()}`;

  let userId: number;
  try {
    const [row] = await sql`
      WITH u AS (INSERT INTO users (email, password_hash) VALUES (${values.email}, ${await hashPassword(password)}) RETURNING id)
      INSERT INTO vendors (user_id, category_id, business_name, slug, city)
      SELECT id, ${category.id}, ${values.business_name}, ${slug}, ${values.city} FROM u
      RETURNING user_id`;
    userId = Number(row.user_id);
  } catch (e) {
    if (isUniqueViolation(e)) return signupPage(c, 'That email is already registered — try logging in.', values);
    throw e;
  }
  startSession(c, await createSession(sql, userId));
  return c.redirect('/vendor?msg=' + encodeURIComponent('Welcome! Add your first package under Services.'), 303);
});

function loginPage(c: Context<AppEnv>, error?: string, email = '') {
  return c.html(
    layout(
      'Vendor login',
      html`<h1>Vendor login</h1>
        <form method="post" action="/login" class="stack">
          <label>Email <input name="email" type="email" required value="${email}"></label>
          <label>Password <input name="password" type="password" required></label>
          <button>Log in</button>
        </form>
        <p>New vendor? <a href="/signup">List your business</a></p>`,
      { error, msg: c.req.query('msg') },
    ),
    error ? 401 : 200,
  );
}

authRoutes.get('/login', (c) => (c.var.vendor ? c.redirect('/vendor') : loginPage(c)));

authRoutes.post('/login', async (c) => {
  const sql = c.var.sql;
  const f = await c.req.parseBody();
  const email = field(f, 'email', 254).toLowerCase();
  const password = typeof f.password === 'string' ? f.password.slice(0, 200) : '';
  const [user] = await sql`SELECT id, password_hash FROM users WHERE email = ${email}`;
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return loginPage(c, 'Invalid email or password.', email);
  await sql`DELETE FROM sessions WHERE user_id = ${user.id} AND expires_at < now()`;
  startSession(c, await createSession(sql, Number(user.id)));
  return c.redirect('/vendor', 303);
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(c.var.sql, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login?msg=' + encodeURIComponent('You have been logged out.'), 303);
});
