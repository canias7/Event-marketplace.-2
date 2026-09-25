/* ===================================================================
   Creates your admin account.
   Usage:  npm run create-admin -- you@example.com yourpassword
   =================================================================== */

const db = require('../src/db');
const auth = require('../src/auth');

(async () => {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: npm run create-admin -- you@example.com yourpassword');
    process.exit(1);
  }

  const clean = auth.cleanEmail(email);
  const problem = auth.emailProblem(clean) || auth.passwordProblem(password);
  if (problem) { console.error('ERROR: ' + problem); process.exit(1); }

  await db.init();

  const existing = await db.one('select id from admins where email = $1', [clean]);
  const hash = await auth.hashPassword(password);

  if (existing) {
    await db.query('update admins set password_hash = $1 where id = $2', [hash, existing.id]);
    console.log('Password updated for existing admin: ' + clean);
  } else {
    await db.query('insert into admins (email, password_hash) values ($1,$2)', [clean, hash]);
    console.log('Admin account created: ' + clean);
  }

  console.log('Log in at /admin/login');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
