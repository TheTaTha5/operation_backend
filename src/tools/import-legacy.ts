/**
 * Backfills this service's database from the legacy monolith's (`operation_schemas`).
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npx tsx src/tools/import-legacy.ts [--commit] [--remove=<booking id>,…] [--rate-types] [--b2c=all|pushed|none] [--sales]
 *
 * Love Kingdom's orders (`b2c_…`) are imported unless `--b2c` says otherwise (`legacy-b2c.ts`): `pushed`
 * leaves out the orders Love Kingdom has pushed here itself, `none` leaves them all out. The test
 * orders `b2c_BK-…` never come.
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
 * run rolls back. Nothing else is touched except the bookings named in `--remove`.
 *
 * The sales area moved here on 2026-10-09 (todo/sales-editing-model.md): agents, markets, salespeople,
 * contract templates and issued documents are edited here, and a run leaves them alone. Only `--sales`
 * imports them, to seed a database that has none: legacy's ids kept and upserted; an agent's programmes,
 * activity and renewal archive and a market's sub-markets replaced; a document already here kept.
 * Legacy's custom nationalities and its insurance ages and review ticks follow the bookings, on every run.
 *
 * Routes and boats are this API's since 2026-10-09 (`seed:routes`, `seed:boats`): the import reads
 * them and writes neither. A boat's seats for a day set here (`set_at`) are neither replaced nor
 * deleted by legacy's.
 *
 * Rate types moved here on 2026-10-09: this API is their master, and a run leaves them alone. Only
 * `--rate-types` imports them, to seed a database that has none yet. Then they keep legacy's ids and
 * are upserted (mapping: `legacy-rate-types.ts`). Under each one,
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
 * approval's. Seat locks come with their sub-groups and their log (`legacy-locks.ts`, migration 048):
 * a bulk or month lock becomes a group `lg_<legacy id>` and one lock per departure on the days the
 * route runs, `lg_<legacy id>_<date>`; a booking's draw lands on the lock (or sub-group) it names, on
 * its day.
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
import { mapLegacyLocks } from './legacy-locks.js';
import { routeCalendar, todayInThailand, type RouteDayOverride, type RouteSeason } from '../domain/calendar.js';
import { parseBookingAddOns } from '../domain/booking-addons.js';
import { parseAllergyList } from '../domain/allergies.js';
import { altPickupParts, parseAltPickups, type AltPickup } from '../domain/alt-pickups.js';
import { mapLegacyMoney } from './legacy-invoices.js';
import { groupOrders, jobNotes, sentMarks, thaiNames, type ImportedGroup } from './legacy-van-jobs.js';
import { b2cSkipReason, parseB2CMode } from './legacy-b2c.js';
import { mapLegacyWeather } from './legacy-weather.js';
import { HOUSE_AGENT_IDS } from '../domain/agent-writes.js';
import { applyLegacyInsurance, mapLegacyNationalities, mapLegacySales } from './legacy-sales.js';

const PREFIX = 'lg_';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
type Row = Record<string, unknown>;

const commit = process.argv.includes('--commit');
const remove = (process.argv.find((arg) => arg.startsWith('--remove='))?.slice('--remove='.length) ?? '').split(',').filter(Boolean);
/** Rate types are this API's since 2026-10-09: imported only to seed an empty database. */
const withRateTypes = process.argv.includes('--rate-types');
/** How far Love Kingdom's push has taken over its orders (todo/b2c-sync-model.md): `all` until someone says. */
const b2cMode = parseB2CMode(process.argv);
/**
 * The sales area is this API's since 2026-10-09 (todo/sales-editing-model.md): agents, their programmes,
 * activity and renewals, markets, salespeople, contract templates and issued documents are imported only
 * to seed a database that has none.
 */
const withSales = process.argv.includes('--sales');
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
  payment_paid: 'paymentsnapshot_paid', payment_paid_status: 'paymentsnapshot_paidstatus', payment_deposit: 'paymentsnapshot_deposit',
  payment_balance: 'paymentsnapshot_balance',
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
    const legacyLockLog = await read('SELECT * FROM sb_seat_locks__log ORDER BY sb_seat_locks_id, idx');
    const legacyBookings = await read('SELECT * FROM sb_bookings');
    const legacyTrips = await read('SELECT * FROM sb_bookings__trips ORDER BY sb_bookings_id, idx');
    const legacyPassengers = await read('SELECT * FROM sb_bookings__passengers ORDER BY sb_bookings_id, idx');
    const legacyAdjustments = await read('SELECT * FROM sb_bookings__adjustments ORDER BY sb_bookings_id, idx');
    const legacyAreas = await read('SELECT * FROM sb_pickup_areas ORDER BY id');
    const legacyProfiles = await read('SELECT * FROM sb_pickup_time_profiles ORDER BY id');
    const legacyProfileTimes = await read('SELECT * FROM sb_pickup_time_profiles__times');
    const legacyFlatTimes = await read('SELECT * FROM sb_pickup_times');
    const legacyUpgrades = await read('SELECT * FROM sb_bookings__upgrades ORDER BY sb_bookings_id, idx');
    const legacyAddOns = await read('SELECT sb_bookings_id, idx, type, label, amount, qty, note, jad, jchd FROM sb_bookings__addons ORDER BY sb_bookings_id, idx');
    const legacyPartialCancels = await read('SELECT * FROM sb_bookings__partialcancels ORDER BY sb_bookings_id, idx');
    const legacyFeeItems = await read('SELECT * FROM sb_bookings__feeitems ORDER BY sb_bookings_id, idx');
    const legacyHistory = await read('SELECT * FROM sb_bookings__history ORDER BY sb_bookings_id, idx');
    const legacyMoney = {
      invoices: await read('SELECT * FROM sb_invoices'), bookingIds: await read('SELECT * FROM sb_invoices__bookingids'),
      lineItems: await read('SELECT * FROM sb_invoices__lineitems'), payments: await read('SELECT * FROM sb_payments'),
    };
    const legacyWeather = await read('SELECT * FROM sb_weather');
    const legacyVans = await read('SELECT * FROM sb_vehicles');
    const vanDayRoutes = await read('SELECT sb_vehicles_id, key, value FROM sb_vehicles__dayroute');
    const vanDayStatus = await read('SELECT sb_vehicles_id, key, value FROM sb_vehicles__daystatus');
    const vanRanges = await read('SELECT * FROM sb_vehicles__statusranges ORDER BY sb_vehicles_id, idx');
    const vanDrivers = await read('SELECT key, driver, phone, plate FROM vanjob_driver');
    const vanLogRows = await read('SELECT sb_vehicles_id, idx, at, kind, text FROM sb_vehicles__log ORDER BY sb_vehicles_id, idx');
    const vanSent = await read('SELECT key, value FROM vanjob_sent');
    // Van job orders (migration 080): special requests, Thai pickup names, the order staff put groups in.
    const vanSreq = await read('SELECT key, value FROM vanjob_sreq');
    const vanPickupTh = await read('SELECT key, value FROM vanjob_pickup_th');
    const groupOrderMeta = await read("SELECT value FROM app_meta WHERE key = 'bkv2_grp_order'");
    const legacyMarkets = await read('SELECT * FROM sb_markets');
    const legacyMarketSubs = await read('SELECT sb_markets_id, idx, value FROM sb_markets__subs ORDER BY sb_markets_id, idx');
    const legacySales = await read('SELECT * FROM sb_sales');
    const legacyAgents = await read('SELECT * FROM sb_agents');
    const legacyAgentPrograms = await read('SELECT sb_agents_id, idx, value FROM sb_agents__programs ORDER BY sb_agents_id, idx');
    const legacyAgentPeriods = await read('SELECT * FROM sb_agents__programperiods ORDER BY sb_agents_id, idx');
    const legacyAgentActivity = await read('SELECT * FROM sb_agents__activity ORDER BY sb_agents_id, idx');
    const rateBindings = await read('SELECT id, ratetypeid FROM sb_agents_rate_bindings');
    const legacyContractHistory = await read('SELECT * FROM sb_agents__contracthistory ORDER BY sb_agents_id, idx');
    const legacyTemplates = await read('SELECT id, value FROM contract_templates ORDER BY id');
    const legacyArtifacts = await read('SELECT id, value FROM agent_artifacts ORDER BY id');
    // Bookings' data, mirrored on every run while bookings are legacy's: custom nationalities and insurance ages.
    const legacyNationalities = await read('SELECT code, name FROM sb_nationalities ORDER BY id');
    const legacyInsurance = await read('SELECT key, value FROM insurance_overrides ORDER BY key');
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

    // ── Seat locks, their sub-groups and their log (legacy-locks.ts, migration 048). A bulk lock
    //    becomes a group and one lock per departure on the days the route runs here. ──
    const calendar = routeCalendar(
      (await target.query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons')).rows as RouteSeason[],
      (await target.query('SELECT route_id, service_date::text, kind FROM route_day_overrides')).rows as RouteDayOverride[]);
    const { groups: lockGroups, locks, events: lockEvents, lockAt } = mapLegacyLocks({ locks: legacyLocks, log: legacyLockLog }, {
      prefix: PREFIX, agents: new Set(legacyAgents.map((a) => str(a.id)).filter(Boolean)), routes,
      isOpen: (routeId, date) => calendar.isOpen(routeId, date), today: todayInThailand(), now: new Date().toISOString(),
    }, { skip, note });

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
      if (!['own', 'rented', 'partner'].includes(ownership)) note(`van ownership "${ownership}" read as own`);
      if (!str(v.name)) note('vans with no name: named by id');
      vans.push({
        id, name: str(v.name) || id, plate: str(v.plate) || null, type: str(v.type) || null, capacity,
        ownership: ['rented', 'partner'].includes(ownership) ? ownership : 'own', partner_name: ownership === 'own' ? null : str(v.partnername) || null,
        zone_base: zone === 'PK' || zone === 'KL' ? zone : null, color: str(v.color) || null,
        driver: str(v.driver) || null, driver_phone: str(v.driverphone) || null, active: v.active !== false, note: str(v.note) || null,
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
      return vanDays.get(key) ?? vanDays.set(key, { van_id: vanId, service_date: day, status: null, zone: null, driver: null, driver_phone: null, plate: null }).get(key)!;
    };
    // Legacy's dayZone map became one column per date on sb_vehicles (`dayzone_2026_06_12`).
    for (const v of legacyVans) {
      for (const [column, value] of Object.entries(v)) {
        const at = column.match(/^dayzone_(\d{4})_(\d{2})_(\d{2})$/);
        if (!at || !str(value) || !vanIds.has(str(v.id))) continue;
        if (str(value) !== 'PK' && str(value) !== 'KL') { note(`day zones dropped: "${str(value)}"`); continue; }
        vanDay(str(v.id), `${at[1]}-${at[2]}-${at[3]}`).zone = str(value);
      }
    }
    // The van's change log, in legacy's order and words. Legacy kept no name.
    const vanLog: Row[] = [];
    for (const l of vanLogRows) {
      const vanId = str(l.sb_vehicles_id), at = instant(l.at), kind = str(l.kind), text = str(l.text);
      if (!vanIds.has(vanId) || !at || !text) { note('van log lines dropped: unknown van, no time or no text'); continue; }
      if (!['created', 'edit', 'status', 'zone', 'driver'].includes(kind)) { note(`van log kind "${kind}" read as edit`); }
      vanLog.push({ van_id: vanId, at, kind: ['created', 'status', 'zone', 'driver'].includes(kind) ? kind : 'edit', text, by: null });
    }
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
    // "Sent to the driver" is per job (migration 080): it lands on the van groups, once they are known below.

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
    const upgradesOf = childrenOf(legacyUpgrades);
    const addOnsOf = new Map<string, string[]>();
    for (const a of legacyAddOns) { const k = str(a.sb_bookings_id); (addOnsOf.get(k) ?? addOnsOf.set(k, []).get(k)!).push(str(a.type)); }
    const addOnRowsOf = childrenOf(legacyAddOns);

    // ── Van assignment per trip. Groups are only known once every booking is read, so members are
    //    collected under a legacy key (date, route, zone, number) and resolved after the loop ──
    const tripOps: Row[] = [], allocations: Row[] = [], boatSplitRows: Row[] = [];
    const groupMembers = new Map<string, { day: string; route: string; zone: string; number: number; vans: string[] }>();
    const hasVanOps = (src: Row): boolean => int(src.ops_vangroup) > 0 || !!str(src.ops_vanid) || !!str(src.ops_vanreturnid) || !!str(src.ops_boatid) || !!jsonValue(src.ops_boatsplits) || !!jsonValue(src.ops_piernote)
      || !!str(src.ops_pickuptimefinal) || src.ops_returnsamevan === true || Array.isArray(jsonValue(src.ops_vansplits));
    // Check-in (migration 036): legacy's whole record per side, the main part's at the top and the
    // split parts' under `_s` (§ckSlotFix). With no `_s[0]`, the top record seeds part 0 as legacy's
    // `_ckLegacySeed` reads it. No-show counts are recomputed, so 5 records change (Open 6).
    const clockOf = (v: unknown, what: string): string | null => {
      const t = str(v);
      if (!t) return null;
      if (/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t)) return t;
      note(`check-in ${what} dropped: "${t}" is not HH:MM`);
      return null;
    };
    const countOf = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.trunc(Number(v)));
    const checkinsOf = (src: Row, tripId: string) => {
      for (const kind of ['van', 'pier'] as const) {
        const top = jsonValue(src[kind === 'van' ? 'ops_vancheckin' : 'ops_piercheckin']) as Row | null;
        if (!top || typeof top !== 'object') continue;
        const bag = top._s && typeof top._s === 'object' ? top._s as Record<string, Row> : null;
        const slots = new Map<number, Row>();
        if (bag) for (const [k, v] of Object.entries(bag)) if (v && typeof v === 'object' && /^\d+$/.test(k)) slots.set(Number(k), v);
        if (!slots.has(0)) {
          if (!bag) slots.set(0, top);
          else if (top.at || top.arrivedAt || top.clearedAt) {
            slots.set(0, { at: top.at, by: top.by, events: top.events, reasonCode: top.reasonCode, reasonNote: top.reasonNote, reasonAt: top.reasonAt,
              arrivedAt: top.arrivedAt, arrivedBy: top.arrivedBy, clearedAt: top.clearedAt, clearedBy: top.clearedBy });
          }
        }
        for (const [slot, r] of slots) {
          const key = { booking_trip_id: tripId, kind, slot };
          const reinstate = r.reinstate && typeof r.reinstate === 'object' ? r.reinstate as Row : null;
          const self = r.selfAdd && typeof r.selfAdd === 'object' ? r.selfAdd as Row : null;
          const flow = str(r.flow);
          if (flow && flow !== 'standby' && flow !== 'pending') note(`check-in flow "${flow}" dropped`);
          checkins.push({
            ...key, expected: countOf(r.expected), actual_pax: countOf(r.actualPax), checked_in_at: instant(r.at) ?? null, checked_in_by: str(r.by) || null,
            reason_code: str(r.reasonCode) || null, reason_note: str(r.reasonNote) || null, reason_at: clockOf(r.reasonAt, 'reason times'),
            arrived_at: instant(r.arrivedAt) ?? null, arrived_by: str(r.arrivedBy) || null, cleared_at: instant(r.clearedAt) ?? null, cleared_by: str(r.clearedBy) || null,
            flow: flow === 'standby' || flow === 'pending' ? flow : null, flow_at: clockOf(r.flowAt, 'flow times'), flow_by: str(r.flowBy) || null, flow_note: str(r.flowNote) || null,
            reinstate_at: reinstate ? clockOf(reinstate.at, 'reinstate times') : null, reinstate_by: reinstate ? str(reinstate.by) || null : null, reinstate_ts: reinstate ? instant(reinstate.ts) ?? null : null,
            self_add_pax: self ? countOf(self.pax) ?? 0 : null, self_add_ad: self ? countOf(self.ad) : null, self_add_chd: self ? countOf(self.chd) : null,
            self_add_inf: self ? countOf(self.inf) : null, self_add_foc: self ? countOf(self.foc) : null, self_add_at: self ? str(self.at) || null : null,
            self_add_by: self ? str(self.by) || null : null, self_add_ts: self ? instant(self.ts) ?? null : null, self_add_note: self ? str(self.note) || null : null,
          });
          let seq = 0;
          for (const e of Array.isArray(r.events) ? r.events as Row[] : []) {
            const type = str(e.type);
            if (type !== 'no_show' && type !== 'cxl') { note(`check-in events dropped: type "${type}"`); continue; }
            const pb = e.paxBreak && typeof e.paxBreak === 'object' ? e.paxBreak as Row : null;
            const u = e.undone && typeof e.undone === 'object' ? e.undone as Row : null;
            const why = u ? str(u.why) : '';
            const eventSeq = seq++;
            checkinEvents.push({
              ...key, seq: eventSeq, type, pax: countOf(e.pax) ?? 0, ad: pb ? countOf(pb.ad) : null, chd: pb ? countOf(pb.chd) : null, inf: pb ? countOf(pb.inf) : null, foc: pb ? countOf(pb.foc) : null,
              reason_code: str(e.reasonCode) || null, note: str(e.note) || null, at: clockOf(e.at, 'event times'), by: str(e.by) || null, ts: instant(e.ts) ?? null,
              undone_why: u ? (why === 'mistake' ? 'mistake' : 'found') : null, undone_at: u ? str(u.at) || null : null, undone_by: u ? str(u.by) || null : null,
              undone_ts: u ? instant(u.ts) ?? null : null, undone_note: u ? str(u.note) || null : null,
            });
            let trySeq = 0;
            for (const x of Array.isArray(e.tries) ? e.tries as Row[] : []) {
              checkinTries.push({ ...key, event_seq: eventSeq, seq: trySeq++, at: clockOf(x.at, 'try times'), by: str(x.by) || null, note: str(x.note) || null, ts: instant(x.ts) ?? null });
            }
          }
        }
      }
    };
    // Legacy builds alternate-pickup parts while it draws the board (`bkV2HealAltSplits`), so a booking
    // whose parts were never saved has none. The server's `altPickupParts` builds them here as it would.
    const altPartsOf = (tripId: string, counts: Counts, alts: readonly AltPickup[]) => {
      const mine = allocations.filter((a) => a.booking_trip_id === tripId);
      if (mine.some((a) => a.source !== 'main')) return;
      const main = mine[0];
      const current = main ? [{ idx: 0, source: 'main' as const, ...counts, group_id: main.group_key ? 'main' : null, sequence: (main.sequence as number | null) ?? null, return_van_id: (main.return_van_id as string | null) ?? null, alt: null }] : [];
      const parts = altPickupParts(alts, counts, current);
      if (!parts) return;
      note('alternate-pickup parts built: legacy had not saved them');
      for (let i = allocations.length - 1; i >= 0; i--) if (allocations[i].booking_trip_id === tripId) allocations.splice(i, 1);
      for (const part of parts) {
        allocations.push({
          booking_trip_id: tripId, idx: part.idx, ad: part.ad, chd: part.chd, inf: part.inf, foc: part.foc,
          group_key: part.group_id ? main!.group_key : null, sequence: part.sequence, return_van_id: part.return_van_id, source: part.source,
          pick_area_id: part.alt?.pick_area_id ?? null, pick_hotel: part.alt?.pick_hotel ?? null, pick_zone: part.alt?.pick_zone ?? null,
          drop_area_id: part.alt?.drop_area_id ?? null, drop_hotel: part.alt?.drop_hotel ?? null, drop_zone: part.alt?.drop_zone ?? null,
          pick_time: part.alt?.pick_time ?? null, alt_who: part.alt?.alt_who ?? null,
        });
      }
    };
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
          pick_time: alt ? clockOf(alt.pickTime, 'alternate pickup times') : null, alt_who: alt ? str(alt.altWho) || null : null,
        });
      }
    };

    // ── Pickup areas and pickup times (migration 043), as legacy has them (decision D3) ──
    const pickupAreas: Row[] = [];
    for (const a of legacyAreas) {
      const zone = str(a.zone);
      if (!['PK', 'KL', 'RN', 'NoTransfer'].includes(zone) || !str(a.id) || !str(a.name) || !str(a.timegroup)) { note('pickup areas skipped: no id, name, time group, or an unknown zone'); continue; }
      pickupAreas.push({ id: str(a.id), name: String(a.name), zone, region: a.region === null || a.region === undefined || a.region === '' ? null : String(a.region), time_group: String(a.timegroup), active: true });
    }
    const areaIds = new Set(pickupAreas.map((a) => String(a.id)));
    // Legacy keeps a profile's times as one column per area, its id with '_' for '-'; the older flat table one per time group.
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const areaOfColumn = new Map(pickupAreas.map((a) => [norm(String(a.id)), String(a.id)]));
    const groupOfColumn = new Map(pickupAreas.map((a) => [norm(String(a.time_group)), String(a.time_group)]));
    const timeProfiles: Row[] = legacyProfiles.map((pr) => ({
      id: str(pr.id), name: str(pr.name) || str(pr.id), from_date: str(pr.from) || null, to_date: str(pr.to) || null, notes: str(pr.notes) || null,
      cloned_from: str(pr.clonedfrom) || null, created_at: instant(pr.createdat) ?? new Date().toISOString(),
    }));
    const FLAT = 'prof-legacy-flat';
    if (legacyFlatTimes.length) timeProfiles.push({ id: FLAT, name: 'Legacy flat table', from_date: null, to_date: null, notes: 'Legacy SB_PICKUP_TIMES: the fallback behind the profiles (decision D4)', cloned_from: null, created_at: '2000-01-01T00:00:00.000Z' });
    const pickupCells: Row[] = [];
    const cellsFrom = (rows: Row[], profileOf: (r: Row) => string, targetOf: (column: string) => string | undefined) => {
      for (const r of rows) {
        const routeId = str(r.key);
        if (!routes.has(routeId)) { note('pickup times dropped: route not in catalogue'); continue; }
        for (const [column, value] of Object.entries(r)) {
          if (['id', 'key', 'row_pk', 'sb_pickup_time_profiles_id'].includes(column) || value === null || value === '') continue;
          const target = targetOf(column);
          if (!target) { note('pickup times dropped: column is not an area or time group'); continue; }
          const window = pickupWindow(value, 'pickup times');
          if (!window.pickup_time && !window.pickup_at_pier) continue;
          pickupCells.push({ profile_id: profileOf(r), route_id: routeId, target, pickup_time: window.pickup_time ?? null, pickup_time_end: window.pickup_time_end ?? null, pickup_at_pier: window.pickup_at_pier === true });
        }
      }
    };
    cellsFrom(legacyProfileTimes, (r) => str(r.sb_pickup_time_profiles_id), (c) => areaOfColumn.get(c));
    cellsFrom(legacyFlatTimes, () => FLAT, (c) => groupOfColumn.get(c));

    const bookings: Row[] = [], trips: Row[] = [], pax: Row[] = [], draws: Row[] = [], passengers: Row[] = [], adjustments: Row[] = [], reconfirms: Row[] = [], altPickups: Row[] = [], upgrades: Row[] = [], bookingAddOns: Row[] = [], allergies: Row[] = [], docChecks: Row[] = [], docResults: Row[] = [];
    /** Legacy passenger index → seq here, per booking: a nameless passenger is dropped, so they differ. */
    const passengerSeq = new Map<string, number>();
    const checkins: Row[] = [], checkinEvents: Row[] = [], checkinTries: Row[] = [];
    // The action records (`legacy-records.ts`). The cutover runs once: what is not carried here is lost.
    const cancellations: Row[] = [], reschedules: Row[] = [], partialCancels: Row[] = [], feeItems: Row[] = [], historyLines: Row[] = [];
    // Approvals (`legacy-approvals.ts`). Legacy's `licFree` goes to the approval day when this schema keeps it (025).
    const approvals: Row[] = [], approvalDays: ApprovalDayRow[] = [];
    // Files copied by `npm run import:attachments` (migration 040): a document or slip is linked only to a file that is here.
    const filesHere = new Set((await target.query('SELECT id FROM attachments')).rows.map((r) => String(r.id)));
    const documents: Row[] = [], upgradeSlips: Row[] = [];
    const approvalDayLicensedFree = (await target.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'booking_approval_days' AND column_name = 'licensed_free'`)).rowCount === 1;
    const report = { skip, note };
    // The special request a job order prints (legacy VANJOB_SREQ), by legacy booking id; "" = blanked.
    const jobNoteOf = jobNotes(vanSreq);
    for (const id of jobNoteOf.keys()) if (!legacyBookings.some((b) => str(b.id) === id)) note('special requests dropped: booking not in legacy');
    // Love Kingdom's orders pushed here (`legacy-b2c.ts`): with `--b2c=pushed` legacy's copy of them stays out.
    const pushedOrders = new Set((await target.query(`SELECT external_id FROM bookings WHERE external_id IS NOT NULL AND id NOT LIKE '${PREFIX}%'`)).rows.map((r) => String(r.external_id)));
    for (const b of legacyBookings) {
      const legacyId = str(b.id);
      const b2cSkip = b2cSkipReason(legacyId, b2cMode, pushedOrders);
      if (b2cSkip) { note(b2cSkip); continue; }
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

        // Draws land on the lock they name, a sub-group included; a draw that cannot land is dropped and
        // the seats are then taken from the general pool, which is what they would have cost unlocked.
        let raw: unknown = [];
        try { raw = JSON.parse(str(t.lockdraws) || '[]'); } catch { note('draws dropped: unreadable JSON'); }
        const byLock = new Map<string, number>();
        let budget = rows.reduce((sum, r) => sum + r.count, 0);
        for (const d of Array.isArray(raw) ? raw as Row[] : []) {
          const qty = int(d.qty);
          const legacyLock = str(d.lockId);
          if (qty <= 0) continue;
          const lock = lockAt.get(legacyLock);
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
      // A booking points at the area catalogue (migration 043); an id legacy no longer has is dropped, its name kept.
      for (const field of ['pickup_area_id', 'dropoff_area_id'] as const) {
        if (header[field] && !areaIds.has(String(header[field]))) { note(`${field} dropped: not in the area catalogue`); delete header[field]; }
      }
      for (const column of TIMESTAMP_HEADER) {
        if (header[column] !== undefined && instant(header[column]) === undefined) { delete header[column]; note(`${column} dropped: not a timestamp`); }
      }
      const created = instant(b.bookedat) ?? instant(b.createdat) ?? new Date().toISOString();
      bookings.push({
        ...header,
        id, status, external_id: legacyId, job_note: jobNoteOf.get(legacyId) ?? null,
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
      // Alternate pickups (migration 037), read by the API's own parser so legacy's spellings and old `qty` entries map the same way.
      let bookingAlts: AltPickup[] = [];
      const rawAlt = jsonValue(b.altpickups);
      if (Array.isArray(rawAlt) && rawAlt.length) {
        try { bookingAlts = parseAltPickups(rawAlt); bookingAlts.forEach((a, seq) => altPickups.push({ booking_id: id, seq, ...a })); }
        catch (error) { note(`alternate pickups dropped: ${(error as Error).message}`); }
      }
      const addOnTypes = addOnsOf.get(legacyId) ?? [];
      for (const { t, tripId, counts } of myVanTrips) {
        const src = str(t.date) === firstDay ? b : t;
        // What happened at check-in is kept whatever the booking's status: an on-site cancel is one of its events.
        checkinsOf(src, tripId);
        if (!holdsSeats(status)) { if (hasVanOps(src)) note('van data not imported: booking cancelled or rejected'); continue; }
        vanOpsOf(src, t, tripId, counts, groupZone(t, b, addOnTypes));
        if (bookingAlts.length) altPartsOf(tripId, counts, bookingAlts);
      }

      let seq = 0;
      for (const p of passengersOf.get(legacyId) ?? []) {
        const name = str(p.name);
        if (!name) { note('passengers dropped: no name'); continue; }
        passengerSeq.set(`${legacyId}::${int(p.idx)}`, seq);
        passengers.push({ booking_id: id, seq: seq++, name, nationality: str(p.nationality) || null, type: str(p.type) || null, foc: p.foc ?? null });
      }
      // Discounts and extras (migration 031), as legacy saved them: a row that does not fit is dropped and counted.
      let adjustmentSeq = 0;
      for (const a of adjustmentsOf.get(legacyId) ?? []) {
        const kind = str(a.kind), mode = str(a.mode) || 'amount', value = Number(a.value);
        if ((kind !== 'discount' && kind !== 'extra') || (mode !== 'amount' && mode !== 'percent') || !(value > 0)) { note('adjustments dropped: kind, mode or value does not fit'); continue; }
        adjustments.push({ booking_id: id, seq: adjustmentSeq++, kind, mode, value, label: str(a.label) || null, note: str(a.note) || null });
      }
      // Alternate pickups (migration 037), read by the API's own parser so legacy's spellings and old `qty` entries map the same way.
      // Add-ons (migration 018), through the API's own parser. Legacy's numbers are bigint, which pg
      // reads as text; a NULL count stays missing ("count every passenger"). Data check 2026-10-09:
      // 712 rows, every one fits.
      const legacyAddOnRows = addOnRowsOf.get(legacyId) ?? [];
      if (legacyAddOnRows.length) {
        const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
        try {
          parseBookingAddOns(legacyAddOnRows.map((a) => ({
            type: str(a.type), label: a.label ?? undefined, amount: num(a.amount), qty: num(a.qty), note: a.note ?? undefined,
            join_adults: num(a.jad), join_children: num(a.jchd),
          }))).forEach((a, seq) => bookingAddOns.push({
            booking_id: id, seq, type: a.type, label: a.label ?? null, amount: a.amount ?? null, qty: a.qty ?? null, note: a.note ?? null,
            join_adults: a.join_adults ?? null, join_children: a.join_children ?? null,
          }));
          if (legacyAddOnRows.some((a) => Number(a.jad) === 0 && Number(a.jchd) === 0 && a.jad !== null)) note('add-ons imported with a join of 0 adults and 0 children: nobody joins');
        } catch (error) { note(`add-ons dropped: ${(error as Error).message}`); }
      }
      // The document check (migration 042), as legacy stored it; the pre-check's raw text kept (decision C2).
      const dc = jsonValue(b.doccheck) as Row | null;
      if (dc && typeof dc === 'object') {
        const items = dc.items && typeof dc.items === 'object' ? dc.items as Row : {};
        if (Object.keys(items).some((k) => !['route', 'date', 'lead', 'pax', 'voucher', 'payment'].includes(k))) note('document check items dropped: not one of the six');
        const pre = dc.pre && typeof dc.pre === 'object' ? dc.pre as Row : null;
        const status = str(dc.status);
        docChecks.push({
          booking_id: id, status: ['pending', 'verified', 'issue'].includes(status) ? status : null, by: str(dc.by) || null, at: instant(dc.at) ?? null, note: str(dc.note) || null,
          route_ok: items.route === true, date_ok: items.date === true, lead_ok: items.lead === true, pax_ok: items.pax === true, voucher_ok: items.voucher === true, payment_ok: items.payment === true,
          pre_at: pre ? instant(pre.at) ?? null : null, pre_lang: pre ? str(pre.lang) || null : null, pre_error: pre ? str(pre.error) || null : null,
          pre_text: pre && str(pre.text) ? str(pre.text).slice(0, 3000) : null,
        });
        const results = pre?.results && typeof pre.results === 'object' ? pre.results as Record<string, Row> : {};
        for (const [item, r] of Object.entries(results)) {
          const result = str(r?.s ?? r?.result);
          if (!['route', 'date', 'lead', 'pax', 'voucher', 'payment', 'cot'].includes(item) || !['match', 'maybe', 'mismatch', 'none'].includes(result)) { note('document check results dropped: unknown item or result'); continue; }
          docResults.push({ booking_id: id, item, result, evidence: str(r.ev ?? r.evidence) || null, detail: str(r.detail) || null });
        }
      }
      // The allergy list (migration 041), through the API's own parser: 29 legacy bookings have one.
      const rawAllergies = jsonValue(b.specialmeals_allergylist);
      if (Array.isArray(rawAllergies) && rawAllergies.length) {
        try { parseAllergyList(rawAllergies).forEach((a, seq) => allergies.push({ booking_id: id, seq, ...a })); }
        catch (error) { note(`allergy lists dropped: ${(error as Error).message}`); }
      }
      // The booking's documents (migration 040, legacy bk.attachments), linked to the files copied here.
      const legacyDocs = jsonValue(b.attachments);
      let docSeq = 0;
      for (const d of Array.isArray(legacyDocs) ? legacyDocs as Row[] : []) {
        const fileId = str(d?.id);
        if (!fileId || !filesHere.has(fileId)) { note('booking documents dropped: the file is not here (run import:attachments first, or legacy lost it)'); continue; }
        const kind = str(d.kind);
        documents.push({ booking_id: id, seq: docSeq++, attachment_id: fileId, kind: ['upload', 'capture', 'paste'].includes(kind) ? kind : null, by: str(d.by) || null, at: instant(d.at) ?? null });
      }
      // On-tour upgrades (migration 038), with legacy's own fee and amount paid, and their payment slips (040).
      let upgradeSeq = 0;
      for (const u of upgradesOf.get(legacyId) ?? []) {
        const sell = Number(u.sellprice);
        if (!str(u.id) || !(sell >= 0)) { note('upgrades dropped: no id or no price'); continue; }
        const slips = jsonValue(u.slips);
        let slipSeq = 0;
        for (const x of Array.isArray(slips) ? slips as Row[] : []) {
          const fileId = str(x?.id);
          if (!fileId || !filesHere.has(fileId)) { note('upgrade payment slips dropped: the file is not here'); continue; }
          upgradeSlips.push({ booking_id: id, upgrade_id: str(u.id), seq: slipSeq++, attachment_id: fileId });
        }
        const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
        const settle = str(u.settle);
        upgrades.push({
          booking_id: id, seq: upgradeSeq++, id: str(u.id), label: str(u.label) || 'Upgrade', sell_price: sell, to_company: num(u.tocompany),
          seller: str(u.seller) || null, note: str(u.note) || null, collected: typeof u.collected === 'boolean' ? u.collected : null,
          settle: settle === 'pending' || settle === 'done' ? settle : null, method: str(u.method) || null,
          fee_pct: num(u.feepct), fee: num(u.fee), customer_paid: num(u.customerpaid), at: instant(u.at) ?? null,
        });
      }
      // Reconfirmation (migration 035). A record saved before legacy split out `sent` (§rcSplit) has no
      // such key; legacy reads a "done" one as sent, at the time and by the person who confirmed it.
      const rc = jsonValue(b.ops_reconfirm) as Row | null;
      if (rc && typeof rc === 'object') {
        const status = ['wa', 'noans', 'off', 'callback', 'done'].includes(str(rc.status)) ? str(rc.status) : null;
        if (str(rc.status) && !status) note(`reconfirm status "${str(rc.status)}" dropped`);
        const at = instant(rc.at) ?? null, by = str(rc.by) || null;
        const sent = 'sent' in rc ? rc.sent === true : status === 'done';
        const sentAt = sent ? instant(rc.sentAt) ?? ('sent' in rc ? undefined : at ?? undefined) : undefined;
        if (sent && !sentAt) note('reconfirm sent with no time: sent dropped');
        if (status || sentAt) {
          reconfirms.push({
            booking_id: id, status, via: status ? (['reconfirm', 'phone', 'list'].includes(str(rc.via)) ? str(rc.via) : 'reconfirm') : null,
            at: status ? at : null, by: status ? by : null, sent_at: sentAt ?? null, sent_by: sentAt ? str(rc.sentBy) || by : null,
          });
        }
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
      vanGroups.push({ id, service_date: g.day, route_id: g.route, zone: g.zone, number, van_id: distinct.length === 1 ? distinct[0] : null, return_van_id: null, pickup_time: null, display_order: null });
    }
    for (const a of allocations) { a.van_group_id = a.group_key ? groupIdOf.get(String(a.group_key)) ?? null : null; delete a.group_key; }

    // ── Van job orders (migration 080, legacy-van-jobs.ts): the group order, the sent marks, the Thai names ──
    const order = groupOrders(groupOrderMeta[0]?.value, (day, route, zone, n) => groupIdOf.get(`${day}|${route}|${zone}|${n}`), note);
    for (const g of vanGroups) g.display_order = order.get(String(g.id)) ?? null;
    const imported: ImportedGroup[] = keys.map((key) => {
      const g = groupMembers.get(key)!, id = groupIdOf.get(key)!;
      return { id, day: g.day, route: g.route, zone: g.zone, legacyNumber: g.number, van: (vanGroups.find((x) => x.id === id)?.van_id as string | null) ?? null };
    });
    const tripAt = new Map(trips.map((t) => [String(t.id), `${t.service_date}|${t.route_id}`]));
    const returnRuns = new Set(allocations.filter((a) => a.return_van_id).map((a) => `${tripAt.get(String(a.booking_trip_id))}|${a.return_van_id}`));
    const jobSends = sentMarks(vanSent, imported, returnRuns, note);
    const pickupNames = thaiNames(vanPickupTh, note);
    // ── Insurance ages and review ticks, onto the bookings just mapped (migration 093, `legacy-sales.ts`) ──
    const insuranceApplied = applyLegacyInsurance(legacyInsurance, {
      bookingId: (legacyId) => PREFIX + legacyId, bookings: new Map(bookings.map((b) => [String(b.id), b])), passengerSeq,
      passengers: new Map(passengers.map((row) => [`${row.booking_id}::${row.seq}`, row])),
    }, note);
    const customNationalities = mapLegacyNationalities(legacyNationalities);

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
        designation: str(s.designation) || null, email: str(s.email) || null, tel: str(s.tel) || null, color: str(s.color) || null, active: s.active !== false,
        signature: /^data:image\/(png|jpeg);base64,/.test(str(s.signature)) ? str(s.signature) : null,
      });
    }
    const marketIds = new Set(markets.map((m) => String(m.id)));
    const salesIds = new Set(salesPeople.map((s) => String(s.id)));
    const placeholders: string[] = [];

    // Legacy re-seeds its house accounts on every load (08-app.js:436-466); they are ours, not resellers (a_company: decision 14).
    const HOUSE_AGENTS = new Set<string>(HOUSE_AGENT_IDS);
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
    // Without --sales the salespeople are this API's, so a rate's owner must be one of those here.
    const salesHere = new Set((await target.query('SELECT id FROM sales_people')).rows.map((r) => String(r.id)));
    const agentsHere = new Set((await target.query('SELECT id FROM agents')).rows.map((r) => String(r.id)));
    const rateTypes = mapLegacyRateTypes(legacyRateTypes, routePiers, withSales ? salesIds : salesHere);
    // Templates, issued documents and the renewal archive (`legacy-sales.ts`), with --sales only.
    const contractsHere = new Set((await target.query('SELECT id FROM contracts')).rows.map((r) => String(r.id)));
    const sales = mapLegacySales({ templates: legacyTemplates, artifacts: legacyArtifacts, history: legacyContractHistory, agentIds, contractIds: contractsHere });
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
    // Moved here (2026-10-09): without --rate-types nothing below writes a rate type.
    if (!withRateTypes) {
      for (const key of ['rateTypes', 'routes', 'seat', 'charter', 'longtail', 'transfer', 'issues'] as const) rateTypes[key] = [];
      rateTypes.notes = new Map();
    }
    const rateIds = rateTypes.rateTypes.map((r) => String(r.id));
    const rateTypesOnlyHere = !withRateTypes ? [] : (await target.query('SELECT id FROM rate_types WHERE id <> ALL($1::text[]) ORDER BY id', [legacyRateTypes.rates.map((r) => str(r.id))])).rows.map((r) => String(r.id));

    // ── Invoices and payments (migration 045, `legacy-invoices.ts`): after the bookings and agents they name ──
    const routeNames = new Map((await target.query('SELECT id, name FROM routes')).rows.map((r) => [String(r.id), String(r.name)]));
    const firstTrips = new Map(trips.filter((t) => Number(t.seq) === 0).map((t) => [String(t.booking_id), t]));
    const money = mapLegacyMoney(legacyMoney, {
      prefix: PREFIX, agents: withSales ? agentIds : agentsHere, files: filesHere, routeName: (id) => routeNames.get(id),
      bookings: new Map(bookings.map((b) => [String(b.id), {
        voucher_ref: (b.voucher_ref as string | null) ?? null, legacy_id: String(b.external_id),
        route_id: String(firstTrips.get(String(b.id))?.route_id ?? ''), service_date: String(firstTrips.get(String(b.id))?.service_date ?? ''),
      }])),
    }, report);
    // ── Weather closures and their follow-ups (migration 060, `legacy-weather.ts`): after the bookings they name ──
    const weather = mapLegacyWeather({ closures: legacyWeather, bookings: legacyBookings }, { prefix: PREFIX, routes, bookings: new Set(bookings.map((b) => String(b.id))) }, report);

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
    // Money is mirrored like the bookings: what was imported is replaced. Until Money moves here, an
    // invoice made here on a booking that is replaced goes with it, and is listed below.
    const madeHere = (await target.query(`SELECT DISTINCT invoice_id FROM invoice_lines WHERE invoice_id NOT LIKE '${PREFIX}%'
      AND (booking_id LIKE '${PREFIX}%' OR booking_id = ANY($1::text[])) ORDER BY invoice_id`, [remove])).rows.map((r) => String(r.invoice_id));
    // Refunds and credits (migration 061) go with their invoice; legacy kept none of its own.
    const replacedRefunds = (await target.query(`DELETE FROM refunds WHERE invoice_id LIKE '${PREFIX}%' OR invoice_id = ANY($1::text[])`, [madeHere])).rowCount;
    const replacedPayments = (await target.query(`DELETE FROM payments WHERE invoice_id LIKE '${PREFIX}%' OR invoice_id = ANY($1::text[])`, [madeHere])).rowCount;
    // Imported weather closures are replaced; their follow-ups go with them, and with the bookings below.
    const replacedClosures = (await target.query(`DELETE FROM weather_closures WHERE id LIKE '${PREFIX}%'`)).rowCount;
    const replacedInvoices = (await target.query(`DELETE FROM invoices WHERE id LIKE '${PREFIX}%' OR id = ANY($1::text[])`, [madeHere])).rowCount;
    const removed = remove.length ? (await target.query('DELETE FROM bookings WHERE id = ANY($1::text[])', [remove])).rowCount : 0;
    const replacedBookings = (await target.query(`DELETE FROM bookings WHERE id LIKE '${PREFIX}%'`)).rowCount;
    const replacedLocks = (await target.query(`DELETE FROM seat_locks WHERE id LIKE '${PREFIX}%'`)).rowCount;
    // Their log lines go with them (ON DELETE CASCADE); a bulk lock's group after its departures.
    const replacedLockGroups = (await target.query(`DELETE FROM seat_lock_groups WHERE id LIKE '${PREFIX}%'`)).rowCount;
    // Deleting the bookings already cascaded their trips' allocations and trip operations.
    const replacedGroups = (await target.query(`DELETE FROM van_groups WHERE id LIKE '${PREFIX}%'`)).rowCount;
    const importedVans = vans.map((v) => String(v.id));
    // Mirroring: keyed on every legacy row, not only the ones that mapped, so a row skipped this run is
    // reported rather than deleted. An empty source is refused rather than read as "delete everything".
    if (boatDays.length === 0) throw new Error('Legacy returned no deployments (trips__boat): refusing to mirror an empty source');
    const legacyVanIds = legacyVans.map((v) => str(v.id)).filter(Boolean);
    const staleVans = (await target.query('SELECT id FROM vans WHERE id <> ALL($1::text[]) ORDER BY id', [legacyVanIds])).rows.map((r) => String(r.id));
    for (const table of ['van_day_routes', 'van_status_ranges', 'van_days', 'van_zone_ranges', 'van_log']) {
      await target.query(`DELETE FROM ${table} WHERE van_id = ANY($1::text[])`, [[...importedVans, ...staleVans]]);
    }
    await target.query('DELETE FROM vans WHERE id = ANY($1::text[])', [staleVans]);
    const removedDeployments = (await target.query(`DELETE FROM deployments WHERE service_date::text || '::' || boat_id <> ALL($1::text[])
      RETURNING service_date::text AS day, boat_id, route_id`, [boatDays.map((bd) => `${str(bd.trips_id)}::${str(bd.key)}`)])).rows;
    // A raise made here by trip-ops (migration 046: `set_at`) is kept: legacy never had it.
    const removedOverrides = (await target.query(`DELETE FROM boat_capacity_overrides WHERE set_at IS NULL AND service_date::text || '::' || boat_id <> ALL($1::text[])
      RETURNING service_date::text AS day, boat_id`, [capOverrides.map((o) => str(o.key))])).rows;
    const upsert = (rows: Row[], extra = '') => `ON CONFLICT (id) DO UPDATE SET ${Object.keys(rows[0] ?? { id: 0 }).filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).concat(extra ? [extra] : []).join(', ')}`;
    await insert('vans', vans, upsert(vans));
    // The sales area moved here (2026-10-09): without --sales nothing below writes an agent, a market,
    // a salesperson, a template, an issued document or a renewal.
    if (withSales) {
      // Agents before their children; programmes, activity, sub-markets and the archive are replaced, not merged.
      await insert('markets', markets, upsert(markets));
      await target.query('DELETE FROM market_subs WHERE market_id = ANY($1::text[])', [[...marketIds]]);
      await insert('market_subs', subs);
      await insert('sales_people', salesPeople, upsert(salesPeople));
      await insert('agents', agents, upsert(agents, 'updated_at = now()'));
      await target.query('DELETE FROM agent_programs WHERE agent_id = ANY($1::text[])', [[...agentIds]]);
      await target.query('DELETE FROM agent_activity WHERE agent_id = ANY($1::text[])', [[...agentIds]]);
      await insert('agent_programs', agentPrograms);
      await target.query('DELETE FROM agent_contract_history WHERE agent_id = ANY($1::text[])', [[...agentIds]]);
      await target.query(`INSERT INTO agent_contract_history (agent_id, version, archived_at, contract_start, contract_end, rate_type_id, programs, signatory, archived_by)
        SELECT r.agent_id, r.version, r.archived_at, r.contract_start, r.contract_end, r.rate_type_id, r.programs, r.signatory, r.archived_by
        FROM jsonb_populate_recordset(NULL::agent_contract_history, $1::jsonb) WITH ORDINALITY AS r ORDER BY r.ordinality`, [JSON.stringify(sales.history)]);
      // One default: legacy's takes over from any made here, as a seed's upsert would.
      const legacyDefault = sales.templates.find((t) => t.is_default)?.id;
      if (legacyDefault) await target.query('UPDATE contract_templates SET is_default = false WHERE is_default AND id <> $1', [legacyDefault]);
      await insert('contract_templates', sales.templates, upsert(sales.templates, 'updated_at = now()'));
      // An issued document is frozen: one already here is left as it is.
      await insert('contract_documents', sales.documents, 'ON CONFLICT (id) DO NOTHING');
    }
    // Legacy's custom nationalities, on every run while bookings are legacy's; never deleted, never a built-in.
    await insert('nationalities', customNationalities.nationalities, 'ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name WHERE NOT nationalities.builtin');

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
    if (withSales) {
      await target.query(`INSERT INTO agent_activity (agent_id, at, by, kind, text)
        SELECT r.agent_id, r.at, r.by, r.kind, r.text FROM jsonb_populate_recordset(NULL::agent_activity, $1::jsonb) WITH ORDINALITY AS r ORDER BY r.ordinality`, [JSON.stringify(agentActivity)]);
    }
    await insert('van_day_routes', dayRoutes);
    await insert('van_status_ranges', statusRanges);
    await insert('van_days', [...vanDays.values()]);
    await insert('van_log', vanLog);
    await insert('deployments', deployments,
      'ON CONFLICT (service_date, boat_id) DO UPDATE SET route_id = EXCLUDED.route_id, capacity = EXCLUDED.capacity, license_pax = EXCLUDED.license_pax, registered_persons = EXCLUDED.registered_persons');
    // A day's seats set here (trip-ops raise, PUT /v1/boats/{id}/capacity-overrides: `set_at`) win over legacy's.
    await insert('boat_capacity_overrides', overrides, 'ON CONFLICT (boat_id, service_date) DO UPDATE SET capacity = EXCLUDED.capacity, reason = EXCLUDED.reason WHERE boat_capacity_overrides.set_at IS NULL');
    await insert('seat_lock_groups', lockGroups);
    // Parents before their sub-groups: `parent_id` is a key.
    await insert('seat_locks', locks.filter((l) => !l.parent_id));
    await insert('seat_locks', locks.filter((l) => l.parent_id));
    // In legacy's order, so the serial id is the log's order.
    await target.query(`INSERT INTO seat_lock_events (lock_id, group_id, type, qty, trip_date, booking_id, note, day, at, by, imported)
      SELECT e.lock_id, e.group_id, e.type, e.qty, e.trip_date, e.booking_id, e.note, e.day, e.at, e.by, e.imported
      FROM jsonb_populate_recordset(NULL::seat_lock_events, $1::jsonb) WITH ORDINALITY AS e ORDER BY e.ordinality`, [JSON.stringify(lockEvents)]);
    await insert('pickup_areas', pickupAreas, upsert(pickupAreas));
    await insert('pickup_time_profiles', timeProfiles, upsert(timeProfiles));
    await target.query('DELETE FROM pickup_times WHERE profile_id = ANY($1::text[])', [timeProfiles.map((pr) => String(pr.id))]);
    await insert('pickup_times', pickupCells);
    await insert('bookings', bookings);
    await insert('booking_trips', trips);
    await insert('booking_trip_pax', pax);
    await insert('booking_trip_lock_draws', draws);
    await insert('booking_passengers', passengers);
    await insert('booking_adjustments', adjustments);
    await insert('booking_reconfirmations', reconfirms);
    await insert('booking_alt_pickups', altPickups);
    await insert('booking_upgrades', upgrades);
    await insert('booking_upgrade_slips', upgradeSlips);
    await insert('booking_documents', documents);
    await insert('booking_allergies', allergies);
    await insert('booking_doc_checks', docChecks);
    await insert('booking_doc_check_results', docResults);
    await insert('booking_addons', bookingAddOns);
    await insert('booking_trip_checkins', checkins);
    await insert('booking_trip_checkin_events', checkinEvents);
    await insert('booking_trip_checkin_event_tries', checkinTries);
    await insert('booking_cancellations', cancellations);
    await insert('booking_reschedules', reschedules);
    await insert('booking_partial_cancels', partialCancels);
    await insert('booking_fee_items', feeItems);
    await insert('invoices', money.invoices);
    await insert('invoice_lines', money.lines);
    await insert('payments', money.payments);
    await insert('payment_slips', money.slips);
    await insert('weather_closures', weather.closures);
    await insert('weather_cases', weather.cases);
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
    // Marks on imported groups went with them; a return-only mark is an imported van's dated row, replaced like the others.
    await target.query('DELETE FROM van_job_sends WHERE group_id IS NULL AND van_id = ANY($1::text[])', [importedVans]);
    await insert('van_job_sends', jobSends);
    // Legacy is the Thai names' master until operations cuts over: replaced whole.
    await target.query('DELETE FROM pickup_name_th');
    await insert('pickup_name_th', pickupNames);

    const { rows: [after] } = await target.query(`SELECT
      (SELECT count(*) FROM bookings)::int bookings, (SELECT count(*) FROM booking_trips)::int trips,
      (SELECT count(*) FROM booking_trip_pax)::int pax_cells, (SELECT count(*) FROM booking_passengers)::int passengers,
      (SELECT count(*) FROM booking_trip_lock_draws)::int lock_draws, (SELECT count(*) FROM seat_locks)::int seat_locks, (SELECT count(*) FROM seat_lock_groups)::int seat_lock_groups, (SELECT count(*) FROM seat_lock_events)::int seat_lock_events, (SELECT count(*) FROM booking_approvals)::int approvals,
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
    console.log(`Love Kingdom's orders: --b2c=${b2cMode}; ${pushedOrders.size} booking(s) here carry an external_id (pushed)`);
    console.log(`read from legacy: ${legacyBookings.length} bookings, ${legacyTrips.length} trips, ${legacyPassengers.length} passengers, ${boatDays.length} boat-days, ${legacyLocks.length} locks, ${capOverrides.length} overrides`);
    console.log(`removed: ${removed} named booking(s); replaced ${replacedBookings} earlier-imported bookings, ${replacedLocks} locks, ${replacedLockGroups} bulk locks`);
    console.log(`written: ${bookings.length} bookings, ${trips.length} trips, ${pax.length} pax cells, ${passengers.length} passengers, ${draws.length} lock draws, ${locks.length} seat locks (${locks.filter((l) => l.parent_id).length} sub-groups, ${locks.filter((l) => l.group_id && !l.parent_id).length} bulk departures of ${lockGroups.length} bulk locks), ${lockEvents.length} lock log lines, ${deployments.length} deployments, ${overrides.length} overrides`);
    console.log(`action records: ${cancellations.length} cancellations, ${reschedules.length} reschedules, ${partialCancels.length} partial cancels, ${feeItems.length} fee items, ${historyLines.length} history lines`);
    console.log(`money: ${money.invoices.length} invoices (${money.lines.length} lines), ${money.payments.length} payments, ${money.slips.length} slips; replaced ${replacedInvoices} invoices, ${replacedPayments} payments`);
    if (madeHere.length) console.log(`  removed with the bookings they named, made here: invoices ${madeHere.join(', ')}`);
    for (const [change, count] of money.statusDiffers) console.log(`  invoice status legacy stored → worked out here: ${change} (${count})`);
    if (replacedRefunds) console.log(`  replaced ${replacedRefunds} refunds and credits made here on those invoices`);
    const byStatus = (s: string) => weather.cases.filter((c) => c.status === s).length;
    console.log(`weather: ${weather.closures.length} closures, ${weather.cases.length} follow-ups (${byStatus('awaiting')} awaiting, ${byStatus('notified')} notified, ${byStatus('resolved')} resolved); replaced ${replacedClosures} closures`);
    console.log(`approvals: ${approvals.filter((a) => a.kind === 'approval').length} approvals (${approvalDays.length} days), ${approvals.filter((a) => a.kind === 'foc').length} FOC approvals; ${approvals.filter((a) => a.status === 'pending').length} pending`);
    console.log(`vans: ${vans.length} vans, ${dayRoutes.length} month-matrix cells, ${statusRanges.length} status ranges, ${vanDays.size} van-days; replaced ${replacedGroups} earlier-imported groups`);
    console.log(`van assignment: ${vanGroups.length} groups, ${allocations.length} allocations, ${tripOps.length} trip operations, ${vanLog.length} van log lines`);
    console.log(`van job orders: ${jobSends.length} of ${vanSent.length} sent marks (${jobSends.filter((s) => !s.group_id).length} return-only), `
      + `${bookings.filter((b) => b.job_note !== null).length} special requests (${bookings.filter((b) => b.job_note === '').length} blanked), `
      + `${pickupNames.length} of ${vanPickupTh.length} Thai pickup names, ${order.size} groups ordered`);
    if (!withSales) console.log('agents, markets, salespeople, templates, documents: not imported (this API is their master since 2026-10-09; --sales seeds an empty database)');
    else {
      console.log(`agents: ${agents.length} agents, ${agentPrograms.length} programmes, ${agentActivity.length} activity entries, ${markets.length} markets, ${subs.length} sub-markets, ${salesPeople.length} salespeople`);
      console.log(`sales: ${sales.templates.length} contract templates, ${sales.documents.length} issued documents, ${sales.history.length} archived contracts`);
    }
    console.log(`nationalities: ${customNationalities.nationalities.length} custom of ${legacyNationalities.length}; insurance: ${insuranceApplied} of ${legacyInsurance.length} rows on imported bookings`);
    if (!withRateTypes) console.log('rate types: not imported (this API is their master since 2026-10-09; --rate-types seeds an empty database)');
    else console.log(`rate types: ${rateTypes.rateTypes.length} of ${legacyRateTypes.rates.length}, ${rateTypes.routes.length} routes, ${rateTypes.seat.length} seat prices, `
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
    const salesIssues = [...(withSales ? sales.issues : []), ...customNationalities.issues];
    console.log(`\nsales data to check (${salesIssues.length}):`);
    for (const i of salesIssues) console.log(`  ${i}`);
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
