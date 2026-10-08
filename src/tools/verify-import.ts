/**
 * Checks what `import-legacy.ts` wrote against what legacy holds: one report of every difference.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run verify:import [-- --limit=20] [--json=report.json]
 *
 * Read-only on both databases. Run it after an import with `--commit`, against the local Docker copy
 * (`docker compose --profile pull run --rm pull`, then the import), never against production: the
 * import's dry run rolls back, so there is nothing to compare until it commits somewhere.
 *
 * The importer's own report says what it wrote and what it skipped. This says whether what it wrote
 * means what legacy meant. It does not share the importer's code (see `verify-legacy.ts`), so a
 * mapping bug shows up here as a difference instead of on both sides of the comparison. Four levels:
 *
 *   1. every row accounted for: bookings, trips, passengers, history, locks, deployments, overrides,
 *      agents, markets, salespeople, rate types and vans are each present on both sides;
 *   2. every column accounted for: legacy columns that hold data but that no import code names;
 *   3. the same values, booking by booking: the header, each trip (route, date, mode, pax, pickup,
 *      overnight) and the passengers;
 *   4. the same totals: passengers per route and day, revenue per month, locked seats and boats
 *      per route and day.
 *
 * A difference is not necessarily a bug: a booking the importer skipped on purpose is missing here
 * too. The report lists each one so a person can tell which. Exit code 1 when any check differs.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { routeCalendar, type RouteDayOverride, type RouteSeason } from '../domain/calendar.js';
import {
  BOOKING_HEADER, countDiff, legacyLockDays, legacyPax, legacyValue, RELEASED, same, samePickup, setDiff, targetPax, unreadColumns, type Row,
} from './verify-legacy.js';

const PREFIX = 'lg_';
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice(8) ?? 10);
const jsonOut = process.argv.find((a) => a.startsWith('--json='))?.slice(7);
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const groupBy = (rows: Row[], key: string): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  for (const r of rows) { const k = str(r[key]); (out.get(k) ?? out.set(k, []).get(k)!).push(r); }
  return out;
};
const add = (m: Map<string, number>, k: string, n: number) => { if (n) m.set(k, (m.get(k) ?? 0) + n); };

/** One check's result. `differ` lines are the differences; `info` is worth reading but not a failure. */
type Check = { level: number; name: string; compared: number; differ: string[]; info?: string[] };
const checks: Check[] = [];
const check = (level: number, name: string, compared: number, differ: string[], info?: string[]) => { checks.push({ level, name, compared, differ, info }); };

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl, options: '-c default_transaction_read_only=on' });
  await source.connect();
  await target.connect();
  try {
    const L = async (sql: string) => (await source.query(sql)).rows as Row[];
    const T = async (sql: string) => (await target.query(sql)).rows as Row[];
    const tCols = async (table: string) => new Set((await T(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}'`)).map((r) => str(r.column_name)));

    // ── read ──
    const lBookings = await L('SELECT * FROM sb_bookings');
    const lTrips = groupBy(await L('SELECT * FROM sb_bookings__trips ORDER BY sb_bookings_id, idx'), 'sb_bookings_id');
    const lPassengers = groupBy(await L('SELECT * FROM sb_bookings__passengers ORDER BY sb_bookings_id, idx'), 'sb_bookings_id');
    const lHistory = new Map((await L('SELECT sb_bookings_id AS id, count(*)::int AS n FROM sb_bookings__history GROUP BY 1')).map((r) => [str(r.id), Number(r.n)]));
    const lLocks = await L(`SELECT id, routeid, date, qty, status, scope, parentid, pendqty, pendby, datefrom, dateto, dow,
      month, monthfrom, monthto, releaseddates FROM sb_seat_locks`);
    const lBoatDays = await L('SELECT trips_id, key, value FROM trips__boat');
    const lOverrides = await L('SELECT key FROM boat_capovr');

    const tripCols = await tCols('booking_trips');
    const pickupEnd = tripCols.has('pickup_time_end') ? 'pickup_time_end' : 'NULL::text AS pickup_time_end';
    const pickupPier = tripCols.has('pickup_at_pier') ? 'pickup_at_pier' : 'NULL::boolean AS pickup_at_pier';
    const tBookings = await T(`SELECT * FROM bookings WHERE id LIKE '${PREFIX}%'`);
    const tBookingCols = await tCols('bookings');
    const tTrips = groupBy(await T(`SELECT *, ${pickupEnd}, ${pickupPier} FROM booking_trips WHERE booking_id LIKE '${PREFIX}%' ORDER BY booking_id, seq`), 'booking_id');
    const tPax = groupBy(await T(`SELECT p.* FROM booking_trip_pax p JOIN booking_trips t ON t.id = p.booking_trip_id WHERE t.booking_id LIKE '${PREFIX}%'`), 'booking_trip_id');
    const tPassengers = groupBy(await T(`SELECT * FROM booking_passengers WHERE booking_id LIKE '${PREFIX}%' ORDER BY booking_id, seq`), 'booking_id');
    const tHistory = new Map((await T(`SELECT booking_id AS id, count(*)::int AS n FROM booking_history WHERE booking_id LIKE '${PREFIX}%' GROUP BY 1`)).map((r) => [str(r.id), Number(r.n)]));
    const tLocks = await T(`SELECT id, route_id, service_date::text AS day, pax, status FROM seat_locks WHERE id LIKE '${PREFIX}%'`);
    const tDeployments = await T('SELECT service_date::text AS day, boat_id, route_id FROM deployments');
    const tOverrides = await T('SELECT service_date::text AS day, boat_id FROM boat_capacity_overrides');

    // ── level 1 · bookings, trips, passengers, history ──
    const byExternal = new Map(tBookings.map((b) => [str(b.external_id), b]));
    const legacyById = new Map(lBookings.map((b) => [str(b.id), b]));
    const presence = setDiff(legacyById.keys(), byExternal.keys());
    check(1, 'bookings present', lBookings.length,
      presence.missing.map((id) => { const b = legacyById.get(id)!; return `${id} missing (legacy status ${str(b.status) || '(blank)'}, ${(lTrips.get(id) ?? []).length} trip(s))`; }),
      presence.extra.length ? [`${presence.extra.length} imported booking(s) no longer in legacy: ${presence.extra.slice(0, limit).join(', ')}`] : undefined);

    const both = lBookings.filter((b) => byExternal.has(str(b.id)));
    const tripCount: string[] = [], passengerDiff: string[] = [], historyDiff: string[] = [];
    for (const b of both) {
      const id = str(b.id), tid = str(byExternal.get(id)!.id);
      const lt = (lTrips.get(id) ?? []).length, tt = (tTrips.get(tid) ?? []).length;
      if (lt !== tt) tripCount.push(`${id}: ${lt} trip(s) → ${tt}`);
      const lp = (lPassengers.get(id) ?? []).filter((p) => str(p.name));
      const tp = tPassengers.get(tid) ?? [];
      if (lp.length !== tp.length) passengerDiff.push(`${id}: ${lp.length} named passenger(s) → ${tp.length}`);
      else lp.forEach((p, i) => {
        const q = tp[i]!;
        const fields = (['name', 'nationality', 'type'] as const).filter((f) => !same(p[f], q[f], 'text'));
        if (!same(p.foc, q.foc, 'bool')) fields.push('foc' as never);
        if (fields.length) passengerDiff.push(`${id} passenger ${i}: ${fields.map((f) => `${f} "${str(p[f])}" → "${str(q[f])}"`).join(', ')}`);
      });
      const lh = lHistory.get(id) ?? 0, th = tHistory.get(tid) ?? 0;
      if (lh !== th) historyDiff.push(`${id}: ${lh} history line(s) → ${th}`);
    }
    check(1, 'trips per booking', both.length, tripCount);
    check(1, 'passengers per booking', both.length, passengerDiff);
    check(1, 'history lines per booking', both.length, historyDiff);

    // ── level 1 · locks, deployments, overrides, catalogues ──
    // A lock here is one route on one date: a legacy lock spanning days is expected as one lock per
    // departure (`lg_<id>_<date>`), on the days its route runs here (legacyLockDays).
    const calendar = routeCalendar(
      (await T('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons')) as RouteSeason[],
      (await T('SELECT route_id, service_date::text, kind FROM route_day_overrides')) as RouteDayOverride[]);
    const parents = lLocks.filter((l) => !str(l.parentid));
    const spans = (l: Row) => ['bulk', 'month'].includes(str(l.scope));
    const departures = new Map(parents.map((l) => [str(l.id), legacyLockDays(l, (date) => calendar.isOpen(str(l.routeid), date))]));
    const expectedIds = new Map<string, Row>();   // imported id → its legacy lock
    for (const l of parents) {
      if (!spans(l)) { expectedIds.set(PREFIX + str(l.id), l); continue; }
      for (const d of departures.get(str(l.id))!) expectedIds.set(`${PREFIX}${str(l.id)}_${d.date}`, l);
    }
    const lockPresence = setDiff(expectedIds.keys(), tLocks.map((l) => str(l.id)));
    // One line per legacy lock, those still holding seats first: a released or empty one costs nothing.
    const holding = (l: Row) => str(l.status) === 'active' && Number(l.qty) > 0;
    const missingByLock = new Map<Row, number>();
    for (const id of lockPresence.missing) { const l = expectedIds.get(id)!; missingByLock.set(l, (missingByLock.get(l) ?? 0) + 1); }
    const missingLocks = [...missingByLock].sort((a, b) => Number(holding(b[0])) - Number(holding(a[0])));
    const lockKinds = new Map<string, number>();
    for (const [l] of missingLocks) add(lockKinds, `scope ${str(l.scope) || 'day'}, ${str(l.status) || '(blank)'}${Number(l.qty) > 0 ? '' : ', 0 seats'}`, 1);
    const bulkDepartures = parents.filter(spans).reduce((n, l) => n + departures.get(str(l.id))!.length, 0);
    check(1, 'seat locks present (sub-locks fold into their parent; bulk = one per departure)', expectedIds.size,
      missingLocks.map(([l, n]) => `${str(l.id)} missing${spans(l) ? ` ${n} departure(s)` : ''} (scope ${str(l.scope) || 'day'}, status ${str(l.status)}, ${str(l.routeid)} ${str(l.date) || `${str(l.datefrom) || str(l.monthfrom) || str(l.month)}..`}, ${str(l.qty)} seat(s))`),
      [`${parents.filter(spans).length} legacy lock(s) span days: ${bulkDepartures} departure(s) expected`,
        ...[...lockKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(5)} lock(s) missing: ${k}`),
        ...(lockPresence.extra.length ? [`${lockPresence.extra.length} imported lock(s) legacy does not have`] : [])]);

    const legacyDeployments = new Map<string, string>(); // day::boat → route
    for (const bd of lBoatDays) {
      let route = '';
      try { route = str((JSON.parse(str(bd.value)) as Row).route); } catch { /* unreadable: no route */ }
      legacyDeployments.set(`${str(bd.trips_id)}::${str(bd.key)}`, route);
    }
    const targetDeployments = new Map(tDeployments.map((d) => [`${str(d.day)}::${str(d.boat_id)}`, str(d.route_id)]));
    const depPresence = setDiff([...legacyDeployments.keys()].filter((k) => legacyDeployments.get(k)), targetDeployments.keys());
    const depRoute = [...legacyDeployments].filter(([k, r]) => r && targetDeployments.has(k) && targetDeployments.get(k) !== r).map(([k, r]) => `${k}: route ${r} → ${targetDeployments.get(k)}`);
    check(1, 'deployments present (boat-days with a route)', legacyDeployments.size,
      [...depPresence.missing.map((k) => `${k} (${legacyDeployments.get(k)}) missing`), ...depRoute],
      depPresence.extra.length ? [`${depPresence.extra.length} deployment(s) here and not in legacy`] : undefined);
    const ovPresence = setDiff(lOverrides.map((o) => str(o.key)), tOverrides.map((o) => `${str(o.day)}::${str(o.boat_id)}`));
    check(1, 'capacity overrides present', lOverrides.length, ovPresence.missing.map((k) => `${k} missing`));

    for (const [name, legacyTable, targetTable] of [
      ['agents', 'sb_agents', 'agents'], ['markets', 'sb_markets', 'markets'], ['salespeople', 'sb_sales', 'sales_people'],
      ['rate types', 'sb_rate_types', 'rate_types'], ['vans', 'sb_vehicles', 'vans'],
    ] as const) {
      const a = (await L(`SELECT id FROM ${legacyTable}`)).map((r) => str(r.id)).filter(Boolean);
      const d = setDiff(a, (await T(`SELECT id FROM ${targetTable}`)).map((r) => str(r.id)));
      check(1, `${name} present`, a.length, d.missing.map((id) => `${id} missing`), d.extra.length ? [`${d.extra.length} here and not in legacy (kept by design)`] : undefined);
    }

    // ── level 3 · values, booking by booking ──
    const headerDiff: string[] = [], statusDiff: string[] = [], tripDiff: string[] = [];
    const perField = new Map<string, number>();
    for (const b of both) {
      const id = str(b.id), t = byExternal.get(id)!;
      if (str(b.status) !== str(t.status)) statusDiff.push(`${id}: ${str(b.status)} → ${str(t.status)}`);
      for (const [column, legacyColumns, kind] of BOOKING_HEADER) {
        if (!tBookingCols.has(column)) continue;
        const want = legacyValue(b, legacyColumns), got = t[column];
        if (!same(want, got, kind)) {
          perField.set(column, (perField.get(column) ?? 0) + 1);
          headerDiff.push(`${id} ${column}: ${JSON.stringify(want ?? null)} → ${JSON.stringify(got ?? null)}`);
        }
      }
      const lt = lTrips.get(id) ?? [], tt = tTrips.get(str(t.id)) ?? [];
      lt.forEach((x, i) => {
        const y = tt[i]; if (!y) return;
        const where = `${id} trip ${i} (${str(x.routeid)} ${str(x.date)})`;
        const d: string[] = [];
        if (!same(x.routeid, y.route_id, 'text')) d.push(`route ${str(x.routeid)} → ${str(y.route_id)}`);
        if (!same(x.date, y.service_date, 'day')) d.push(`date ${str(x.date)} → ${String(y.service_date)}`);
        const mode = str(x.bookingmode) === 'charter' ? 'charter' : 'seat';
        if (mode !== str(y.booking_mode)) d.push(`mode ${mode} → ${str(y.booking_mode)}`);
        if (str(x.charterboatid) && !same(x.charterboatid, y.charter_boat_id, 'text')) d.push(`charter boat ${str(x.charterboatid)} → ${str(y.charter_boat_id)}`);
        if (!same(x.zone, y.zone, 'text')) d.push(`zone "${str(x.zone)}" → "${str(y.zone)}"`);
        if (!samePickup(x.pickuptime, y.pickup_time, y.pickup_time_end, y.pickup_at_pier)) {
          d.push(`pickup "${str(x.pickuptime)}" → "${[y.pickup_time, y.pickup_time_end, y.pickup_at_pier ? 'pier' : ''].map(str).filter(Boolean).join(' / ')}"`);
        }
        const ovn = ['return', 'self'].includes(str(x.ovn)) ? str(x.ovn) : '';
        if (ovn !== str(y.ovn)) d.push(`ovn "${str(x.ovn)}" → "${str(y.ovn)}"`);
        if (ovn === 'return' && !same(x.ovnreturndate, y.ovn_return_date, 'day')) d.push(`ovn return ${str(x.ovnreturndate)} → ${String(y.ovn_return_date ?? '')}`);
        if (!same(x.ovnleg, y.ovn_leg, 'bool')) d.push(`ovn leg ${String(x.ovnleg)} → ${String(y.ovn_leg)}`);
        const pax = countDiff(legacyPax(x), targetPax(tPax.get(str(y.id)) ?? []));
        if (pax.length) d.push(`pax ${pax.join(', ')}`);
        if (d.length) tripDiff.push(`${where}: ${d.join('; ')}`);
      });
    }
    check(3, 'booking status', both.length, statusDiff);

    // Approvals: legacy keeps one of each kind on the booking row (`approval_*`, `focapproval_*`).
    const apCols = await tCols('booking_approvals');
    if (apCols.size) {
      const tApprovals = groupBy(await T(`SELECT ap.booking_id, ap.kind, ap.status, ${apCols.has('reason') ? 'ap.reason' : 'NULL::text AS reason'},
          ap.over_capacity, ap.foc_count, ap.decided_by, (SELECT count(*) FROM booking_approval_days d WHERE d.approval_id = ap.id)::int AS days
        FROM booking_approvals ap WHERE ap.booking_id LIKE '${PREFIX}%'`), 'booking_id');
      const approvalDiff: string[] = [];
      const kinds = new Map<string, number>();
      let compared = 0;
      for (const b of both) {
        const id = str(b.id), rows = tApprovals.get(str(byExternal.get(id)!.id)) ?? [];
        for (const [kind, prefix] of [['approval', 'approval_'], ['foc', 'focapproval_']] as const) {
          const status = str(b[`${prefix}status`]);
          const want = ['pending', 'approved', 'rejected'].includes(status);
          const got = rows.filter((r) => str(r.kind) === kind);
          if (!want && !got.length) continue;
          compared++;
          const d: string[] = [];
          if (want && got.length !== 1) d.push(`${got.length} row(s), want 1`);
          else if (!want) d.push(`legacy has none (status "${status}"), here ${got.length}`);
          else {
            const r = got[0]!;
            if (status !== str(r.status)) d.push(`status ${status} → ${str(r.status)}`);
            const decided = status !== 'pending';
            if (decided && !same(b[`${prefix}approvedby`], r.decided_by, 'text')) d.push(`decided_by "${str(b[`${prefix}approvedby`])}" → "${str(r.decided_by)}"`);
            if (kind === 'foc' && !same(b.focapproval_count, r.foc_count, 'number')) d.push(`foc_count ${str(b.focapproval_count)} → ${str(r.foc_count)}`);
            if (kind === 'approval') {
              let days = 0;
              try {
                const over = JSON.parse(str(b.approval_over) || '[]');
                if (Array.isArray(over)) days = new Set(over.filter((o: Row) => str(o.routeId) && /^\d{4}-\d{2}-\d{2}$/.test(str(o.date)) && Number(o.need) > 0 && Number(o.overBy) > 0)
                  .map((o: Row) => `${str(o.routeId)} ${str(o.date)}`)).size;
              } catch { /* unreadable: no days */ }
              if (apCols.has('reason') && !same(b.approval_reason, r.reason, 'text')) d.push(`reason "${str(b.approval_reason)}" → "${str(r.reason)}"`);
              const over = /over_cap/.test(str(b.approval_reason)) || days > 0;
              if (over !== (r.over_capacity === true)) d.push(`over_capacity ${over} → ${String(r.over_capacity)}`);
              if (days !== Number(r.days)) d.push(`days ${days} → ${String(r.days)}`);
            }
          }
          if (d.length) { approvalDiff.push(`${id} ${kind}: ${d.join('; ')}`); for (const x of d) add(kinds, `${kind} ${x.replace(/\s.*$/, '')}`, 1); }
        }
      }
      check(3, 'approvals (over-allotment/discount and FOC)', compared, approvalDiff,
        [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(5)} differ in ${k}`));
    }
    check(3, 'booking header fields', both.length, headerDiff,
      [...perField].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${String(n).padStart(5)} booking(s) differ in ${f}`));
    // Grouped by what differs, so 4,000 trips with the same pickup problem read as one line.
    const tripKinds = new Map<string, number>();
    for (const line of tripDiff) for (const part of line.slice(line.indexOf('): ') + 3).split('; ')) add(tripKinds, part.replace(/\s.*$/, ''), 1);
    check(3, 'trip fields (route, date, mode, zone, pickup, overnight, pax)', both.reduce((n, b) => n + (lTrips.get(str(b.id)) ?? []).length, 0), tripDiff,
      [...tripKinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(5)} trip(s) differ in ${k}`));

    // ── level 4 · totals ──
    const lSeat = new Map<string, number>(), tSeat = new Map<string, number>(), lCharter = new Map<string, number>(), tCharter = new Map<string, number>();
    const lMoney = new Map<string, number>(), tMoney = new Map<string, number>();
    for (const b of lBookings) {
      if (RELEASED.has(str(b.status))) continue;
      add(lMoney, (str(b.bookingdate) || str(b.bookedat)).slice(0, 7) || '(no date)', Math.round(Number(b.total) || 0));
      for (const x of lTrips.get(str(b.id)) ?? []) {
        const n = [...legacyPax(x).values()].reduce((s, v) => s + v, 0);
        add(str(x.bookingmode) === 'charter' ? lCharter : lSeat, `${str(x.routeid)} ${str(x.date)}`, n);
      }
    }
    const tripsById = new Map<string, Row>();
    for (const list of tTrips.values()) for (const y of list) tripsById.set(str(y.id), y);
    for (const t of tBookings) {
      if (RELEASED.has(str(t.status))) continue;
      const day = t.booking_date instanceof Date ? t.booking_date : null;
      const month = day ? `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}` : (t.booked_at instanceof Date ? t.booked_at.toISOString().slice(0, 7) : '(no date)');
      add(tMoney, month, Math.round(Number(t.total) || 0));
      for (const y of tTrips.get(str(t.id)) ?? []) {
        const n = [...targetPax(tPax.get(str(y.id)) ?? []).values()].reduce((s, v) => s + v, 0);
        const d = y.service_date instanceof Date ? y.service_date : new Date(String(y.service_date));
        const key = `${str(y.route_id)} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        add(str(y.booking_mode) === 'charter' ? tCharter : tSeat, key, n);
      }
    }
    check(4, 'seat passengers per route and day (bookings that hold seats)', new Set([...lSeat.keys(), ...tSeat.keys()]).size, countDiff(lSeat, tSeat));
    check(4, 'charter passengers per route and day', new Set([...lCharter.keys(), ...tCharter.keys()]).size, countDiff(lCharter, tCharter));
    check(4, 'booking totals per month (THB, bookings that hold seats)', new Set([...lMoney.keys(), ...tMoney.keys()]).size, countDiff(lMoney, tMoney));

    const lLocked = new Map<string, number>(), tLocked = new Map<string, number>();
    for (const l of parents) for (const d of departures.get(str(l.id))!) if (d.holding) add(lLocked, `${str(l.routeid)} ${d.date}`, d.pax);
    for (const l of tLocks) if (str(l.status) === 'active') add(tLocked, `${str(l.route_id)} ${str(l.day)}`, Number(l.pax) || 0);
    check(4, 'locked seats per route and day (active locks, bulk ones per departure)', new Set([...lLocked.keys(), ...tLocked.keys()]).size, countDiff(lLocked, tLocked));
    const lBoats = new Map<string, number>(), tBoats = new Map<string, number>();
    for (const [k, r] of legacyDeployments) if (r) add(lBoats, `${r} ${k.split('::')[0]}`, 1);
    for (const [k, r] of targetDeployments) add(tBoats, `${r} ${k.split('::')[0]}`, 1);
    check(4, 'boats per route and day', new Set([...lBoats.keys(), ...tBoats.keys()]).size, countDiff(lBoats, tBoats));

    // ── level 2 · legacy columns with data that no import code names ──
    const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const importSource = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.startsWith('verify-')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    const tables = new Set([...importSource.matchAll(/\bFROM\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]!.toLowerCase()));
    const legacyTables = (await L(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`)).map((r) => str(r.table_name));
    for (const t of legacyTables) if (/^sb_rate_types__addons__r[0-9]+$/.test(t)) tables.add(t);   // found by name at import time
    const columns: { table: string; column: string; filled: number }[] = [];
    for (const table of [...tables].filter((t) => legacyTables.includes(t)).sort()) {
      const cols = (await L(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' ORDER BY ordinal_position`)).map((r) => str(r.column_name));
      const filled = await L(`SELECT ${cols.map((c, i) => `count(*) FILTER (WHERE "${c}" IS NOT NULL AND "${c}"::text NOT IN ('', '[]', '{}', 'null', 'false', '0')) AS c${i}`).join(', ')} FROM "${table}"`);
      cols.forEach((column, i) => columns.push({ table, column, filled: Number(filled[0]![`c${i}`]) }));
    }
    const unread = unreadColumns(columns, importSource).sort((a, b) => b.filled - a.filled);
    check(2, `legacy columns with data that no import code reads (${tables.size} tables)`, columns.length,
      unread.map((c) => `${c.table}.${c.column}: ${c.filled} row(s) hold data`));

    // ── report ──
    checks.sort((a, b) => a.level - b.level);
    console.log('\nverify-import · legacy → operation-backend\n');
    console.log(`${'level'.padEnd(6)} ${'check'.padEnd(66)} ${'compared'.padStart(9)} ${'differ'.padStart(7)}`);
    for (const c of checks) console.log(`${String(c.level).padEnd(6)} ${c.name.slice(0, 66).padEnd(66)} ${String(c.compared).padStart(9)} ${String(c.differ.length).padStart(7)}`);
    for (const c of checks) {
      if (!c.differ.length && !c.info?.length) continue;
      console.log(`\n── ${c.name} · ${c.differ.length} difference(s)`);
      for (const i of c.info ?? []) console.log(`   ${i}`);
      for (const d of c.differ.slice(0, limit)) console.log(`   ${d}`);
      if (c.differ.length > limit) console.log(`   … ${c.differ.length - limit} more (--limit=N, or --json=file for all)`);
    }
    if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(checks, null, 2)); console.log(`\nfull report: ${jsonOut}`); }
    const failed = checks.filter((c) => c.differ.length).length;
    console.log(`\n${failed ? `${failed} of ${checks.length} checks differ` : `all ${checks.length} checks match`}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await source.end();
    await target.end();
  }
}

await main();
