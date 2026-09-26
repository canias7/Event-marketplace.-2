/* ===================================================================
   MIGRATIONS - changing the database safely over time

   The files in db/migrations are numbered. Each one runs ONCE, in
   order, and is then written down in a table called schema_migrations.
   Next startup, anything already written down is skipped.

   Why not just re-run one big schema file every time? Because "create
   this table if it is missing" can add things but cannot change things.
   The moment you need to add a column, rename one, or add a rule to a
   table that already has rows in it, you need a record of what has
   already been done.

   Each file runs inside a transaction: either all of it works, or none
   of it does. A half-applied migration is the worst outcome, so it is
   the one case we make impossible.

   RULE: never edit a migration that has already run anywhere. Add a new
   numbered file instead. An edited file will not re-run, so the two
   databases would silently drift apart.
   =================================================================== */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

function migrationFiles() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
}

/* `runner` is whichever database we are talking to, offering:
     exec(sql)          - run a whole file, no values substituted in
     query(sql, values) - run one statement with values
   Both must use the SAME connection, or the transactions below would
   not cover the statements inside them. */
async function run(runner, log = console.log) {
  await runner.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )`);

  const done = new Set(
    (await runner.query('select version from schema_migrations')).rows.map((r) => r.version)
  );

  const files = migrationFiles();
  const applied = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;

    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');

    try {
      await runner.exec('begin');
      await runner.exec(sql);
      await runner.query('insert into schema_migrations (version) values ($1)', [version]);
      await runner.exec('commit');
      applied.push(version);
      log('  applied ' + version);
    } catch (err) {
      try { await runner.exec('rollback'); } catch { /* already unwound */ }
      throw new Error(
        `Migration ${file} failed, and nothing from it was kept.\n` +
        `The database is exactly as it was before.\n\n` +
        `What the database said: ${err.message}`
      );
    }
  }

  return { applied, alreadyDone: files.length - applied.length, total: files.length };
}

module.exports = { run, migrationFiles };
