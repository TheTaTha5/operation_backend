/**
 * Copies legacy's files (`allotment.attachments`, bytea) that something points at into this service's
 * `attachments` (todo/booking-extras-model.md §1, decided 2026-10-09: the referenced files only).
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:attachments [-- --commit]
 *
 * Without `--commit` it only counts. With it, files are copied in batches, each batch committed on its
 * own: a file never changes, so a rerun skips what is already here and picks up where it stopped. Run
 * it before the main import (`import-legacy.ts`), which links bookings' documents and upgrade slips to
 * the files that exist. The source is opened read-only.
 *
 * Referenced means named by any legacy record: a booking's documents, payment slips and pier payment
 * slips, upgrade and on-tour extra slips, invoice payment slips, cash-on-tour slips and fleet project
 * documents. Files nobody names (drafts, failed uploads) and the daily-report chart images stay behind.
 */
import { Client } from 'pg';

const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');
const MIMES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const MAX = 6 * 1024 * 1024;
const BATCH = 50;

/** Every `{id}` (or `attId`) in a JSON text column, walking nested lists (`pierPayments[].slips[]`). */
function refsIn(value: unknown, out: Set<string>): void {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return; } }
  if (Array.isArray(v)) { for (const x of v) refsIn(x, out); return; }
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  for (const key of ['id', 'attId']) if (typeof o[key] === 'string' && /^att_/.test(o[key] as string)) out.add(o[key] as string);
  for (const key of ['slips', 'docs']) if (o[key] !== undefined) refsIn(o[key], out);
}

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const wanted = new Set<string>();
    const sources: [string, string][] = [
      ['sb_bookings', 'attachments'], ['sb_bookings', 'paymentslips'], ['sb_bookings', 'pierpayments'], ['sb_bookings__upgrades', 'slips'],
      ['sb_extras', 'slips'], ['sb_payments', 'slips'], ['ts_cot', 'slips'], ['fleet_projects', 'docs'],
    ];
    for (const [table, column] of sources) {
      try {
        const before = wanted.size;
        for (const row of (await source.query(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)).rows) refsIn(row.v, wanted);
        console.log(`${table}.${column}: ${wanted.size - before} more files named`);
      } catch (error) { console.log(`${table}.${column}: not read (${(error as Error).message})`); }
    }
    const have = new Set((await target.query('SELECT id FROM attachments')).rows.map((r) => String(r.id)));
    const meta = (await source.query('SELECT id, mime, size FROM allotment.attachments WHERE id = ANY($1::text[])', [[...wanted]])).rows;
    const missing = wanted.size - meta.length;
    const fits = meta.filter((m) => MIMES.has(String(m.mime)) && Number(m.size) > 0 && Number(m.size) <= MAX);
    const todo = fits.filter((m) => !have.has(String(m.id))).map((m) => String(m.id));
    console.log(`${wanted.size} files named; ${missing} not in legacy's store; ${meta.length - fits.length} of a kind or size the API refuses; ${fits.length - todo.length} already here; ${todo.length} to copy`);
    if (!commit) { console.log('DRY RUN: nothing copied (add --commit)'); return; }
    let copied = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const { rows } = await source.query('SELECT id, booking_id, filename, mime, size, data, uploaded_by, created_at FROM allotment.attachments WHERE id = ANY($1::text[])', [todo.slice(i, i + BATCH)]);
      await target.query('BEGIN');
      for (const r of rows) {
        await target.query(`INSERT INTO attachments (id, filename, mime, size, data, uploaded_by, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [r.id, String(r.filename || r.id), r.mime, (r.data as Buffer).length, r.data, r.uploaded_by ?? null, r.created_at ?? new Date()]);
      }
      await target.query('COMMIT');
      copied += rows.length;
      console.log(`copied ${copied} / ${todo.length}`);
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
