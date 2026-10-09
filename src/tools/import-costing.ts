/**
 * Copies legacy's cost model and trip actuals here (todo/money-model.md, "Design: the rest of Money";
 * migration 160): the cost template, plans, rented boats, restaurants and the routes' restaurant,
 * the pier's meal orders with their notes and overnight choices, and the pier job sheet's day venue.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:costing [-- --commit]
 *
 * Without `--commit` it is a dry run: the writes happen in one transaction on the target, the report
 * is printed, and the transaction is rolled back. The source is opened read-only either way.
 *
 * Legacy is master until Money moves: the template, plans and rents are replaced whole on every run
 * (an edit made here is lost), venues and route links upserted; trip actuals are upserted on date and
 * boat, keeping a close or "ran" made here. Run after `seed:routes`, `seed:boats` and `import-legacy.ts`
 * (overnight choices name the imported `lg_` bookings). The mapping is `legacy-costing.ts`'s; rows are
 * written by the store itself (`moneyRepo`), so an imported row is stored as one written through the API.
 */
import { Client } from 'pg';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { mapLegacyCosting, mergeActual } from './legacy-costing.js';

type Row = Record<string, unknown>;
const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

class DryRun extends Error {}

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  await source.connect();
  const rows = async (sql: string): Promise<Row[]> => (await source.query(sql)).rows as Row[];
  let src;
  try {
    src = {
      meta: await rows(`SELECT key, value FROM app_meta WHERE key IN ('cost_template', 'cost_plans', 'boat_rent')`),
      venues: await rows('SELECT * FROM meal_venues ORDER BY id'),
      routes: await rows('SELECT id, mealvenueid FROM routes'),
      actuals: await rows('SELECT key, value FROM trip_actuals ORDER BY key'),
      pierJobs: await rows('SELECT key, value FROM pier_job ORDER BY key'),
    };
  } finally { await source.end(); }

  const store = new PostgresOperationsStore(targetUrl!);
  const skipped: string[] = [];
  const notes = new Map<string, number>();
  const report = { skip: (kind: string, id: string, reason: string) => { skipped.push(`${kind} ${id}: ${reason}`); }, note: (what: string) => { notes.set(what, (notes.get(what) ?? 0) + 1); } };
  try {
    const boats = new Set((await store.boatRecords()).map((b) => b.id));
    if (!boats.size) throw new Error('Target has no boats: run seed:boats first');
    const routes = await store.listRoutes();
    const routeKeys = new Set([...routes.flatMap((r) => [r.id, ...(r.family_id ? [r.family_id] : [])]), ...(await store.listRouteFamilies()).map((f) => f.id)]);
    const db = new Client({ connectionString: targetUrl });
    await db.connect();
    const bookings = new Set(((await db.query("SELECT id FROM bookings WHERE id LIKE 'lg\\_%'")).rows as { id: string }[]).map((r) => r.id));
    await db.end();
    const out = mapLegacyCosting(src, { routeKeys, routes: new Set(routes.map((r) => r.id)), boats, bookings, prefix: 'lg_', now: new Date().toISOString() }, report);
    const counts = await store.transaction(async () => {
      const repo = store.moneyRepo;
      if (out.template) await repo.putTemplate({ ...out.template, updated_at: new Date().toISOString(), updated_by: null });
      await repo.replacePlans(out.plans);
      await repo.replaceRents(out.rents);
      for (const v of out.venues) await repo.putVenue(v);
      for (const r of out.routeVenues) await store.setRouteMealVenue(r.route_id, r.venue_id);
      let kept = 0;
      for (const a of out.actuals) {
        const mine = await repo.tripActual(a.service_date, a.boat_id);
        if (mine && (mine.closed || mine.ran) && !(a.closed || a.ran)) kept += 1;
        await repo.putTripActual(mergeActual(mine, a));
      }
      const lines = {
        template: out.template ? `${out.template.lines.length} lines, VAT ${out.template.vat_rate}%` : 'none in legacy (the default applies)',
        plans: `${out.plans.length} (with a route ${out.plans.filter((p) => p.route_key).length}, with a boat ${out.plans.filter((p) => p.boat_id).length})`,
        rents: `${out.rents.length} (rented ${out.rents.filter((r) => r.rented).length})`,
        venues: `${out.venues.length}; routes linked ${out.routeVenues.filter((r) => r.venue_id).length}`,
        actuals: `${out.actuals.length} boat-days (meals ${out.actuals.filter((a) => a.meal).length}, ฿${out.actuals.reduce((s, a) => s + (a.meal?.amount ?? 0), 0).toLocaleString('en-US')}; `
          + `notes ${out.actuals.filter((a) => a.meal_note).length}; overnight ${out.actuals.reduce((s, a) => s + Object.keys(a.meal_overnight).length, 0)}; `
          + `day venue ${out.actuals.filter((a) => a.venue_id || a.no_meal).length}; closed ${out.actuals.filter((a) => a.closed).length}; ran ${out.actuals.filter((a) => a.ran).length}; `
          + `close/ran kept from here ${kept})`,
      };
      if (!commit) throw Object.assign(new DryRun('dry run'), { lines });
      return lines;
    }).catch((error: unknown) => {
      if (error instanceof DryRun) return (error as DryRun & { lines: Record<string, string> }).lines;
      throw error;
    });
    console.log(commit ? 'Committed.' : 'Dry run (rolled back). Run with --commit to write.');
    for (const [what, line] of Object.entries(counts)) console.log(`  ${what.padEnd(9)} ${line}`);
    if (skipped.length) { console.log(`Skipped (${skipped.length}):`); for (const s of skipped) console.log(`  ${s}`); }
    if (notes.size) { console.log('Notes:'); for (const [what, n] of notes) console.log(`  ${n > 1 ? `${n} × ` : ''}${what}`); }
  } finally { await store.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
