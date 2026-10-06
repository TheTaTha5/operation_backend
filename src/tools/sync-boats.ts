/**
 * Copies the boat catalogue from the legacy monolith (`operation_schemas.boats`) into this service.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run sync:boats [-- --commit]
 *
 * Re-runnable for the same reason as `sync:routes`: ops still adds and edits boats in legacy. Without
 * `--commit` it is a dry run — the writes happen inside one transaction on the target, the diff is
 * printed, and the transaction is rolled back. The source is opened read-only either way.
 *
 * Legacy wins for every boat it has. A boat only this service has is reported and left alone, never
 * deleted: deployments and capacity overrides refer to it. The mapping and its capacity rules are in
 * `legacy-boats.ts`; a row that breaks them is skipped and listed.
 *
 * Deployments copy a boat's capacity and licence when they are imported, so after a boat's numbers
 * change, run `import-legacy.ts` to bring its deployments in step.
 */
import { Client } from 'pg';
import { boatFromLegacy, type BoatRow } from './legacy-boats.js';

type Row = Record<string, unknown>;

const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

const FIELDS = ['name', 'type', 'pier', 'capacity', 'license_pax', 'crew'] as const;

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const boats: BoatRow[] = [];
    const skipped: string[] = [], retired: string[] = [];
    for (const row of (await source.query('SELECT * FROM boats ORDER BY id')).rows as Row[]) {
      const boat = boatFromLegacy(row);
      if ('skip' in boat) { skipped.push(`${String(row.id ?? '(no id)').padEnd(16)} ${boat.skip}`); continue; }
      // This service has no retired flag; a retired boat is still a valid deployment target here.
      if (String(row.retired ?? '').trim()) retired.push(boat.id);
      boats.push(boat);
    }

    const before = new Map(((await target.query('SELECT id, name, type, pier, capacity, license_pax, crew FROM boats')).rows as Row[]).map((r) => [String(r.id), r]));
    const added: string[] = [], changed: string[] = [];
    for (const b of boats) {
      const old = before.get(b.id);
      if (!old) { added.push(`${b.id.padEnd(16)} ${b.name} — ${b.capacity} seats, licence ${b.license_pax ?? 'none'}`); continue; }
      const diffs = FIELDS.filter((f) => (old[f] ?? null) !== b[f]).map((f) => `${f}: ${JSON.stringify(old[f] ?? null)} → ${JSON.stringify(b[f])}`);
      if (diffs.length) changed.push(`${b.id}: ${diffs.join(', ')}`);
    }
    const synced = new Set(boats.map((b) => b.id));
    const onlyHere = [...before.keys()].filter((id) => !synced.has(id));

    await target.query('BEGIN');
    await target.query(`INSERT INTO boats (id, ${FIELDS.join(', ')})
      SELECT id, ${FIELDS.join(', ')} FROM jsonb_populate_recordset(NULL::boats, $1::jsonb)
      ON CONFLICT (id) DO UPDATE SET ${FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ')}`, [JSON.stringify(boats)]);
    const { rows: [after] } = await target.query('SELECT count(*)::int AS boats FROM boats');

    console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (rolled back)'}`);
    console.log(`read from legacy: ${boats.length + skipped.length} boats; target now holds ${after.boats}`);
    console.log(`\nnew boats (${added.length}):`);
    for (const line of added) console.log(`  ${line}`);
    console.log(`\nchanged boats (${changed.length}):`);
    for (const line of changed) console.log(`  ${line}`);
    console.log(`\nboats only in this service, left alone (${onlyHere.length}):`);
    for (const id of onlyHere) console.log(`  ${id}`);
    console.log(`\nretired in legacy, synced anyway (${retired.length}):`);
    for (const id of retired) console.log(`  ${id}`);
    console.log(`\nskipped (${skipped.length}):`);
    for (const line of skipped) console.log(`  ${line}`);
    if (added.length || changed.length) console.log('\nRun import-legacy.ts next, so deployments on these boats are imported and carry their numbers.');

    await target.query(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

await main();
