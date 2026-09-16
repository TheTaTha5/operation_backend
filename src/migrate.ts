import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 2000;

/**
 * `preDeployCommand` can start before Railway's private network is routable, so the first dial to
 * `*.railway.internal` sometimes gets torn down mid-connect ("Connection terminated unexpectedly")
 * rather than refused outright. A fresh `Client` per attempt, since one that failed to connect is
 * not safe to retry on.
 */
async function connectWithRetry(): Promise<Client> {
  for (let attempt = 1; ; attempt++) {
    const client = new Client({ connectionString });
    // pg emits 'error' on the client even for a failure during connect() itself; with no
    // listener that's an unhandled EventEmitter error that crashes the process before the
    // catch below ever runs. A no-op listener routes it through the rejected connect() promise.
    client.on('error', () => {});
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if (attempt >= CONNECT_ATTEMPTS) throw error;
      console.warn(`  ! database connection attempt ${attempt}/${CONNECT_ATTEMPTS} failed (${(error as Error).message}) — retrying in ${CONNECT_RETRY_DELAY_MS}ms`);
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }
}

const client = await connectWithRetry();
// pg.Client emits 'error' on an unexpected disconnect after connect() resolved (e.g. the
// private network dropping mid-migration). Without a listener that's an unhandled EventEmitter
// error and crashes the process outright, bypassing every try/catch below.
client.on('error', (error) => {
  console.error(`  ! database connection lost: ${(error as Error).message}`);
});

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
