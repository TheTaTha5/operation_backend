import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
const client = new Client({ connectionString });
await client.connect();
let applied = 0;
try {
  // One migrator at a time: a second instance deploying concurrently waits here instead of racing.
  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['operation-backend:migrate']);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
  const ledger = new Map(rows.map((row): [string, string] => [String(row.name), String(row.checksum)]));

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const recorded = ledger.get(file);
    if (recorded !== undefined) {
      // Editing an applied migration leaves this database permanently different from a freshly migrated one.
      if (recorded !== checksum) console.warn(`  ! ${file} has changed since it was applied — this database no longer matches a fresh migration`);
      continue;
    }
    // The statements and the ledger row commit together, so a failure can never record a half-applied migration.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
    console.log(`  + ${file}`);
    applied += 1;
  }
} finally { await client.end(); }
console.log(`Database migrations complete (${applied} applied, ${files.length - applied} already recorded).`);
