/**
 * Backfills this service's database from the legacy monolith's (`operation_schemas`).
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npx tsx src/tools/import-legacy.ts [--commit] [--remove=<booking id>,…]
 *
 * Without `--commit` it is a dry run: every write happens inside one transaction on the target, the
 * report is printed, and the transaction is rolled back. The source is opened read-only either way.
 *
 * Imported rows are owned by the `lg_` id prefix, and a run first deletes every `lg_` booking, lock
 * and van group, so running it twice leaves one copy. Deployments, capacity overrides and vans are
 * upserted on their natural keys, and an imported van's dated rows (month matrix, status, drivers)
 * are replaced. They are also mirrored: one whose key no longer exists in legacy at all is deleted,
 * because legacy is master while this import runs (until cutover) and a boat taken off a day there
 * must stop selling seats here. A row legacy still has but this import skipped is kept and listed.
 * A van still referenced by something this import did not create cannot be deleted, and the whole
 * run rolls back. Agents, markets and salespeople keep legacy's ids and are upserted too; an agent's
 * programmes and activity and a market's sub-markets are replaced. Nothing else is touched except the
 * bookings named in `--remove`.
 *
 * Rate types keep legacy's ids and are upserted (mapping: `legacy-rate-types.ts`). Under each one,
 * only what legacy's tables can hold is replaced: seat prices in zones PK, KL and NoTransfer,
 * speedboat and catamaran charters, the longtail add-on, and transfers on the routes legacy has a
 * table for. Everything else was entered here by hand, because legacy drops it on save — RN prices,
 * longtail charters, other routes' transfers, a bundle's `applies_to` — and is kept across runs. A
 * route taken off a rate in legacy is taken off here, with its prices. A rate type legacy no longer
 * has is kept and listed, as agents are, since bookings may name it.
 *
 * A booking's approvals (`legacy-approvals.ts`) come with it: legacy's one over-allotment/discount
 * approval and one FOC approval per booking, with the days and reason, so an imported booking waiting
 * over the allotment holds no seats here either. Its `foc_reason` is its own, else its FOC
 * approval's. A seat lock spanning days (bulk or month) becomes one lock per departure on the days
 * the route runs (`legacy-locks.ts`), `lg_<legacy id>_<date>`; a booking's draw lands on its day's.
 *
 * Rows go in as SQL, not through the API, so the capacity check is skipped on purpose: legacy days
 * that were oversold arrive oversold rather than half-imported. The mapping itself reuses the domain
 * parsers (`bookingHeader`, `parsePaxGrid`, `isBookingStatus`) so an imported row obeys the same rules
 * as one sent to `POST /v1/bookings`. A row that does not map is skipped and listed, never guessed.
 */
import { Client } from 'pg';
import { bookingHeader } from '../domain/booking-header.js';
import { holdsSeats, isBookingStatus } from '../domain/booking-status.js';
import { parsePaxGrid, type PaxRow } from '../domain/pax.js';
import { assertItinerary, type BookingTripInput, type OvnMode } from '../domain/operations.js';
import type { PickupWindow } from '../domain/pickup.js';
import { legacyPickup } from './legacy-pickup.js';
import { isPayType, isVatMode, PAY_TYPES } from '../domain/agents.js';
import { cancellationRow, feeItemRows, historyRows, partialCancelRows, rescheduleRow } from './legacy-records.js';
import { LEGACY_HOLDS, mapLegacyRateTypes } from './legacy-rate-types.js';
import { approvalRows, focReason, type ApprovalDayRow } from './legacy-approvals.js';
import { lockDays, spansDays } from './legacy-locks.js';
import { routeCalendar, type RouteDayOverride, type RouteSeason } from '../domain/calendar.js';

const PREFIX = 'lg_';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
type Row = Record<string, unknown>;

const commit = process.argv.includes('--commit');
const remove = (process.argv.find((arg) => arg.startsWith('--remove='))?.slice('--remove='.length) ?? '').split(',').filter(Boolean);
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
if (!sourceUrl || !targetUrl) throw new Error('Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL');

const skipped: { kind: string; id: string; reason: string }[] = [];
const skip = (kind: string, id: string, reason: string) => { skipped.push({ kind, id, reason }); };
const notes = new Map<string, number>();
const note = (what: string, n = 1) => notes.set(what, (notes.get(what) ?? 0) + n);

const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const int = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : 0; };
/** A money amount legacy stored, or null when it stored none (or a negative one, which no column takes). */
const amountOrNull = (value: unknown): number | null => { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
/** An instant the database will accept, or undefined. Date-only strings are instants at midnight UTC. */
const instant = (value: unknown): string | undefined => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? s : undefined; };

/**
 * Target header column → legacy column. The legacy table flattens the same document our header
 * parser reads, so each value is handed to `bookingHeader` under our own column name — the parser
 * accepts snake_case — and it does the type conversion exactly as it does for an API call.
 */
const HEADER_FROM_LEGACY: Record<string, string> = {
  schema_ver: 'schemaver', sold_by: 'soldby', purpose: 'purpose', staff_id: 'staffid', staff_purpose: 'staffpurpose',
  lead_pax: 'leadpax', lead_nationality: 'leadnationality', lead_type: 'leadtype', lead_foc: 'leadfoc', lead_phone: 'leadphone', lead_email: 'leademail',
  pickup_area_id: 'pickupareaid', pickup_self: 'pickupself', pickup_area: 'pickuparea', pickup_zone: 'pickupzone', hotel_name: 'hotelname', room_number: 'roomnumber',
  dropoff_same: 'dropoffsame', dropoff_area_id: 'dropoffareaid', dropoff_area: 'dropoffarea', dropoff_hotel_name: 'dropoffhotelname',
  guide_english: 'guides_english', guide_russian: 'guides_russian', guide_chinese: 'guides_chinese', guide_other_lang: 'guides_otherlang',
  special_meals_veg: 'specialmeals_veg', special_meals_vegan: 'specialmeals_vegan', special_meals_halal: 'specialmeals_halal',
  special_meals_allergies: 'specialmeals_allergies', large_luggage: 'largeluggage',
  cash_on_tour_amount: 'cashontour_amount', cash_on_tour_currency: 'cashontour_currency', cash_on_tour_handling: 'cashontour_handling', cash_on_tour_note: 'cashontour_note',
  price_mode: 'pricemode', manual_total: 'manualtotal', total: 'total',
  price_seat: 'pricebreakdown_seat', price_addon: 'pricebreakdown_addon', price_foc_discount: 'pricebreakdown_focdiscount',
  price_discount: 'pricebreakdown_discount', price_extra: 'pricebreakdown_extra',
  payment_method: 'paymentsnapshot_method', payment_net_days: 'paymentsnapshot_netdays', payment_source: 'paymentsnapshot_source',
  payment_contract_version: 'paymentsnapshot_contractversion',
  market: 'marketsnapshot_market', market_sub: 'marketsnapshot_sub', market_agent_id: 'marketsnapshot_agentid', market_at: 'marketsnapshot_at',
  booking_date: 'bookingdate', booked_at: 'bookedat', created_by: 'createdby', updated_by: 'updatedby',
  confirmed_at: 'confirmedat', confirmed_by: 'confirmedby', notes: 'notes', note: 'note',
};
const TIMESTAMP_HEADER = ['booked_at', 'confirmed_at'] as const;

/**
 * A legacy pickup text as a pickup window (`legacyPickup`), `{}` when empty. A text that is none of
 * legacy's shapes is dropped and counted rather than guessed.
 */
function pickupWindow(value: unknown, what: string): PickupWindow {
  const window = legacyPickup(value);
  if (window === undefined) { note(`${what}: dropped, not a time, a window or a pier deadline`); return {}; }
  return window;
}

/** A legacy trip's pax columns as the grid `parsePaxGrid` reads: `pax_ad_fr` → `ad_fr`, untiered `pax_ad` → `ad`. */
function paxGrid(trip: Row): Record<string, number> {
  const grid: Record<string, number> = {};
  for (const category of ['ad', 'chd', 'inf', 'foc']) {
    for (const suffix of ['_fr', '_th', '']) {
      const n = int(trip[`pax_${category}${suffix}`]);
      if (n > 0) grid[`${category}${suffix}`] = n;
    }
  }
  return grid;
}

/** A legacy map value: JSON when it parses, the raw text when it does not (legacy wrote both). */
function jsonValue(value: unknown): unknown {
  const s = str(value);
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

const SELF_ARRIVE = new Set(['NoTransfer', 'NT']);
/**
 * The zone a trip is grouped in, as legacy's `_bkV2InZone`/`bkV2EffZone` decide it (booking.js
 * 2293, 2948-2963): a charter has its own `__CHARTER__` namespace; otherwise the trip's zone, else the
 * booking's pickup zone; and a NoTransfer seat with a private-van add-on
 * (`transfer-<route>-<PK|KL>-<vehicle>`) is picked up in that van's zone.
 */
function groupZone(trip: Row, booking: Row, addOnTypes: readonly string[]): string {
  if (str(trip.bookingmode) === 'charter') return '__CHARTER__';
  const base = str(trip.zone) || str(booking.pickupzone);
  if (base && !SELF_ARRIVE.has(base)) return base;
  const prefix = `transfer-${str(trip.routeid)}-`;
  const privateVan = addOnTypes.find((type) => type.startsWith(prefix))?.match(/^transfer-(.+)-(PK|KL|NoTransfer)-([a-z]+)$/i);
  return privateVan && privateVan[2] !== 'NoTransfer' ? privateVan[2] : base;
}

type Counts = { ad: number; chd: number; inf: number; foc: number };
const countsOf = (rows: readonly PaxRow[]): Counts => {
  const counts: Counts = { ad: 0, chd: 0, inf: 0, foc: 0 };
  for (const row of rows) counts[row.category] += row.count;
  return counts;
};
const countsTotal = (c: Counts): number => c.ad + c.chd + c.inf + c.foc;

async function main() {
  const source = new Client({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on -c search_path=operation_schemas' });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const read = async (sql: string) => (await source.query(sql)).rows as Row[];
    // One client runs one query at a time, so these are sequential rather than a Promise.all.
    const legacyBoats = await read('SELECT id, totalcap FROM boats');
    const boatDays = await read('SELECT trips_id, key, value FROM trips__boat');
    const capOverrides = await read('SELECT key, cap, reason FROM boat_capovr');
    const legacyLocks = await read('SELECT * FROM sb_seat_locks');
    const legacyBookings = await read('SELECT * FROM sb_bookings');
    const legacyTrips = await read('SELECT * FROM sb_bookings__trips ORDER BY sb_bookings_id, idx');
    const legacyPassengers = await read('SELECT * FROM sb_bookings__passengers ORDER BY sb_bookings_id, idx');
    const legacyAdjustments = await read('SELECT * FROM sb_bookings__adjustments ORDER BY sb_bookings_id, idx');
    const legacyAddOns = await read('SELECT sb_bookings_id, type FROM sb_bookings__addons');
    const legacyPartialCancels = await read('SELECT * FROM sb_bookings__partialcancels ORDER BY sb_bookings_id, idx');
    const legacyFeeItems = await read('SELECT * FROM sb_bookings__feeitems ORDER BY sb_bookings_id, idx');
    const legacyHistory = await read('SELECT * FROM sb_bookings__history ORDER BY sb_bookings_id, idx');
    const legacyVans = await read('SELECT * FROM sb_vehicles');
    const vanDayRoutes = await read('SELECT sb_vehicles_id, key, value FROM sb_vehicles__dayroute');
    const vanDayStatus = await read('SELECT sb_vehicles_id, key, value FROM sb_vehicles__daystatus');
    const vanRanges = await read('SELECT * FROM sb_vehicles__statusranges ORDER BY sb_vehicles_id, idx');
    const vanDrivers = await read('SELECT key, driver, phone, plate FROM vanjob_driver');
    const vanSent = await read('SELECT key, value FROM vanjob_sent');
    const legacyMarkets = await read('SELECT * FROM sb_markets');
    const legacyMarketSubs = await read('SELECT sb_markets_id, idx, value FROM sb_markets__subs ORDER BY sb_markets_id, idx');
    const legacySales = await read('SELECT * FROM sb_sales');
    const legacyAgents = await read('SELECT * FROM sb_agents');
    const legacyAgentPrograms = await read('SELECT sb_agents_id, idx, value FROM sb_agents__programs ORDER BY sb_agents_id, idx');
    const legacyAgentPeriods = await read('SELECT * FROM sb_agents__programperiods ORDER BY sb_agents_id, idx');
    const legacyAgentActivity = await read('SELECT * FROM sb_agents__activity ORDER BY sb_agents_id, idx');
    const rateBindings = await read('SELECT id, ratetypeid FROM sb_agents_rate_bindings');
    // Rate types. Legacy keeps a private-transfer table per route it has ever priced; they are found
    // by name, so a route legacy adds a table for is read without a change here.
    const transferTables = (await read(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name ~ '^sb_rate_types__addons__r[0-9]+$' ORDER BY table_name`)).map((t) => str(t.table_name));
    const legacyRateTypes = {
      rates: await read('SELECT * FROM sb_rate_types'),
      routes: await read('SELECT * FROM sb_rate_types__routes'),
      seat: await read('SELECT * FROM sb_rate_types__seatrates'),
      charter: await read('SELECT * FROM sb_rate_types__charterrates'),
      validity: await read('SELECT * FROM sb_rate_types__routevalidity'),
      bundles: await read('SELECT * FROM sb_rate_types__routebundles'),
      addons: await read('SELECT * FROM sb_rate_types__addons'),
      byRoute: await read('SELECT * FROM sb_rate_types__addons__byroute'),
      applies: await read('SELECT * FROM sb_rate_types__addons__applies'),
      transfers: [] as { routeId: string; rows: Row[] }[],
    };
    for (const table of transferTables) legacyRateTypes.transfers.push({ routeId: table.slice('sb_rate_types__addons__'.length), rows: await read(`SELECT * FROM "${table}"`) });
    const routes = new Set((await target.query('SELECT id FROM routes')).rows.map((r) => String(r.id)));
    const routePiers = new Map((await target.query('SELECT id, pier FROM routes')).rows.map((r) => [String(r.id), { pier: r.pier ?? undefined }]));
    const boats = new Map((await target.query('SELECT id, capacity, license_pax FROM boats')).rows.map((b) => [String(b.id), b]));
    const totalcap = new Map(legacyBoats.map((b) => [str(b.id), int(b.totalcap)]));

    // ── Deployments: one per boat per day, capacity and licence from the target's boat catalogue ──
    const deployments: Row[] = [];
    const charterBoat = new Map<string, string>(); // `${legacy booking id}|${day}` → boat the day's plan gave it
    for (const bd of boatDays) {
      const day = str(bd.trips_id), boatId = str(bd.key), id = `${day}::${boatId}`;
      let plan: Row;
      try { plan = JSON.parse(str(bd.value)) as Row; } catch { skip('deployment', id, 'value is not JSON'); continue; }
      if (plan.charterBookingId) charterBoat.set(`${str(plan.charterBookingId)}|${day}`, boatId);
      const routeId = str(plan.route);
      if (!ISO_DAY.test(day)) { skip('deployment', id, `bad date ${day}`); continue; }
      if (!routeId) { skip('deployment', id, 'no route'); continue; }
      if (!routes.has(routeId)) { skip('deployment', id, `route ${routeId} not in catalogue`); continue; }
      const boat = boats.get(boatId);
      if (!boat) { skip('deployment', id, `boat ${boatId} not in catalogue`); continue; }
      const capacity = int(boat.capacity);
      deployments.push({ boat_id: boatId, route_id: routeId, service_date: day, capacity, license_pax: boat.license_pax, registered_persons: totalcap.get(boatId) || capacity });
    }

    const overrides: Row[] = [];
    for (const o of capOverrides) {
      const [day, boatId] = str(o.key).split('::');
      if (!day || !ISO_DAY.test(day) || !boatId || !boats.has(boatId)) { skip('capacity override', str(o.key), 'bad key or unknown boat'); continue; }
      overrides.push({ boat_id: boatId, service_date: day, capacity: Math.max(0, int(o.cap)), reason: str(o.reason) || null });
    }

    // ── Seat locks: parents only. A sub-lock is carved out of its parent, and legacy holds seats at
    //    the parent (bkV2LockPoolHold); importing both would hold the same seats twice. ──
    const parentOf = new Map<string, string>();
    for (const l of legacyLocks) if (str(l.parentid)) parentOf.set(str(l.id), str(l.parentid));
    const locks: Row[] = [];
    // legacy parent id → its route and the imported lock of each date (one date for a day lock)
    const lockAt = new Map<string, { route: string; days: Map<string, string> }>();
    // A lock spanning days becomes one per departure, on the days the route runs here (legacy-locks.ts).
    const calendar = routeCalendar(
      (await target.query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons')).rows as RouteSeason[],
      (await target.query('SELECT route_id, service_date::text, kind FROM route_day_overrides')).rows as RouteDayOverride[]);
    for (const l of legacyLocks) {
      const legacyId = str(l.id);
      if (parentOf.has(legacyId)) { note('sub-locks folded into their parent'); continue; }
      const day = str(l.date), routeId = str(l.routeid), qty = int(l.qty);
      const scope = str(l.scope) || 'day';
      if (!spansDays(l) && !day) { skip('seat lock', legacyId, 'undated lock has no date'); continue; }
      if (!spansDays(l) && !ISO_DAY.test(day)) { skip('seat lock', legacyId, `bad date ${day}`); continue; }
      if (!routes.has(routeId)) { skip('seat lock', legacyId, `route ${routeId || '(none)'} not in catalogue`); continue; }
      if (qty <= 0) { skip('seat lock', legacyId, `qty ${qty}`); continue; }
      const created = instant(l.createdat) ?? new Date().toISOString();
      const agentId = str(l.holdertype) === 'agent' && str(l.holderid) ? str(l.holderid) : null;
      const active = str(l.status) === 'active';
      const days = new Map<string, string>();
      if (spansDays(l)) {
        const rounds = lockDays(l, (date) => calendar.isOpen(routeId, date));
        if (typeof rounds === 'string') { skip('seat lock', legacyId, `${scope} lock: ${rounds}`); continue; }
        if (rounds.length === 0) { note(`${scope} locks with no departure left (no day the route runs, or every seat pending)`); continue; }
        for (const round of rounds) {
          const id = `${PREFIX}${legacyId}_${round.service_date}`;
          locks.push({
            id, route_id: routeId, service_date: round.service_date, pax: round.pax, agent_id: agentId,
            status: round.released ? 'released' : 'active', created_at: created, updated_at: created, released_at: null,
          });
          days.set(round.service_date, id);
        }
        note(`${scope} locks split into one lock per departure`);
        note(`${scope} lock departures (${str(l.status) || '(blank)'} lock) → ${rounds.filter((r) => !r.released).length ? 'active, released where legacy released the round' : 'released'}`);
        if (rounds.length) note(`${scope} lock departures written`, rounds.length);
      } else {
        const id = PREFIX + legacyId;
        locks.push({
          id, route_id: routeId, service_date: day, pax: qty, agent_id: agentId,
          status: active ? 'active' : 'released', created_at: created, updated_at: created, released_at: null,
        });
        days.set(day, id);
        note(`locks ${str(l.status) || '(blank)'} → ${active ? 'active' : 'released'}`);
      }
      lockAt.set(legacyId, { route: routeId, days });
    }

    // ── Vans: the catalogue keeps legacy's ids (upserted, like deployments), and everything dated
    //    about a van is replaced for the vans imported ──
    const vans: Row[] = [];
    for (const v of legacyVans) {
      const id = str(v.id), capacity = int(v.capacity);
      if (!id) { skip('van', '(no id)', 'no id'); continue; }
      if (capacity <= 0) { skip('van', id, `capacity ${str(v.capacity) || '(none)'}`); continue; }
      const zone = str(v.zonebase);
      if (zone && zone !== 'PK' && zone !== 'KL') note(`van zone_base dropped: "${zone}"`);
      const ownership = str(v.ownership) || 'own';
      if (ownership !== 'own' && ownership !== 'partner') note(`van ownership "${ownership}" read as own`);
      if (!str(v.name)) note('vans with no name: named by id');
      vans.push({
        id, name: str(v.name) || id, plate: str(v.plate) || null, type: str(v.type) || null, capacity,
        ownership: ownership === 'partner' ? 'partner' : 'own', partner_name: str(v.partnername) || null,
        zone_base: zone === 'PK' || zone === 'KL' ? zone : null, color: str(v.color) || null,
        driver: str(v.driver) || null, driver_phone: str(v.driverphone) || null, active: v.active !== false,
      });
    }
    const vanIds = new Set(vans.map((v) => String(v.id)));
    const knownVan = (id: unknown, what: string): string | null => {
      const s = str(id);
      if (!s) return null;
      if (vanIds.has(s)) return s;
      note(`${what}: van ${s} not imported, dropped`);
      return null;
    };

    const dayRoutes: Row[] = [];
    for (const r of vanDayRoutes) {
      const vanId = str(r.sb_vehicles_id), day = str(r.key);
      if (!vanIds.has(vanId) || !ISO_DAY.test(day)) { note('month-matrix cells dropped: unknown van or bad date'); continue; }
      const value = jsonValue(r.value);
      for (const routeId of new Set((Array.isArray(value) ? value : [value]).map(str).filter(Boolean))) {
        if (!routes.has(routeId)) { note(`month-matrix cells dropped: route ${routeId} not in catalogue`); continue; }
        dayRoutes.push({ van_id: vanId, service_date: day, route_id: routeId });
      }
    }

    // Kept in legacy's order: where ranges overlap the later one wins, and the serial id records it.
    const statusRanges: Row[] = [];
    for (const r of vanRanges) {
      const vanId = str(r.sb_vehicles_id), status = str(r.s), from = str(r.from), to = str(r.to);
      if (!vanIds.has(vanId)) continue;
      if (status !== 'off' && status !== 'maintenance') { note(`status ranges dropped: status "${status}"`); continue; }
      if (!ISO_DAY.test(from) || (to && (!ISO_DAY.test(to) || to < from))) { note('status ranges dropped: bad dates'); continue; }
      statusRanges.push({ van_id: vanId, status, from_date: from, to_date: to || null, note: str(r.note) || null });
    }

    // van_days merges three legacy maps that share the (date, van) key.
    const vanDays = new Map<string, Row>();
    const vanDay = (vanId: string, day: string): Row => {
      const key = `${vanId}|${day}`;
      return vanDays.get(key) ?? vanDays.set(key, { van_id: vanId, service_date: day, status: null, driver: null, driver_phone: null, plate: null, sent_at: null }).get(key)!;
    };
    for (const s of vanDayStatus) {
      const vanId = str(s.sb_vehicles_id), day = str(s.key), status = str(jsonValue(s.value));
      if (!vanIds.has(vanId) || !ISO_DAY.test(day) || !status) continue;
      if (!['available', 'off', 'maintenance'].includes(status)) { note(`day statuses dropped: "${status}"`); continue; }
      vanDay(vanId, day).status = status;
    }
    for (const d of vanDrivers) {
      const [day, vanId] = str(d.key).split('::');
      if (!day || !ISO_DAY.test(day) || !vanIds.has(vanId ?? '')) { note('day drivers dropped: bad key or unknown van'); continue; }
      Object.assign(vanDay(vanId!, day), { driver: str(d.driver) || null, driver_phone: str(d.phone) || null, plate: str(d.plate) || null });
    }
    for (const s of vanSent) {
      // `date::vanId[~route[~group]]`: several per van when sent per route or group; the latest stands.
      const [day, rest] = str(s.key).split('::');
      const vanId = (rest ?? '').split('~')[0];
      const at = instant(jsonValue(s.value));
      if (!day || !ISO_DAY.test(day) || !vanIds.has(vanId) || !at) { note('sent-to-driver marks dropped: bad key, unknown van or no time'); continue; }
      const row = vanDay(vanId, day);
      if (!row.sent_at || String(row.sent_at) < at) row.sent_at = at;
    }

    // ── Bookings: all-or-nothing per booking, so no booking arrives missing a day ──
    const tripsOf = new Map<string, Row[]>();
    for (const t of legacyTrips) { const k = str(t.sb_bookings_id); (tripsOf.get(k) ?? tripsOf.set(k, []).get(k)!).push(t); }
    const passengersOf = new Map<string, Row[]>();
    for (const p of legacyPassengers) { const k = str(p.sb_bookings_id); (passengersOf.get(k) ?? passengersOf.set(k, []).get(k)!).push(p); }
    const childrenOf = (rows: Row[]): Map<string, Row[]> => {
      const byBooking = new Map<string, Row[]>();
      for (const r of rows) { const k = str(r.sb_bookings_id); (byBooking.get(k) ?? byBooking.set(k, []).get(k)!).push(r); }
      return byBooking;
    };
    const partialCancelsOf = childrenOf(legacyPartialCancels), feeItemsOf = childrenOf(legacyFeeItems), historyOf = childrenOf(legacyHistory);
    const adjustmentsOf = childrenOf(legacyAdjustments);
    const addOnsOf = new Map<string, string[]>();
    for (const a of legacyAddOns) { const k = str(a.sb_bookings_id); (addOnsOf.get(k) ?? addOnsOf.set(k, []).get(k)!).push(str(a.type)); }

    // ── Van assignment per trip. Groups are only known once every booking is read, so members are
    //    collected under a legacy key (date, route, zone, number) and resolved after the loop ──
    const tripOps: Row[] = [], allocations: Row[] = [], boatSplitRows: Row[] = [];
    const groupMembers = new Map<string, { day: string; route: string; zone: string; number: number; vans: string[] }>();
    const hasVanOps = (src: Row): boolean => int(src.ops_vangroup) > 0 || !!str(src.ops_vanid) || !!str(src.ops_vanreturnid) || !!str(src.ops_boatid) || !!jsonValue(src.ops_boatsplits) || !!jsonValue(src.ops_piernote)
      || !!str(src.ops_pickuptimefinal) || src.ops_returnsamevan === true || Array.isArray(jsonValue(src.ops_vansplits));
    const vanOpsOf = (src: Row, t: Row, tripId: string, counts: Counts, zone: string) => {
      const final = pickupWindow(src.ops_pickuptimefinal, 'final pickup times');
      // The boat (or boats) and the pier note (migration 033). A split names two boats or more, each in the catalogue.
      const rawBoatSplits = jsonValue(src.ops_boatsplits);
      const boatSplits = Array.isArray(rawBoatSplits) ? (rawBoatSplits as Row[]).map((s) => ({ boat_id: str(s.boatId), ad: int(s.ad), chd: int(s.chd), inf: int(s.inf), foc: int(s.foc) })) : [];
      const splitOk = boatSplits.length >= 2 && new Set(boatSplits.map((s) => s.boat_id)).size === boatSplits.length && boatSplits.every((s) => boats.has(s.boat_id));
      if (boatSplits.length && !splitOk) note('boat splits dropped: fewer than two distinct boats, or a boat not in the catalogue');
      const pier = jsonValue(src.ops_piernote) as Row | null;
      const pierText = pier && typeof pier === 'object' ? str(pier.t) : '';
      const boatId = splitOk ? null : str(src.ops_boatid) || null;
      if (final.pickup_time || final.pickup_time_end || src.ops_returnsamevan === true || boatId || splitOk || pierText) {
        tripOps.push({
          booking_trip_id: tripId, boat_id: boatId, pickup_time_final: final.pickup_time ?? null, pickup_time_final_end: final.pickup_time_end ?? null,
          pickup_final_at_pier: final.pickup_at_pier === true, return_same_van: src.ops_returnsamevan === true,
          pier_note: pierText || null, pier_note_at: pierText && pier!.at ? str(pier!.at) : null, pier_note_by: pierText ? str(pier!.by) || null : null,
        });
      }
      if (splitOk) boatSplits.forEach((s, idx) => boatSplitRows.push({ booking_trip_id: tripId, idx, ...s }));

      // Every part of the trip: the splits when there are any, else the flat fields as one whole part.
      const rawSplits = jsonValue(src.ops_vansplits);
      const splits = Array.isArray(rawSplits) && rawSplits.length > 0 ? rawSplits as Row[] : undefined;
      const parts = splits
        ? splits.map((s) => ({ counts: { ad: int(s.ad), chd: int(s.chd), inf: int(s.inf), foc: int(s.foc) }, group: int(s.vanGroup), van: str(s.vanId), ret: str(s.vanReturnId), seq: int(s.vanSeq), split: s }))
        : [{ counts, group: int(src.ops_vangroup), van: str(src.ops_vanid), ret: str(src.ops_vanreturnid), seq: int(src.ops_vanseq), split: undefined as Row | undefined }];
      if (splits && parts.reduce((sum, p) => sum + countsTotal(p.counts), 0) > countsTotal(counts)) {
        note('van splits dropped: they add up to more than the trip pax');
        return;
      }
      const selfArrive = SELF_ARRIVE.has(zone);
      for (const [idx, part] of parts.entries()) {
        if (part.group > 0 && selfArrive) { note('group dropped: self-arrive (NoTransfer) trip'); part.group = 0; }
        // A whole, ungrouped part with nothing set is what "no row" already means.
        if (!splits && part.group <= 0 && !part.van && !part.ret && part.seq <= 0) continue;
        let groupKey: string | null = null;
        if (part.group > 0) {
          groupKey = `${str(t.date)}|${str(t.routeid)}|${zone}|${part.group}`;
          const members = groupMembers.get(groupKey) ?? groupMembers.set(groupKey, { day: str(t.date), route: str(t.routeid), zone, number: part.group, vans: [] }).get(groupKey)!;
          const van = knownVan(part.van, 'group vans');
          if (van) members.vans.push(van);
        } else if (part.van) note('van dropped: set on an ungrouped passenger (legacy group 0)');
        const alt = idx > 0 && part.split?.fromAlt ? part.split : undefined;
        allocations.push({
          booking_trip_id: tripId, idx, ...part.counts, group_key: groupKey, sequence: part.seq > 0 ? part.seq : null,
          return_van_id: knownVan(part.ret, 'return vans'), source: idx === 0 ? 'main' : alt ? 'alt_pickup' : 'manual',
          pick_area_id: alt ? str(alt.pickAreaId) || null : null, pick_hotel: alt ? str(alt.pickHotel) || null : null, pick_zone: alt ? str(alt.pickZone) || null : null,
          drop_area_id: alt ? str(alt.dropAreaId) || null : null, drop_hotel: alt ? str(alt.dropHotel) || null : null, drop_zone: alt ? str(alt.dropZone) || null : null,
        });
      }
    };

    const bookings: Row[] = [], trips: Row[] = [], pax: Row[] = [], draws: Row[] = [], passengers: Row[] = [], adjustments: Row[] = [];
    // The action records (`legacy-records.ts`). The cutover runs once: what is not carried here is lost.
    const cancellations: Row[] = [], reschedules: Row[] = [], partialCancels: Row[] = [], feeItems: Row[] = [], historyLines: Row[] = [];
    // Approvals (`legacy-approvals.ts`). Legacy's `licFree` goes to the approval day when this schema keeps it (025).
    const approvals: Row[] = [], approvalDays: ApprovalDayRow[] = [];
    const approvalDayLicensedFree = (await target.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'booking_approval_days' AND column_name = 'licensed_free'`)).rowCount === 1;
    const report = { skip, note };
    for (const b of legacyBookings) {
      const legacyId = str(b.id);
      const status = str(b.status);
      if (!isBookingStatus(status)) { skip('booking', legacyId, `status ${status || '(blank)'}`); continue; }
      const legacyTripRows = tripsOf.get(legacyId) ?? [];
      if (legacyTripRows.length === 0) { skip('booking', legacyId, 'no trips'); continue; }

      const id = PREFIX + legacyId;
      const myTrips: Row[] = [], myPax: Row[] = [], myDraws: Row[] = [], myInputs: BookingTripInput[] = [];
      const myVanTrips: { t: Row; tripId: string; counts: Counts }[] = [];
      // Legacy's `ovnof` holds the outbound's `idx`, which need not equal its position in the list.
      const positionOfIdx = new Map(legacyTripRows.map((t, position) => [str(t.idx), position]));
      let problem = '';
      for (const [seq, t] of legacyTripRows.entries()) {
        const day = str(t.date), routeId = str(t.routeid);
        if (!ISO_DAY.test(day)) { problem = `trip ${seq}: bad date "${day}"`; break; }
        if (!routes.has(routeId)) { problem = `trip ${seq}: route ${routeId || '(none)'} not in catalogue`; break; }
        let rows: PaxRow[];
        try { rows = parsePaxGrid(paxGrid(t), `trip ${seq} pax`); } catch (e) { problem = (e as Error).message; break; }
        if (rows.length === 0) note('trips with no passengers (kept, hold no seats)');
        const charter = str(t.bookingmode) === 'charter';
        const tripId = `trip_${id}_${seq}`;
        let boatId: string | null = null;
        if (charter) {
          boatId = str(t.charterboatid) || charterBoat.get(`${legacyId}|${day}`) || null;
          if (!str(t.charterboatid) && boatId) note('charter boats taken from the day plan (trips__boat.charterBookingId)');
          if (!boatId) note('charters with no boat (pool subtracts their passengers)');
        }
        const ovnRaw = str(t.ovn);
        const ovn = ovnRaw === 'return' || ovnRaw === 'self' ? ovnRaw as OvnMode : undefined;
        if (ovnRaw && !ovn) note(`ovn dropped: "${ovnRaw}" is not return or self`);
        const returnDate = ovn === 'return' && str(t.ovnreturndate) ? str(t.ovnreturndate) : undefined;
        const leg = t.ovnleg === true;
        const of = leg ? positionOfIdx.get(str(t.ovnof)) : undefined;
        const pickup = pickupWindow(t.pickuptime, 'trip pickup times');
        const details = { zone: str(t.zone) || undefined, ...pickup, ovn, ovn_return_date: returnDate, ovn_leg: leg, ovn_of: of };
        myInputs.push({ route_id: routeId, service_date: day, booking_mode: charter ? 'charter' : 'seat', pax: rows, ...details });
        myTrips.push({
          id: tripId, booking_id: id, seq, route_id: routeId, service_date: day, booking_mode: charter ? 'charter' : 'seat', charter_boat_id: boatId,
          zone: details.zone ?? null, pickup_time: pickup.pickup_time ?? null, pickup_time_end: pickup.pickup_time_end ?? null,
          pickup_at_pier: pickup.pickup_at_pier === true, ovn: ovn ?? null, ovn_return_date: returnDate ?? null, ovn_leg: leg,
          // What legacy priced the trip at, and the price facts it read (migration 032). Legacy never kept the
          // rate, so `rate_type_id` stays empty and an edit falls back to the booking's rate, as legacy does.
          subtotal: amountOrNull(t.subtotal), ovn_charge: amountOrNull(t.ovncharge),
          charter_price_mode: str(t.charterpricemode) === 'manual' ? 'manual' : str(t.charterpricemode) === 'rate' ? 'rate' : null,
          charter_price_manual: amountOrNull(t.charterpricemanual), charter_price_note: str(t.charterpricenote) || null,
          ovn_of: of === undefined ? null : `trip_${id}_${of}`,
        });
        for (const r of rows) myPax.push({ booking_trip_id: tripId, category: r.category, residency: r.residency, count: r.count });
        myVanTrips.push({ t, tripId, counts: countsOf(rows) });

        // Draws: sub-lock draws count against the parent; a draw that cannot land is dropped and the
        // seats are then taken from the general pool, which is what they would have cost unlocked.
        let raw: unknown = [];
        try { raw = JSON.parse(str(t.lockdraws) || '[]'); } catch { note('draws dropped: unreadable JSON'); }
        const byLock = new Map<string, number>();
        let budget = rows.reduce((sum, r) => sum + r.count, 0);
        for (const d of Array.isArray(raw) ? raw as Row[] : []) {
          const qty = int(d.qty);
          const legacyLock = str(d.lockId);
          if (qty <= 0) continue;
          const lock = lockAt.get(parentOf.get(legacyLock) ?? legacyLock);
          if (charter) { note('draws dropped: on a charter'); continue; }
          if (!lock) { note('draws dropped: lock not imported'); continue; }
          // a bulk lock has one lock per departure: the draw lands on its day's
          const lockId = lock.route === routeId ? lock.days.get(day) : undefined;
          if (!lockId) { note('draws dropped: lock on another route or day'); continue; }
          const take = Math.min(qty, budget);
          if (take < qty) note('draws trimmed to the trip pax');
          if (take <= 0) continue;
          budget -= take;
          byLock.set(lockId, (byLock.get(lockId) ?? 0) + take);
        }
        for (const [lockId, qty] of byLock) myDraws.push({ booking_trip_id: tripId, seat_lock_id: lockId, qty });
      }
      // The same itinerary rules an API call meets: one trip per route per day, and a return leg that
      // matches its outbound. A booking that breaks them is listed, not repaired by guesswork.
      if (!problem) { try { assertItinerary(myInputs); } catch (error) { problem = (error as Error).message; } }
      if (problem) { skip('booking', legacyId, problem); continue; }

      const doc: Record<string, unknown> = {};
      for (const [column, legacyColumn] of Object.entries(HEADER_FROM_LEGACY)) if (b[legacyColumn] != null) doc[column] = b[legacyColumn];
      // The FOC reason confirming free passengers needs: the booking's own, else its FOC approval's.
      const foc = focReason(b, report);
      if (foc) doc.foc_reason = foc;
      const header: Record<string, unknown> = { ...bookingHeader(doc) };
      for (const column of TIMESTAMP_HEADER) {
        if (header[column] !== undefined && instant(header[column]) === undefined) { delete header[column]; note(`${column} dropped: not a timestamp`); }
      }
      const created = instant(b.bookedat) ?? instant(b.createdat) ?? new Date().toISOString();
      bookings.push({
        ...header,
        id, status, external_id: legacyId,
        agent_id: str(b.agentid) || null, voucher_ref: str(b.voucherref) || null, rate_type_ref: str(b.ratetyperef) || null,
        booking_mode: myTrips[0]!.booking_mode,
        cancellation_reason: str(b.cancellation_reason) || str(b.cancelreason) || null,
        created_at: created, updated_at: instant(b.updatedat) ?? created, booking_data: {},
      });
      trips.push(...myTrips); pax.push(...myPax); draws.push(...myDraws);

      // A record with no time of its own is given the booking's last change, the latest it can be.
      const lastChange = String(bookings[bookings.length - 1].updated_at);
      const cancellation = cancellationRow(b, id, status, lastChange, report);
      if (cancellation) cancellations.push(cancellation);
      const reschedule = rescheduleRow(b, id, lastChange, report);
      if (reschedule) reschedules.push(reschedule);
      partialCancels.push(...partialCancelRows(partialCancelsOf.get(legacyId) ?? [], id, myTrips.map((t) => String(t.id)), myTrips.map((t) => String(t.service_date)), lastChange, report));
      feeItems.push(...feeItemRows(feeItemsOf.get(legacyId) ?? [], id, lastChange, report));
      historyLines.push(...historyRows(historyOf.get(legacyId) ?? [], id, lastChange, report));
      // A request with no time of its own was asked when the booking was made.
      const asked = approvalRows(b, id, instant(header.booked_at) ?? created, report, approvalDayLicensedFree);
      approvals.push(...asked.approvals); approvalDays.push(...asked.days);

      // Van data: day 1 of the booking lives on the booking's own `ops_*`, every later day on that
      // trip's (legacy `bkOpsRead`, booking.js:1917). A booking that releases its seats takes no part
      // in van assignment (R1), so what it still holds is not carried over.
      const firstDay = legacyTripRows.map((t) => str(t.date)).sort()[0];
      const addOnTypes = addOnsOf.get(legacyId) ?? [];
      for (const { t, tripId, counts } of myVanTrips) {
        const src = str(t.date) === firstDay ? b : t;
        if (!holdsSeats(status)) { if (hasVanOps(src)) note('van data not imported: booking cancelled or rejected'); continue; }
        vanOpsOf(src, t, tripId, counts, groupZone(t, b, addOnTypes));
      }

      let seq = 0;
      for (const p of passengersOf.get(legacyId) ?? []) {
        const name = str(p.name);
        if (!name) { note('passengers dropped: no name'); continue; }
        passengers.push({ booking_id: id, seq: seq++, name, nationality: str(p.nationality) || null, type: str(p.type) || null, foc: p.foc ?? null });
      }
      // Discounts and extras (migration 031), as legacy saved them: a row that does not fit is dropped and counted.
      let adjustmentSeq = 0;
      for (const a of adjustmentsOf.get(legacyId) ?? []) {
        const kind = str(a.kind), mode = str(a.mode) || 'amount', value = Number(a.value);
        if ((kind !== 'discount' && kind !== 'extra') || (mode !== 'amount' && mode !== 'percent') || !(value > 0)) { note('adjustments dropped: kind, mode or value does not fit'); continue; }
        adjustments.push({ booking_id: id, seq: adjustmentSeq++, kind, mode, value, label: str(a.label) || null, note: str(a.note) || null });
      }
    }

    // ── Van groups: one row per legacy (date, route, zone, number). Members that agree give the
    //    group its van; members that disagree leave it with none and are logged — the ops board shows
    //    a group with no van, and choosing between the members' vans is theirs to do, not ours. ──
    const conflicts: string[] = [];
    const vanGroups: Row[] = [];
    const groupIdOf = new Map<string, string>();
    const numbersUsed = new Map<string, Set<number>>();
    const keys = [...groupMembers.keys()].sort((a, b) => {
      const [x, y] = [groupMembers.get(a)!, groupMembers.get(b)!];
      return x.day.localeCompare(y.day) || x.route.localeCompare(y.route) || x.number - y.number || x.zone.localeCompare(y.zone);
    });
    for (const key of keys) {
      const g = groupMembers.get(key)!;
      const used = numbersUsed.get(`${g.day}|${g.route}`) ?? numbersUsed.set(`${g.day}|${g.route}`, new Set()).get(`${g.day}|${g.route}`)!;
      // Legacy numbered per zone until mid-2026, so a number can repeat across zones of one trip.
      let number = g.number;
      if (used.has(number)) {
        number = Math.max(...used) + 1;
        conflicts.push(`${g.day} ${g.route} ${g.zone}: group ${g.number} renumbered ${number} (number already used in another zone)`);
      }
      used.add(number);
      const distinct = [...new Set(g.vans)];
      if (distinct.length > 1) conflicts.push(`${g.day} ${g.route} ${g.zone} group ${number}: members on ${distinct.join(', ')} — imported with no van`);
      const id = `${PREFIX}vgrp_${g.day}_${g.route}_${number}`;
      groupIdOf.set(key, id);
      vanGroups.push({ id, service_date: g.day, route_id: g.route, zone: g.zone, number, van_id: distinct.length === 1 ? distinct[0] : null, return_van_id: null, pickup_time: null });
    }
    for (const a of allocations) { a.van_group_id = a.group_key ? groupIdOf.get(String(a.group_key)) ?? null : null; delete a.group_key; }

    // ── Agents, their markets and salespeople. Legacy ids are kept, because bookings and seat locks
    //    already carry them in `agent_id`. Upserted like vans; an agent's programmes and activity are
    //    replaced. An agent that has left legacy is not deleted: bookings may still point at it. ──
    const agentData: string[] = []; // per-agent values dropped or changed, listed in the report
    const agentNote = (agentId: string, what: string) => agentData.push(`${agentId.padEnd(14)} ${what}`);
    const isoDay = (value: unknown, agentId: string, what: string): string | null => {
      const s = str(value);
      if (!s) return null;
      if (ISO_DAY.test(s) && !Number.isNaN(Date.parse(s))) return s;
      agentNote(agentId, `${what} "${s}" dropped, not a YYYY-MM-DD date`);
      return null;
    };
    const numberOrNull = (value: unknown): number | null => { if (value == null || str(value) === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; };

    const markets: Row[] = [];
    for (const m of legacyMarkets) {
      const id = str(m.id);
      if (!id) { skip('market', '(no id)', 'no id'); continue; }
      if (!str(m.name)) note('markets with no name: named by id');
      markets.push({ id, name: str(m.name) || id, color: str(m.color) || null, sort: m.sort == null || str(m.sort) === '' ? null : int(m.sort) });
    }
    const salesPeople: Row[] = [];
    for (const s of legacySales) {
      const id = str(s.id);
      if (!id) { skip('salesperson', '(no id)', 'no id'); continue; }
      if (!str(s.name)) note('salespeople with no name: named by code or id');
      salesPeople.push({
        id, code: str(s.code) || null, name: str(s.name) || str(s.code) || id, full_name: str(s.fullname) || null,
        designation: str(s.designation) || null, email: str(s.email) || null, tel: str(s.tel) || null, color: str(s.color) || null, active: true,
      });
    }
    const marketIds = new Set(markets.map((m) => String(m.id)));
    const salesIds = new Set(salesPeople.map((s) => String(s.id)));
    const placeholders: string[] = [];

    // Legacy re-seeds three house accounts on every load (08-app.js:436-466); they are ours, not resellers.
    const HOUSE_AGENTS = new Set(['a_walkin', 'a_staff', 'a_b2c']);
    // Legacy's `_seedContractExpiryVariety` (agents.js:43-110) overwrote these on every load with demo
    // values computed from 2026-09-02, and they were persisted. The real dates are gone from legacy, so a
    // value matching the demo exactly is dropped rather than imported as a contract that expires tomorrow.
    const DEMO_CONTRACT_END: Record<string, string> = { a01: '2026-09-27', a10: '2026-09-27', a30: '2026-09-27', a40: '2026-08-28' };
    const bindingOf = new Map(rateBindings.map((b) => [str(b.id), str(b.ratetypeid) || null]));
    const programsOf = new Map<string, string[]>();
    for (const p of legacyAgentPrograms) { const k = str(p.sb_agents_id); (programsOf.get(k) ?? programsOf.set(k, []).get(k)!).push(str(p.value)); }
    const periodsOf = new Map<string, Row[]>();
    for (const p of legacyAgentPeriods) { const k = str(p.sb_agents_id); (periodsOf.get(k) ?? periodsOf.set(k, []).get(k)!).push(p); }

    const agents: Row[] = [], agentPrograms: Row[] = [];
    const codes = new Map<string, string[]>();
    for (const a of legacyAgents) {
      const id = str(a.id);
      if (!id) { skip('agent', '(no id)', 'no id'); continue; }
      const code = str(a.code) || null;
      if (code) (codes.get(code) ?? codes.set(code, []).get(code)!).push(id);
      else note('agents with no code');
      if (!str(a.name)) agentNote(id, 'no name: named by code or id');

      // Legacy's edit form writes `bank` for Bank Transfer, which SB_PAYMENT_TYPES calls `bt`.
      let payType: string | null = str(a.paytype).toLowerCase() || null;
      if (payType === 'bank') { payType = 'bt'; note('pay_type bank → bt'); }
      if (payType && !isPayType(payType)) { agentNote(id, `pay_type "${payType}" dropped, not one of ${PAY_TYPES.join(', ')}`); payType = null; }
      // Legacy reads a missing VAT mode as none everywhere (`a.vatMode || 'none'`).
      let vatMode = str(a.vatmode).toLowerCase();
      if (!vatMode) { vatMode = 'none'; note('vat_mode blank → none, as legacy reads it'); }
      if (!isVatMode(vatMode)) { agentNote(id, `vat_mode "${vatMode}" read as none`); vatMode = 'none'; }

      // The bindings sidecar wins over the agent's own column, as it does when legacy loads (08-app.js:6269-6284).
      let rateTypeId = str(a.ratetypeid) || null;
      if (bindingOf.has(id) && bindingOf.get(id) !== rateTypeId) { note('rate_type_id taken from sb_agents_rate_bindings'); rateTypeId = bindingOf.get(id)!; }

      let contractEnd = isoDay(a.contractend, id, 'contract_end');
      let contractStatus = str(a.contractstatus) || null;
      if (contractEnd !== null && DEMO_CONTRACT_END[id] === contractEnd) {
        agentNote(id, `contract_end ${contractEnd} dropped: legacy's demo seed value, the real date is lost`);
        contractEnd = null;
        if (id === 'a40' && contractStatus === 'expired') { agentNote(id, 'contract_status expired dropped: set by the same demo seed'); contractStatus = null; }
      }

      const marketId = str(a.market) || null;
      if (marketId && !marketIds.has(marketId)) {
        marketIds.add(marketId);
        markets.push({ id: marketId, name: marketId, color: null, sort: null });
        placeholders.push(`market ${marketId}: used by agents but not in sb_markets, created with its id as its name`);
      }
      const salesId = str(a.sales) || null;
      if (salesId && !salesIds.has(salesId)) {
        salesIds.add(salesId);
        salesPeople.push({ id: salesId, code: null, name: salesId, full_name: null, designation: null, email: null, tel: null, color: null, active: false });
        placeholders.push(`salesperson ${salesId}: owns agents but not in sb_sales, created inactive with its id as its name`);
      }

      agents.push({
        id, code, name: str(a.name) || code || id, market_id: marketId, sub_market: str(a.sub) || null, sales_id: salesId, color: str(a.color) || null,
        pay_type: payType, vat_mode: vatMode, credit_days: numberOrNull(a.creditdays), credit_limit: numberOrNull(a.creditlimit),
        contact: str(a.contact) || null, email: str(a.email) || null, phone: str(a.phone) || null, note: str(a.note) || null,
        rate_type_id: rateTypeId, contract_template_id: str(a.contracttemplateid) || null,
        contract_status: contractStatus, contract_version: str(a.contractversion) || null,
        contract_start: isoDay(a.contractstart, id, 'contract_start'), contract_end: contractEnd,
        legal_name: str(a.companyinfo_legalname) || null, tax_id: str(a.companyinfo_taxid) || null, tat_license: str(a.companyinfo_tatlicense) || null,
        address: str(a.companyinfo_address) || null, company_tel: str(a.companyinfo_tel) || null, hotline: str(a.companyinfo_hotline) || null,
        fax: str(a.companyinfo_fax) || null, website: str(a.companyinfo_website) || null,
        signatory_name: str(a.agentsignatory_name) || null, signatory_designation: str(a.agentsignatory_designation) || null,
        signatory_tel: str(a.agentsignatory_tel) || null, signatory_signed_date: isoDay(a.agentsignatory_signeddate, id, 'signatory_signed_date'),
        booking_method: str(a.bookingchannel_method) || null, booking_cutoff: str(a.bookingchannel_cutoff) || null,
        booking_cancel_policy: str(a.bookingchannel_cancelpolicy) || null, booking_email: str(a.bookingchannel_email) || null,
        booking_phone: str(a.bookingchannel_phone) || null,
        house: HOUSE_AGENTS.has(id), active: true,
      });

      // `programs[]` is what legacy sells from: the list, the incomplete flag and the header counts all
      // read it. `programPeriods` only adds the booking window, and drifted because the table view and
      // import edited `programs[]` alone. So membership comes from `programs[]` and dates from the period.
      const periods = new Map<string, Row>();
      for (const p of periodsOf.get(id) ?? []) if (!periods.has(str(p.routeid))) periods.set(str(p.routeid), p);
      const listed = [...new Set((programsOf.get(id) ?? []).filter(Boolean))];
      for (const routeId of periods.keys()) if (routeId && !listed.includes(routeId)) note('programme periods dropped: route not in the agent\'s programs[]');
      for (const routeId of listed) {
        if (!routes.has(routeId)) { agentNote(id, `programme ${routeId} dropped: route not in catalogue`); continue; }
        const period = periods.get(routeId);
        if (!period) note('programmes with no period: imported with open booking dates');
        let bookFrom = period ? isoDay(period.bookfrom, id, `${routeId} book_from`) : null;
        let bookTo = period ? isoDay(period.bookto, id, `${routeId} book_to`) : null;
        if (bookFrom && bookTo && bookTo < bookFrom) { agentNote(id, `${routeId} booking window ${bookFrom}..${bookTo} dropped: ends before it starts`); bookFrom = bookTo = null; }
        agentPrograms.push({ agent_id: id, route_id: routeId, idx: agentPrograms.filter((p) => p.agent_id === id).length, book_from: bookFrom, book_to: bookTo, note: period ? str(period.note) || null : null });
      }
    }
    for (const [code, ids] of codes) if (ids.length > 1) agentData.push(`${'(code)'.padEnd(14)} ${code} is shared by ${ids.join(', ')}`);

    const agentIds = new Set(agents.map((a) => String(a.id)));
    const agentActivity: Row[] = [];
    for (const e of legacyAgentActivity) {
      const agentId = str(e.sb_agents_id), at = instant(e.at), text = str(e.text);
      if (!agentIds.has(agentId)) continue;
      if (!at) { note('agent activity dropped: no readable time'); continue; }
      if (!text) { note('agent activity dropped: no text'); continue; }
      agentActivity.push({ agent_id: agentId, at, by: str(e.by) || null, kind: str(e.kind) || 'edit', text });
    }
    const subs: Row[] = [];
    for (const s of legacyMarketSubs) {
      const marketId = str(s.sb_markets_id), name = str(s.value);
      if (!marketIds.has(marketId) || !name) continue;
      if (subs.some((x) => x.market_id === marketId && x.name === name)) { note('market sub-markets dropped: repeated'); continue; }
      subs.push({ market_id: marketId, idx: int(s.idx), name });
    }

    // ── Rate types: after salespeople, because a rate's owner must be one (placeholders included) ──
    const rateTypes = mapLegacyRateTypes(legacyRateTypes, routePiers, salesIds);
    // A code is what this import matches rate types on. If one already belongs to a different rate
    // type here (one created through the API), the unique index would abort the whole run: that rate
    // type is left out and listed instead, for someone to rename one of the two.
    const codeOwner = new Map((await target.query('SELECT id, code FROM rate_types')).rows.map((r) => [String(r.code), String(r.id)]));
    const clashes = new Set(rateTypes.rateTypes.filter((r) => codeOwner.has(String(r.code)) && codeOwner.get(String(r.code)) !== r.id).map((r) => String(r.id)));
    for (const id of clashes) {
      const code = String(rateTypes.rateTypes.find((r) => r.id === id)!.code);
      rateTypes.issues.push(`${id.padEnd(18)} skipped: code ${code} already belongs to rate type ${codeOwner.get(code)} here`);
    }
    const keepRate = (row: Row) => !clashes.has(String(row.rate_type_id ?? row.id));
    for (const key of ['rateTypes', 'routes', 'seat', 'charter', 'longtail', 'transfer'] as const) rateTypes[key] = rateTypes[key].filter(keepRate);
    const rateIds = rateTypes.rateTypes.map((r) => String(r.id));
    const rateTypesOnlyHere = (await target.query('SELECT id FROM rate_types WHERE id <> ALL($1::text[]) ORDER BY id', [legacyRateTypes.rates.map((r) => str(r.id))])).rows.map((r) => String(r.id));

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
    const removed = remove.length ? (await target.query('DELETE FROM bookings WHERE id = ANY($1::text[])', [remove])).rowCount : 0;
    const replacedBookings = (await target.query(`DELETE FROM bookings WHERE id LIKE '${PREFIX}%'`)).rowCount;
    const replacedLocks = (await target.query(`DELETE FROM seat_locks WHERE id LIKE '${PREFIX}%'`)).rowCount;
    // Deleting the bookings already cascaded their trips' allocations and trip operations.
    const replacedGroups = (await target.query(`DELETE FROM van_groups WHERE id LIKE '${PREFIX}%'`)).rowCount;
    const importedVans = vans.map((v) => String(v.id));
    // Mirroring: keyed on every legacy row, not only the ones that mapped, so a row skipped this run is
    // reported rather than deleted. An empty source is refused rather than read as "delete everything".
    if (boatDays.length === 0) throw new Error('Legacy returned no deployments (trips__boat): refusing to mirror an empty source');
    const legacyVanIds = legacyVans.map((v) => str(v.id)).filter(Boolean);
    const staleVans = (await target.query('SELECT id FROM vans WHERE id <> ALL($1::text[]) ORDER BY id', [legacyVanIds])).rows.map((r) => String(r.id));
    for (const table of ['van_day_routes', 'van_status_ranges', 'van_days']) {
      await target.query(`DELETE FROM ${table} WHERE van_id = ANY($1::text[])`, [[...importedVans, ...staleVans]]);
    }
    await target.query('DELETE FROM vans WHERE id = ANY($1::text[])', [staleVans]);
    const removedDeployments = (await target.query(`DELETE FROM deployments WHERE service_date::text || '::' || boat_id <> ALL($1::text[])
      RETURNING service_date::text AS day, boat_id, route_id`, [boatDays.map((bd) => `${str(bd.trips_id)}::${str(bd.key)}`)])).rows;
    const removedOverrides = (await target.query(`DELETE FROM boat_capacity_overrides WHERE service_date::text || '::' || boat_id <> ALL($1::text[])
      RETURNING service_date::text AS day, boat_id`, [capOverrides.map((o) => str(o.key))])).rows;
    const upsert = (rows: Row[], extra = '') => `ON CONFLICT (id) DO UPDATE SET ${Object.keys(rows[0] ?? { id: 0 }).filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).concat(extra ? [extra] : []).join(', ')}`;
    await insert('vans', vans, upsert(vans));
    // Agents before their children; programmes, activity and sub-markets are replaced, not merged.
    await insert('markets', markets, upsert(markets));
    await target.query('DELETE FROM market_subs WHERE market_id = ANY($1::text[])', [[...marketIds]]);
    await insert('market_subs', subs);
    await insert('sales_people', salesPeople, upsert(salesPeople));
    await insert('agents', agents, upsert(agents, 'updated_at = now()'));
    await target.query('DELETE FROM agent_programs WHERE agent_id = ANY($1::text[])', [[...agentIds]]);
    await target.query('DELETE FROM agent_activity WHERE agent_id = ANY($1::text[])', [[...agentIds]]);
    await insert('agent_programs', agentPrograms);

    // Rate types: the header is upserted; under it, only what legacy can hold is replaced.
    await insert('rate_types', rateTypes.rateTypes, upsert(rateTypes.rateTypes, 'updated_at = now()'));
    await target.query(`DELETE FROM rate_type_routes WHERE rate_type_id = ANY($1::text[]) AND NOT (rate_type_id || '|' || route_id = ANY($2::text[]))`,
      [rateIds, rateTypes.routes.map((r) => `${r.rate_type_id}|${r.route_id}`)]);
    // `UNIQUE (rate_type_id, seq)` is checked row by row, so the kept routes move clear of every
    // position before they take legacy's order, or swapping two would collide halfway.
    await target.query('UPDATE rate_type_routes SET seq = seq + 100000 WHERE rate_type_id = ANY($1::text[])', [rateIds]);
    await insert('rate_type_routes', rateTypes.routes, `ON CONFLICT (rate_type_id, route_id) DO UPDATE SET seq = EXCLUDED.seq,
      travel_from = EXCLUDED.travel_from, travel_to = EXCLUDED.travel_to, longtail_bundle = EXCLUDED.longtail_bundle,
      longtail_bundle_adult = EXCLUDED.longtail_bundle_adult, longtail_bundle_child = EXCLUDED.longtail_bundle_child,
      longtail_bundle_applies_to = CASE WHEN EXCLUDED.longtail_bundle IS NULL THEN NULL ELSE rate_type_routes.longtail_bundle_applies_to END`);
    await target.query('DELETE FROM rate_type_seat_prices WHERE rate_type_id = ANY($1::text[]) AND zone = ANY($2::text[])', [rateIds, [...LEGACY_HOLDS.zones]]);
    await insert('rate_type_seat_prices', rateTypes.seat);
    await target.query('DELETE FROM rate_type_charter_prices WHERE rate_type_id = ANY($1::text[]) AND boat_type = ANY($2::text[])', [rateIds, [...LEGACY_HOLDS.boatTypes]]);
    await insert('rate_type_charter_prices', rateTypes.charter);
    await target.query('DELETE FROM rate_type_longtail_prices WHERE rate_type_id = ANY($1::text[])', [rateIds]);
    await insert('rate_type_longtail_prices', rateTypes.longtail);
    await target.query('DELETE FROM rate_type_transfer_prices WHERE rate_type_id = ANY($1::text[]) AND route_id = ANY($2::text[])',
      [rateIds, legacyRateTypes.transfers.map((t) => t.routeId)]);
    await insert('rate_type_transfer_prices', rateTypes.transfer);
    // In legacy's order, oldest first, so the serial id breaks ties between entries at the same instant.
    await target.query(`INSERT INTO agent_activity (agent_id, at, by, kind, text)
      SELECT r.agent_id, r.at, r.by, r.kind, r.text FROM jsonb_populate_recordset(NULL::agent_activity, $1::jsonb) WITH ORDINALITY AS r ORDER BY r.ordinality`, [JSON.stringify(agentActivity)]);
    await insert('van_day_routes', dayRoutes);
    await insert('van_status_ranges', statusRanges);
    await insert('van_days', [...vanDays.values()]);
    await insert('deployments', deployments,
      'ON CONFLICT (service_date, boat_id) DO UPDATE SET route_id = EXCLUDED.route_id, capacity = EXCLUDED.capacity, license_pax = EXCLUDED.license_pax, registered_persons = EXCLUDED.registered_persons');
    await insert('boat_capacity_overrides', overrides, 'ON CONFLICT (boat_id, service_date) DO UPDATE SET capacity = EXCLUDED.capacity, reason = EXCLUDED.reason');
    await insert('seat_locks', locks);
    await insert('bookings', bookings);
    await insert('booking_trips', trips);
    await insert('booking_trip_pax', pax);
    await insert('booking_trip_lock_draws', draws);
    await insert('booking_passengers', passengers);
    await insert('booking_adjustments', adjustments);
    await insert('booking_cancellations', cancellations);
    await insert('booking_reschedules', reschedules);
    await insert('booking_partial_cancels', partialCancels);
    await insert('booking_fee_items', feeItems);
    await insert('booking_approvals', approvals);
    // Each imported booking has at most one approval of each kind, so (booking, kind) finds its id.
    if (approvalDays.length) {
      const free = approvalDayLicensedFree ? ', licensed_free' : '';
      await target.query(`INSERT INTO booking_approval_days (approval_id, route_id, service_date, need, over_by${free})
        SELECT ap.id, d.route_id, d.service_date, d.need, d.over_by${approvalDayLicensedFree ? ', d.licensed_free' : ''}
        FROM jsonb_to_recordset($1::jsonb) AS d(booking_id text, route_id text, service_date date, need int, over_by int, licensed_free int)
        JOIN booking_approvals ap ON ap.booking_id = d.booking_id AND ap.kind = 'approval'`, [JSON.stringify(approvalDays)]);
    }
    // In legacy's order, so the serial id keeps two lines written at the same instant in sequence.
    await target.query(`INSERT INTO booking_history (booking_id, at, by, kind, tag, text)
      SELECT r.booking_id, r.at, r.by, r.kind, r.tag, r.text FROM jsonb_populate_recordset(NULL::booking_history, $1::jsonb) WITH ORDINALITY AS r ORDER BY r.ordinality`, [JSON.stringify(historyLines)]);
    await insert('van_groups', vanGroups);
    await insert('booking_trip_operations', tripOps);
    await insert('booking_trip_boat_splits', boatSplitRows);
    await insert('booking_trip_van_allocations', allocations);

    const { rows: [after] } = await target.query(`SELECT
      (SELECT count(*) FROM bookings)::int bookings, (SELECT count(*) FROM booking_trips)::int trips,
      (SELECT count(*) FROM booking_trip_pax)::int pax_cells, (SELECT count(*) FROM booking_passengers)::int passengers,
      (SELECT count(*) FROM booking_trip_lock_draws)::int lock_draws, (SELECT count(*) FROM seat_locks)::int seat_locks, (SELECT count(*) FROM booking_approvals)::int approvals,
      (SELECT count(*) FROM deployments)::int deployments, (SELECT count(*) FROM boat_capacity_overrides)::int capacity_overrides,
      (SELECT count(*) FROM vans)::int vans, (SELECT count(*) FROM van_day_routes)::int van_day_routes, (SELECT count(*) FROM van_days)::int van_days,
      (SELECT count(*) FROM van_groups)::int van_groups, (SELECT count(*) FROM booking_trip_van_allocations)::int van_allocations,
      (SELECT count(*) FROM booking_trip_operations)::int trip_operations,
      (SELECT count(*) FROM agents)::int agents, (SELECT count(*) FROM agent_programs)::int agent_programs, (SELECT count(*) FROM agent_activity)::int agent_activity,
      (SELECT count(*) FROM markets)::int markets, (SELECT count(*) FROM sales_people)::int sales_people,
      (SELECT count(*) FROM rate_types)::int rate_types, (SELECT count(*) FROM rate_type_routes)::int rate_type_routes,
      (SELECT count(*) FROM rate_type_seat_prices)::int rate_seat_prices, (SELECT count(*) FROM rate_type_charter_prices)::int rate_charter_prices,
      (SELECT count(*) FROM rate_type_longtail_prices)::int rate_longtail_prices, (SELECT count(*) FROM rate_type_transfer_prices)::int rate_transfer_prices`);

    console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (rolled back)'}`);
    console.log(`read from legacy: ${legacyBookings.length} bookings, ${legacyTrips.length} trips, ${legacyPassengers.length} passengers, ${boatDays.length} boat-days, ${legacyLocks.length} locks, ${capOverrides.length} overrides`);
    console.log(`removed: ${removed} named booking(s); replaced ${replacedBookings} earlier-imported bookings, ${replacedLocks} locks`);
    console.log(`written: ${bookings.length} bookings, ${trips.length} trips, ${pax.length} pax cells, ${passengers.length} passengers, ${draws.length} lock draws, ${locks.length} seat locks, ${deployments.length} deployments, ${overrides.length} overrides`);
    console.log(`action records: ${cancellations.length} cancellations, ${reschedules.length} reschedules, ${partialCancels.length} partial cancels, ${feeItems.length} fee items, ${historyLines.length} history lines`);
    console.log(`approvals: ${approvals.filter((a) => a.kind === 'approval').length} approvals (${approvalDays.length} days), ${approvals.filter((a) => a.kind === 'foc').length} FOC approvals; ${approvals.filter((a) => a.status === 'pending').length} pending`);
    console.log(`vans: ${vans.length} vans, ${dayRoutes.length} month-matrix cells, ${statusRanges.length} status ranges, ${vanDays.size} van-days; replaced ${replacedGroups} earlier-imported groups`);
    console.log(`van assignment: ${vanGroups.length} groups, ${allocations.length} allocations, ${tripOps.length} trip operations`);
    console.log(`agents: ${agents.length} agents, ${agentPrograms.length} programmes, ${agentActivity.length} activity entries, ${markets.length} markets, ${subs.length} sub-markets, ${salesPeople.length} salespeople`);
    console.log(`rate types: ${rateTypes.rateTypes.length} of ${legacyRateTypes.rates.length}, ${rateTypes.routes.length} routes, ${rateTypes.seat.length} seat prices, `
      + `${rateTypes.charter.length} charter rows, ${rateTypes.longtail.length} longtail rows, ${rateTypes.transfer.length} transfer prices `
      + `(transfer tables: ${legacyRateTypes.transfers.map((t) => t.routeId).join(', ')})`);
    console.log('target now holds:', after);
    // Grouped by boat and route, so 30 days of one boat taken off one programme reads as one line.
    const byBoatRoute = new Map<string, string[]>();
    for (const d of removedDeployments) (byBoatRoute.get(`${d.boat_id} ${d.route_id}`) ?? byBoatRoute.set(`${d.boat_id} ${d.route_id}`, []).get(`${d.boat_id} ${d.route_id}`)!).push(String(d.day));
    console.log(`\nremoved, no longer in legacy: ${removedDeployments.length} deployments, ${removedOverrides.length} capacity overrides, ${staleVans.length} vans`);
    for (const [boatRoute, days] of byBoatRoute) console.log(`  deployment ${boatRoute}: ${days.length} day(s), ${days.sort()[0]} … ${days[days.length - 1]}`);
    for (const o of removedOverrides) console.log(`  capacity override ${o.boat_id} ${o.day}`);
    for (const id of staleVans) console.log(`  van ${id}`);
    console.log(`\nplaceholders created (${placeholders.length}):`);
    for (const p of placeholders) console.log(`  ${p}`);
    console.log(`\nagent data to check (${agentData.length}):`);
    for (const d of agentData) console.log(`  ${d}`);
    console.log(`\nrate type data to check (${rateTypes.issues.length}):`);
    for (const i of rateTypes.issues) console.log(`  ${i}`);
    for (const [what, n] of rateTypes.notes) note(what, n);
    console.log(`\nrate types here but not in legacy, kept (${rateTypesOnlyHere.length}):`);
    for (const id of rateTypesOnlyHere) console.log(`  ${id}`);
    console.log(`\nvan group conflicts (${conflicts.length}):`);
    for (const c of conflicts) console.log(`  ${c}`);
    console.log('\nnotes:');
    for (const [what, n] of [...notes].sort()) console.log(`  ${String(n).padStart(5)}  ${what}`);
    console.log(`\nskipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s.kind.padEnd(18)} ${s.id.padEnd(28)} ${s.reason}`);

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
