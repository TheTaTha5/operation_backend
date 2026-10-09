/**
 * Imports legacy fleet part B (todo/fleet-maintenance-model.md, "Design — part B"): stock items and
 * their history, consumables, purchase memos, projects, the Daily Fleet Log and its extras, safety
 * equipment. The mapping is `legacy-fleet.ts`.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run import:fleet [-- --commit]
 *
 * Run it after `seed:boats` and `import:attachments` (project documents link to the copied files).
 * Without `--commit` it is a dry run: everything is written in one transaction, the report printed,
 * and the transaction rolled back. The source is opened read-only.
 *
 * Until the fleet area cuts over, legacy is its master and a rerun mirrors it: rows are upserted by
 * legacy's id, and what hangs under an imported row is replaced (memo lines, a project's plan,
 * documents, visits and log, a safety item's inspections and log, every imported movement `lg_…`).
 * Rows created here keep their own ids and are not touched. Nothing is deleted when legacy drops a
 * row; such rows stay here.
 */
import { Client, type PoolClient } from 'pg';
import { PostgresFleetRepo } from '../domain/fleet-postgres.js';
import { todayInThailand } from '../domain/calendar.js';
import { mapConsumables, mapDaily, mapMemos, mapProjects, mapSafety, mapStock, type Listed } from './legacy-fleet.js';

const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  const read = async (sql: string) => (await source.query(sql)).rows as Record<string, unknown>[];
  try {
    const now = new Date().toISOString();
    const today = todayInThailand();
    const legacy = {
      items: await read('SELECT * FROM fleet_inventory'), stocks: await read('SELECT * FROM fleet_inventory__stocks'),
      history: await read('SELECT * FROM fleet_inventory__history'), changes: await read('SELECT * FROM fleet_inventory__history__changes'),
      memos: await read('SELECT * FROM fleet_memos'), lines: await read('SELECT * FROM fleet_memos__items'),
      consumables: await read('SELECT * FROM fleet_consumable_logs'),
      projects: await read('SELECT * FROM fleet_projects'), projectLog: await read('SELECT * FROM fleet_projects__log'), plan: await read('SELECT * FROM fleet_projects__plan'),
      boatDays: await read('SELECT * FROM fleet_daily__boat'), trips: await read('SELECT * FROM fleet_daily__trips'), days: await read('SELECT * FROM fleet_daily'),
      prices: await read('SELECT * FROM fleet_fuelprice'), locks: await read('SELECT * FROM fleet_drlock'),
      meta: Object.fromEntries((await read("SELECT key, value FROM app_meta WHERE key IN ('fl_issue_items', 'fl_issue', 'fl_water', 'fl_extra', 'fl_req')")).map((r) => [r.key, r.value])),
      safety: await read('SELECT * FROM fleet_safety'), inspections: await read('SELECT * FROM fleet_safety__inspections'), safetyLog: await read('SELECT * FROM fleet_safety__log'),
    };
    const boats = new Set((await target.query('SELECT id FROM boats')).rows.map((r) => r.id as string));
    const docFiles = legacy.projects.flatMap((p) => { try { const d = JSON.parse(String(p.docs ?? '[]')); return Array.isArray(d) ? d.map((x) => x.attId).filter(Boolean) : []; } catch { return []; } });
    const attachments = new Set((await target.query('SELECT id FROM attachments WHERE id = ANY($1)', [docFiles])).rows.map((r) => r.id as string));

    const projects = mapProjects({ projects: legacy.projects, log: legacy.projectLog, plan: legacy.plan, boats, attachments }, now);
    const itemIds = new Set(legacy.items.map((r) => String(r.id)));
    const memos = mapMemos({ memos: legacy.memos, lines: legacy.lines, boats, projects: new Set(projects.projects.map((p) => p.id)), items: itemIds }, now);
    const consumables = mapConsumables({ rows: legacy.consumables, items: itemIds, boats }, now);
    const byNo = new Map<string, string[]>();
    for (const m of memos.memos) byNo.set(m.no, [...(byNo.get(m.no) ?? []), m.id]);
    const memoIdByNo = new Map([...byNo].filter(([, ids]) => ids.length === 1).map(([no, ids]) => [no, ids[0]]));
    const stock = mapStock({ items: legacy.items, stocks: legacy.stocks, history: legacy.history, changes: legacy.changes, memoIdByNo,
      consumableIds: new Set(consumables.consumables.map((c) => c.id)) }, now, today);
    const daily = mapDaily({ boatDays: legacy.boatDays, trips: legacy.trips, prices: legacy.prices, locks: legacy.locks, meta: legacy.meta, boats }, now);
    const safety = mapSafety({ items: legacy.safety, inspections: legacy.inspections, log: legacy.safetyLog, boats }, now);

    await target.query('BEGIN');
    const repo = new PostgresFleetRepo(() => target as unknown as PoolClient);
    await target.query("SET LOCAL fleet.import_rewrite = 'on'");
    await target.query("DELETE FROM fleet_stock_movements WHERE id LIKE 'lg\\_%'");
    await repo.putItems(stock.items);
    await target.query('DELETE FROM fleet_project_log WHERE project_id = ANY($1)', [projects.projects.map((p) => p.id)]);
    for (const p of projects.projects) await repo.putProject(p);
    await repo.addProjectLog(projects.logs);
    for (const m of memos.memos) await repo.putMemo(m);
    for (const c of consumables.consumables) await repo.putConsumable(c);
    await repo.addMovements(stock.movements);
    for (const r of daily.boats) await repo.putDailyBoat(r);
    for (const r of daily.meters) await repo.putMeter(r);
    for (const r of daily.prices) await repo.putFuelPrice(r.date, r.key, r.price);
    for (const r of daily.locks) await repo.putLock(r);
    for (const r of daily.issueItems) await repo.putIssueItem(r);
    for (const r of daily.issues) await repo.putIssue(r);
    for (const r of daily.water) await repo.putWater(r);
    for (const r of daily.extras) await repo.putExtra(r);
    for (const r of daily.requests) await repo.putRequest(r);
    await target.query('DELETE FROM fleet_safety_log WHERE item_id = ANY($1)', [safety.items.map((i) => i.id)]);
    for (const i of safety.items) await repo.putSafety(i);
    await repo.addSafetyLog(safety.logs);

    const counts: [string, number, number][] = [
      ['stock items', legacy.items.length, stock.items.length], ['movements (history rows)', legacy.history.length, stock.movements.filter((m) => m.type !== 'import').length],
      ['  import reconciliation movements', 0, stock.movements.filter((m) => m.type === 'import').length],
      ['  receipts linked to their memo', 0, stock.movements.filter((m) => m.memo_id).length],
      ['memos', legacy.memos.length, memos.memos.length], ['memo lines', legacy.lines.length, memos.memos.reduce((s, m) => s + m.lines.length, 0)],
      ['consumables', legacy.consumables.length, consumables.consumables.length],
      ['projects', legacy.projects.length, projects.projects.length], ['project log lines', legacy.projectLog.length, projects.logs.length],
      ['project plan items', legacy.plan.length, projects.projects.reduce((s, p) => s + p.plan.length, 0)],
      ['project documents', 0, projects.projects.reduce((s, p) => s + p.documents.length, 0)],
      ['  with an uploaded file', 0, projects.projects.reduce((s, p) => s + p.documents.filter((d) => d.attachment_id).length, 0)],
      ['Daily Log days', legacy.days.length, new Set([...daily.boats, ...daily.meters].map((r) => r.date)).size],
      ['  boat-days with fuel or pax', legacy.boatDays.length, daily.boats.length], ['  meter readings', 0, daily.meters.length],
      ['fuel-price days', legacy.prices.length, new Set(daily.prices.map((p) => p.date)).size], ['  prices', 0, daily.prices.length],
      ['locked pier-days', legacy.locks.length, daily.locks.length], ['issue items', 0, daily.issueItems.length],
      ['issued-item boat-days', 0, new Set(daily.issues.map((r) => `${r.date}|${r.boat_id}`)).size], ['water boat-days', 0, daily.water.length],
      ['extra items', 0, daily.extras.length], ['outside requests', 0, daily.requests.length],
      ['safety items', legacy.safety.length, safety.items.length], ['  inspections', legacy.inspections.length, safety.items.reduce((s, i) => s + i.inspections.length, 0)],
      ['  log rows', legacy.safetyLog.length, safety.logs.length],
    ];
    console.log('What                                  legacy   imported');
    for (const [what, l, n] of counts) console.log(`${what.padEnd(38)}${String(l || '').padStart(6)} ${String(n).padStart(10)}`);
    console.log('\nNotes:');
    for (const [k, n] of Object.entries(stock.notes)) console.log(`  ${n} ${k}`);
    const listed: Listed[] = [...stock.listed, ...memos.listed, ...consumables.listed, ...projects.listed, ...daily.listed, ...safety.listed];
    const kinds = new Map<string, Listed[]>();
    for (const l of listed) kinds.set(l.kind, [...(kinds.get(l.kind) ?? []), l]);
    console.log(`\nListed (${listed.length}):`);
    for (const [kind, rows] of kinds) {
      console.log(`  ${kind}: ${rows.length}`);
      for (const r of rows.slice(0, process.argv.includes('--all') ? rows.length : 8)) console.log(`    ${r.id}: ${r.reason}`);
      if (rows.length > 8 && !process.argv.includes('--all')) console.log(`    … ${rows.length - 8} more (--all lists every row)`);
    }
    await target.query(commit ? 'COMMIT' : 'ROLLBACK');
    console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (rolled back)'}`);
  } catch (error) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
