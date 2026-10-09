/**
 * Seeds fleet maintenance, part A (todo/fleet-maintenance-model.md; migration 130) from legacy:
 * engines, gearboxes, propellers and their histories, incidents and maintenance jobs; and the boats'
 * pier assignments (fleet extras, migration 190).
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:fleet [-- --commit]
 *
 * Without `--commit` it is a dry run: the writes happen in one transaction on the target, the report
 * is printed, and the transaction is rolled back. The source is opened read-only either way.
 *
 * A seed, as `--sales` is: fleet is this API's from 2026-10-09, so run it once, before anyone edits
 * fleet here. Legacy's ids are kept and upserted, each record's lists (history, damaged assets,
 * parts, progress) replaced whole; a record created here is left alone. Run it after `seed:boats`:
 * a record on a boat this service does not have is skipped or left off its boat, and listed. The
 * mapping is `legacy-fleet.ts`'s; rows are written by the store itself (`putFleet*`), so an imported
 * record is stored exactly as one written through the API.
 */
import { Client } from 'pg';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { mapLegacyAssignments, mapLegacyFleet } from './legacy-fleet.js';

type Row = Record<string, unknown>;
const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

class DryRun extends Error {}

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  await source.connect();
  const rows = async (table: string): Promise<Row[]> => (await source.query(`SELECT * FROM ${table}`)).rows as Row[];
  let src;
  try {
    src = {
      engines: await rows('fleet_engines'), engineLog: await rows('fleet_engines__log'),
      gearboxes: await rows('fleet_gearboxes'), gearboxLog: await rows('fleet_gearboxes__log'),
      propellers: await rows('fleet_propellers'), propellerLog: await rows('fleet_propellers__log'),
      incidents: await rows('fleet_incidents'), incidentAssets: await rows('fleet_incidents__damagedassets'),
      incidentLog: await rows('fleet_incidents__progresslog'), incidentJobs: await rows('fleet_incidents__relatedmaintids'),
      jobs: await rows('fleet_maintenance'), jobAssets: await rows('fleet_maintenance__assets'),
      jobParts: await rows('fleet_maintenance__parts'), jobLog: await rows('fleet_maintenance__progresslog'),
      assignments: await rows('boats__assignments'),
    };
  } finally { await source.end(); }

  const store = new PostgresOperationsStore(targetUrl!);
  const skipped: string[] = [];
  const notes = new Map<string, number>();
  const report = { skip: (kind: string, id: string, reason: string) => { skipped.push(`${kind} ${id}: ${reason}`); }, note: (what: string) => { notes.set(what, (notes.get(what) ?? 0) + 1); } };
  try {
    const boats = new Set((await store.boatRecords()).map((b) => b.id));
    if (!boats.size) throw new Error('Target has no boats: run seed:boats first');
    const out = mapLegacyFleet(src, { boats }, report);
    const assignments = mapLegacyAssignments(src.assignments ?? [], { boats }, report);
    const counts = await store.transaction(async () => {
      for (const a of assignments) await store.fleetRepo.putAssignment(a);
      for (const e of out.engines) await store.putFleetAsset('engine', e);
      for (const g of out.gearboxes) await store.putFleetAsset('gearbox', g);
      for (const p of out.propellers) await store.putFleetAsset('propeller', p);
      for (const i of out.incidents) await store.putFleetIncident(i);
      for (const j of out.jobs) await store.putFleetJob(j);
      const lines = {
        engines: `${out.engines.length} (history ${out.engines.reduce((s, e) => s + e.log.length, 0)})`,
        gearboxes: `${out.gearboxes.length} (history ${out.gearboxes.reduce((s, e) => s + e.log.length, 0)})`,
        propellers: `${out.propellers.length} (history ${out.propellers.reduce((s, e) => s + e.log.length, 0)})`,
        incidents: `${out.incidents.length} (damaged assets ${out.incidents.reduce((s, i) => s + i.damaged_assets.length, 0)}, progress ${out.incidents.reduce((s, i) => s + i.progress_log.length, 0)})`,
        assignments: `${assignments.length} of ${src.assignments?.length ?? 0} (cancelled ${assignments.filter((a) => a.cancelled).length})`,
        jobs: `${out.jobs.length} (assets ${out.jobs.reduce((s, j) => s + j.assets.length, 0)}, parts ${out.jobs.reduce((s, j) => s + j.parts.length, 0)}, progress ${out.jobs.reduce((s, j) => s + j.progress_log.length, 0)}, legacy cost ฿${out.jobs.reduce((s, j) => s + (j.legacy_cost ?? 0), 0).toLocaleString('en-US')})`,
      };
      if (!commit) throw Object.assign(new DryRun('dry run'), { lines });
      return lines;
    }).catch((error: unknown) => {
      if (error instanceof DryRun) return (error as DryRun & { lines: Record<string, string> }).lines;
      throw error;
    });
    console.log(commit ? 'Committed.' : 'Dry run (rolled back). Run with --commit to write.');
    for (const [what, line] of Object.entries(counts)) console.log(`  ${what.padEnd(11)} ${line}`);
    if (skipped.length) { console.log(`Skipped (${skipped.length}):`); for (const s of skipped) console.log(`  ${s}`); }
    if (notes.size) { console.log('Notes:'); for (const [what, n] of notes) console.log(`  ${n > 1 ? `${n} × ` : ''}${what}`); }
  } finally { await store.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
