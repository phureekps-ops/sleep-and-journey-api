// Runs every .sql file in src/migrations, in filename order, using the `pg`
// driver directly (same one the app already depends on). This replaces the
// old approach of shelling out to the `psql` CLI - that required `psql` to
// be installed on whatever machine runs `npm run migrate`, which most
// hosting platforms (Render, Railway, etc.) do NOT include in their default
// Node build image. Using `pg` here means migrations run anywhere Node
// runs, with zero extra system dependencies.
//
// All migrations in this project are written to be safe to re-run
// (IF NOT EXISTS / ON CONFLICT DO NOTHING / existence checks), so running
// this on every deploy is intentional and safe.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function main() {
  const dir = path.join(__dirname, '..', 'src', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded (001_, 002_, ...), so plain sort = correct order

  for (const file of files) {
    console.log(`-- running ${file}`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }

  console.log(`Done. Ran ${files.length} migration file(s).`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
