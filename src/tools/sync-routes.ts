/**
 * Copies the route catalogue from the legacy monolith (`operation_schemas`) into this service.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run sync:routes [-- --commit]
 *
 * Re-runnable on purpose: ops still edits routes in legacy until the catalogue write endpoints exist,
 * so this is run again whenever legacy has moved. Without `--commit` it is a dry run: every write
 * happens inside one transaction on the target, the diff is printed, and the transaction is rolled
 * back. The source is opened read-only either way.
 *
 * Legacy wins for every route it has: the row is updated, and its departure times are replaced by
 * legacy's set. A route only this service has is reported and left alone, never deleted, because
 * bookings may refer to it. A legacy row that does not map is skipped and listed, never guessed.
 *
 * **The calendar is not legacy's any more** (2026-10-08, `todo/route-calendar-rules-model.md`): it
 * is edited through `/v1/routes/{id}/seasons` and `/days`. A route new to this service brings its
 * seasons and day overrides once, so it does not start open every day; after that they are never
 * overwritten, and where legacy's differ the run only reports it.
 *
 * Needs migration 021 (`routes.kind`, `routes.ext_id`) on the target.
 */
import { Client } from 'pg';
import { isIsoDate, isIsoTime, isRouteKind, type RouteKind } from '../domain/calendar.js';

type Row = Record<string, unknown>;

const commit = process.argv.includes('--commit');
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

const skipped: { kind: string; id: string; reason: string }[] = [];
const skip = (kind: string, id: string, reason: string) => { skipped.push({ kind, id, reason }); };

const str = (value: unknown): string => (value == null ? '' : String(value).trim());
/** Empty strings become null, so a blank legacy column is "unset" here rather than "set to nothing". */
const text = (value: unknown): string | null => str(value) || null;

type RouteRow = { id: string; name: string; kind: RouteKind; ext_id: string | null; pier: string | null; family_id: string | null; color: string | null; islands: string | null; sort: number | null };
const ROUTE_FIELDS = ['name', 'kind', 'ext_id', 'pier', 'family_id', 'color', 'islands', 'sort'] as const;

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const read = async (client: Client, sql: string) => (await client.query(sql)).rows as Row[];

    const { rows: [migrated] } = await target.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'routes' AND column_name IN ('kind', 'ext_id')`);
    if (migrated.n !== 2) throw new Error('Target is missing routes.kind / routes.ext_id: apply migration 021 first (npm run db:migrate)');

    // ── Read legacy and map it to our rows ──
    const routes: RouteRow[] = [];
    for (const r of await read(source, 'SELECT * FROM routes ORDER BY sort NULLS LAST, id')) {
      const id = str(r.id), name = str(r.name);
      if (!id) { skip('route', '(blank)', 'no id'); continue; }
      if (!name) { skip('route', id, 'no name'); continue; }
      // Legacy leaves kind blank on its older routes, all of them boat programmes.
      const kind = str(r.kind) || 'marine';
      if (!isRouteKind(kind)) { skip('route', id, `kind "${kind}" is neither marine nor land`); continue; }
      const sort = r.sort == null ? null : Number(r.sort);
      routes.push({ id, name, kind, ext_id: text(r.extid), pier: text(r.pier), family_id: text(r.familyid), color: text(r.color), islands: text(r.islands), sort: Number.isFinite(sort) ? sort : null });
    }
    const synced = new Set(routes.map((r) => r.id));
    const known = (what: string, routeId: string) => { if (!synced.has(routeId)) { skip(what, routeId, 'route not synced'); return false; } return true; };

    const times: Row[] = [];
    for (const t of await read(source, 'SELECT routes_id, idx, value FROM routes__times ORDER BY routes_id, idx')) {
      const routeId = str(t.routes_id), at = str(t.value);
      if (!known('time', routeId)) continue;
      if (!isIsoTime(at)) { skip('time', routeId, `"${at}" is not HH:MM`); continue; }
      times.push({ route_id: routeId, idx: times.filter((x) => x.route_id === routeId).length, departs_at: at });
    }

    const seasons: Row[] = [];
    for (const s of await read(source, 'SELECT routes_id, id, type, "from", "to" FROM routes__seasons ORDER BY routes_id, "from"')) {
      const routeId = str(s.routes_id), id = str(s.id), kind = str(s.type), from = str(s.from), to = str(s.to);
      if (!known('season', routeId)) continue;
      if (!id) { skip('season', routeId, 'no id'); continue; }
      if (kind !== 'open' && kind !== 'closed') { skip('season', id, `type "${kind}"`); continue; }
      if (!isIsoDate(from) || !isIsoDate(to)) { skip('season', id, `dates "${from}".."${to}" are not YYYY-MM-DD`); continue; }
      if (to < from) { skip('season', id, `ends ${to} before it starts ${from}`); continue; }
      seasons.push({ id, route_id: routeId, kind, from_date: from, to_date: to });
    }

    const overrides: Row[] = [];
    for (const o of await read(source, 'SELECT routes_id, key, value FROM routes__overrides ORDER BY routes_id, key')) {
      // The value is a JSON string, stored with its quotes: `"closed"`.
      const routeId = str(o.routes_id), day = str(o.key), kind = str(o.value).replace(/^"|"$/g, '');
      if (!known('override', routeId)) continue;
      if (!isIsoDate(day)) { skip('override', `${routeId} ${day}`, 'date is not YYYY-MM-DD'); continue; }
      if (kind !== 'open' && kind !== 'closed') { skip('override', `${routeId} ${day}`, `value "${kind}"`); continue; }
      overrides.push({ route_id: routeId, service_date: day, kind });
    }

    // ── Diff against what the target holds now ──
    const before = new Map((await read(target, 'SELECT id, name, kind, ext_id, pier, family_id, color, islands, sort::int AS sort FROM routes')).map((r) => [String(r.id), r]));
    const keyed = async (sql: string) => {
      const sets = new Map<string, Set<string>>();
      for (const r of await read(target, sql)) (sets.get(String(r.route_id)) ?? sets.set(String(r.route_id), new Set()).get(String(r.route_id))!).add(String(r.k));
      return sets;
    };
    const legacyKeyed = (rows: Row[], key: (r: Row) => string) => {
      const sets = new Map<string, Set<string>>();
      for (const r of rows) (sets.get(String(r.route_id)) ?? sets.set(String(r.route_id), new Set()).get(String(r.route_id))!).add(key(r));
      return sets;
    };
    const children = [
      { what: 'times', ours: await keyed(`SELECT route_id, idx || ' ' || departs_at AS k FROM route_times`), theirs: legacyKeyed(times, (r) => `${r.idx} ${r.departs_at}`) },
      { what: 'seasons', ours: await keyed(`SELECT route_id, id || ' ' || kind || ' ' || from_date::text || '..' || to_date::text AS k FROM route_seasons`), theirs: legacyKeyed(seasons, (r) => `${r.id} ${r.kind} ${r.from_date}..${r.to_date}`) },
      { what: 'overrides', ours: await keyed(`SELECT route_id, service_date::text || ' ' || kind AS k FROM route_day_overrides`), theirs: legacyKeyed(overrides, (r) => `${r.service_date} ${r.kind}`) },
    ];

    const added: string[] = [], changed: string[] = [];
    for (const r of routes) {
      const old = before.get(r.id);
      if (!old) { added.push(`${r.id.padEnd(16)} ${r.kind.padEnd(6)} ${r.name}`); continue; }
      const diffs = ROUTE_FIELDS.filter((f) => (old[f] ?? null) !== r[f]).map((f) => `${f}: ${JSON.stringify(old[f] ?? null)} → ${JSON.stringify(r[f])}`);
      if (diffs.length) changed.push(`${r.id}: ${diffs.join(', ')}`);
    }
    const onlyHere = [...before.keys()].filter((id) => !synced.has(id));
    const childChanges: string[] = [];
    for (const { what, ours, theirs } of children) {
      for (const id of synced) {
        const o = ours.get(id) ?? new Set<string>(), t = theirs.get(id) ?? new Set<string>();
        const plus = [...t].filter((k) => !o.has(k)).length, minus = [...o].filter((k) => !t.has(k)).length;
        const kept = what !== 'times' && before.has(id) ? '  (legacy differs; not copied)' : '';
        if (plus || minus) childChanges.push(`${id.padEnd(16)} ${what.padEnd(9)} +${plus} −${minus}${kept}`);
      }
    }

    // ── Write, in one transaction ──
    await target.query('BEGIN');
    const insert = async (table: string, rows: Row[], conflict = '') => {
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const columns = Object.keys(Object.assign({}, ...chunk));
        const list = columns.map((c) => `"${c}"`).join(', ');
        await target.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ${conflict}`, [JSON.stringify(chunk)]);
      }
    };
    await insert('routes', routes, `ON CONFLICT (id) DO UPDATE SET ${ROUTE_FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ')}`);
    const ids = [...synced];
    await target.query('DELETE FROM route_times WHERE route_id = ANY($1::text[])', [ids]);
    await insert('route_times', times);
    // The calendar is copied for new routes only: an existing route's is edited here now.
    const isNew = (row: Row) => !before.has(String(row.route_id));
    await insert('route_seasons', seasons.filter(isNew));
    await insert('route_day_overrides', overrides.filter(isNew));

    const { rows: [after] } = await target.query(`SELECT
      (SELECT count(*) FROM routes)::int routes, (SELECT count(*) FROM routes WHERE kind = 'land')::int land_routes,
      (SELECT count(*) FROM route_times)::int times, (SELECT count(*) FROM route_seasons)::int seasons,
      (SELECT count(*) FROM route_day_overrides)::int overrides`);

    console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (rolled back)'}`);
    console.log(`read from legacy: ${routes.length} routes, ${times.length} times, ${seasons.length} seasons, ${overrides.length} overrides`);
    console.log('target now holds:', after);
    console.log(`\nnew routes (${added.length}):`);
    for (const line of added) console.log(`  ${line}`);
    console.log(`\nchanged routes (${changed.length}):`);
    for (const line of changed) console.log(`  ${line}`);
    console.log(`\ncalendar changes on existing and new routes (${childChanges.length}):`);
    for (const line of childChanges) console.log(`  ${line}`);
    console.log(`\nroutes only in this service, left alone (${onlyHere.length}):`);
    for (const id of onlyHere) console.log(`  ${id}`);
    console.log(`\nskipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s.kind.padEnd(9)} ${s.id.padEnd(28)} ${s.reason}`);

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
