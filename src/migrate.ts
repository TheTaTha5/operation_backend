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
try {
  for (const file of files) await client.query(await readFile(join(migrationsDir, file), 'utf8'));
} finally { await client.end(); }
console.log(`Database migrations complete (${files.length}).`);
