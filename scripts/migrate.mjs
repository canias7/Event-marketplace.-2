// Applies migrations/*.sql to DATABASE_URL in filename order, once each.
// Usage: DATABASE_URL=postgres://... npm run migrate
import { readdir, readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const sql = neon(url);
const dir = new URL('../migrations/', import.meta.url);

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));

for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(name)) continue;
  const text = await readFile(new URL(name, dir), 'utf8');
  // Statements are separated by ";" at end of line; the schema has no function bodies.
  const statements = text
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  await sql.transaction([
    ...statements.map((s) => sql.query(s)),
    sql`INSERT INTO schema_migrations (name) VALUES (${name})`,
  ]);
  console.log(`applied ${name}`);
}
console.log('migrations up to date');
