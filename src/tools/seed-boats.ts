/**
 * Seeds the boat catalogue from the legacy monolith (`operation_schemas.boats`, `boats__docs`,
 * `boats__log`): every field of the boat form, its documents and its status log (migration 070).
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run seed:boats [-- --commit]
 *
 * Boats are edited here since 2026-10-09 (todo/catalogue-editing-model.md): this API is their
 * master, and this replaces `sync:boats`, which let legacy win. A boat this service lacks is added. A
 * boat never edited here (`updated_at` is null: legacy's copy, from migration 006 or an earlier
 * sync) is refreshed from legacy, documents and status log included. **A boat edited here is never
 * touched**; where legacy's differs the run only lists it. Nothing is deleted.
 *
 * Without `--commit` it is a dry run: the writes happen inside one transaction on the target, the
 * report is printed, and the transaction is rolled back. The source is opened read-only either way.
 * The mapping is `legacy-boats.ts`. Deployments copy a boat's numbers when they are imported, so run
 * `import-legacy.ts` afterwards for a boat that is new here.
 */
import { Client } from 'pg';
import { BOAT_MEASURES, BOAT_TEXT_FIELDS, type BoatRecord } from '../domain/catalogue.js';
import { boatFromLegacy } from './legacy-boats.js';

type Row = Record<string, unknown>;

const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

/** Every column `writeBoat` writes, except `id` and `updated_at`. */
const COLUMNS = ['name', 'type', 'pier', 'ownership', 'color', 'engine_count', 'capacity', 'license_pax', 'crew', 'fish_crew', 'registered_persons',
  ...BOAT_TEXT_FIELDS, ...BOAT_MEASURES, 'retired', 'retired_on', 'retired_reason', 'unretired_on'] as const;
/** Fields compared for the report; legacy has no column for `brand`, `model` or the retire stamps. */
const COMPARED = COLUMNS.filter((c) => !['brand', 'model', 'retired_on', 'retired_reason', 'unretired_on'].includes(c));

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const { rows: [migrated] } = await target.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'boat_status_log'`);
    if (migrated.n !== 1) throw new Error('Target has no boat_status_log: apply migration 070 first (npm run db:migrate)');

    const byBoat = (rows: Row[]) => {
      const out = new Map<string, Row[]>();
      for (const r of rows) (out.get(String(r.boats_id)) ?? out.set(String(r.boats_id), []).get(String(r.boats_id))!).push(r);
      return out;
    };
    const docs = byBoat((await source.query('SELECT * FROM boats__docs')).rows);
    const logs = byBoat((await source.query('SELECT * FROM boats__log')).rows);
    const boats: BoatRecord[] = [];
    const skipped: string[] = [], notes: string[] = [];
    for (const row of (await source.query('SELECT * FROM boats ORDER BY id')).rows as Row[]) {
      const mapped = boatFromLegacy(row, docs.get(String(row.id)) ?? [], logs.get(String(row.id)) ?? []);
      if ('skip' in mapped) { skipped.push(`${String(row.id ?? '(no id)').padEnd(16)} ${mapped.skip}`); continue; }
      boats.push(mapped.boat);
      for (const n of mapped.notes) notes.push(`${mapped.boat.id.padEnd(16)} ${n}`);
    }

    const before = new Map(((await target.query(`SELECT b.*, b.retired_on::text AS retired_on, b.unretired_on::text AS unretired_on,
      (SELECT count(*) FROM boat_documents d WHERE d.boat_id = b.id)::int AS doc_count, (SELECT count(*) FROM boat_status_log l WHERE l.boat_id = b.id)::int AS log_count
      FROM boats b`)).rows as Row[]).map((r) => [String(r.id), r]));
    const same = (a: unknown, b: unknown) => (a === null || a === undefined ? null : typeof b === 'number' ? Number(a) : a) === b;
    const added: BoatRecord[] = [], refreshed: BoatRecord[] = [], changedLines: string[] = [], editedHere: string[] = [];
    for (const b of boats) {
      const old = before.get(b.id);
      if (!old) { added.push(b); continue; }
      const diffs = COMPARED.filter((c) => !same(old[c], b[c])).map((c) => `${c}: ${JSON.stringify(old[c] ?? null)} → ${JSON.stringify(b[c])}`);
      const counts = `documents ${old.doc_count} → ${b.documents.length}, status log ${old.log_count} → ${b.status_log.length}`;
      if (old.updated_at !== null) { if (diffs.length) editedHere.push(`${b.id}: ${diffs.join(', ')}`); continue; }
      refreshed.push(b);
      if (diffs.length || Number(old.doc_count) !== b.documents.length || Number(old.log_count) !== b.status_log.length) changedLines.push(`${b.id}: ${[...diffs, counts].join(', ')}`);
    }
    const legacyIds = new Set(boats.map((b) => b.id));
    const onlyHere = [...before.keys()].filter((id) => !legacyIds.has(id));

    await target.query('BEGIN');
    const write = [...added, ...refreshed];
    if (write.length) {
      // `updated_at` stays null: the row is still legacy's copy until someone edits it here.
      await target.query(`INSERT INTO boats (id, ${COLUMNS.join(', ')})
        SELECT id, ${COLUMNS.join(', ')} FROM jsonb_populate_recordset(NULL::boats, $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET ${COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')} WHERE boats.updated_at IS NULL`,
      [JSON.stringify(write.map(({ documents: _d, status_log: _l, ...b }) => b))]);
      const ids = write.map((b) => b.id);
      await target.query('DELETE FROM boat_documents WHERE boat_id = ANY($1::text[])', [ids]);
      await target.query('DELETE FROM boat_status_log WHERE boat_id = ANY($1::text[])', [ids]);
      await target.query('INSERT INTO boat_documents SELECT * FROM jsonb_populate_recordset(NULL::boat_documents, $1::jsonb)',
        [JSON.stringify(write.flatMap((b) => b.documents.map((d, idx) => ({ boat_id: b.id, idx, ...d }))))]);
      await target.query('INSERT INTO boat_status_log SELECT * FROM jsonb_populate_recordset(NULL::boat_status_log, $1::jsonb)',
        [JSON.stringify(write.flatMap((b) => b.status_log.map((e, seq) => ({ boat_id: b.id, seq, ...e }))))]);
    }
    const { rows: [after] } = await target.query(`SELECT (SELECT count(*) FROM boats)::int AS boats, (SELECT count(*) FROM boat_documents)::int AS documents,
      (SELECT count(*) FROM boat_status_log)::int AS status_log, (SELECT count(*) FROM boats WHERE ownership = 'charter')::int AS charter,
      (SELECT count(*) FROM boats WHERE license_pax IS NOT NULL AND capacity > license_pax)::int AS above_licence`);

    console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (rolled back)'}`);
    console.log(`read from legacy: ${boats.length + skipped.length} boats, ${[...docs.values()].flat().length} documents, ${[...logs.values()].flat().length} status entries`);
    console.log('target now holds:', after);
    console.log(`\nnew boats (${added.length}):`);
    for (const b of added) console.log(`  ${b.id.padEnd(16)} ${b.name} — ${b.capacity} seats, licence ${b.license_pax ?? 'none'}, ${b.ownership}`);
    console.log(`\nrefreshed, never edited here (${refreshed.length}); changed (${changedLines.length}):`);
    for (const line of changedLines) console.log(`  ${line}`);
    console.log(`\nedited here, left alone though legacy differs (${editedHere.length}):`);
    for (const line of editedHere) console.log(`  ${line}`);
    console.log(`\nboats only in this service, left alone (${onlyHere.length}):`);
    for (const id of onlyHere) console.log(`  ${id}`);
    console.log(`\nskipped (${skipped.length}):`);
    for (const line of skipped) console.log(`  ${line}`);
    console.log(`\nnotes (${notes.length}):`);
    for (const line of notes) console.log(`  ${line}`);
    if (added.length) console.log('\nRun import-legacy.ts next, so deployments on the new boats are imported.');

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
