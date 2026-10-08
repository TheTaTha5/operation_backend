import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  assertKnownLocks, assertKnownRoutes, bookingView, claimsMoreSeats, dayKey, demandByDay, drawnLockIds, movedTripIds, nextTrips,
  licenceWarnings, partialCancelByKey, partialCancelTrips, planTrips, rescheduleTrips, restoreTrips, reweighs, tripsToCheckOpen,
  type Boat, type Booking, type BookingChanges, type BookingInput, type BookingListQuery, type BookingTripInput, type Deployment, type Exclusion, type LockDraw, type OvnMode, type RouteDay, type SeatLock, type StoredBooking, type StoredTrip,
  decodeBookingCursor, encodeBookingCursor,
} from './operations.js';
import { type PaxCategory, type PaxGrid, type PaxResidency } from './pax.js';
import {
  assertEditable, assertOpen, assertRestorable, createdLine, editedLine, movedLine, partialCancelLine, partialCancelRecord, partialCountLine, planCancel, planRescheduleRecord,
  confirmationStamp, externalIdTaken, planStatusCommand, refuse, restoredLine, stripServerOwned, totalAfterRefund, type StatusCommand, type StatusCommandRequest,
  type BookingCancellation, type BookingFeeItem, type BookingPartialCancel, type BookingReschedule, type CancelGroup, type CancelRequest, type ChargeType, type Collect,
  type HistoryEntry, type HistoryLine, type LockShortWarning, type PartialCancelRequest, type RescheduleRequest,
} from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { assertDayFits, assertLockFits, capacityNumbers, dayCapacity, weighDay, type Capacity, type DayDeployment, type DayState, type HeldLock, type HeldTrip } from './capacity.js';
import { applyCalendarChange, assertCloseAllowed, assertRoutesOpen, eachDate, routeCalendar, type CalendarChange, type CalendarHold, type Route, type RouteDate, type RouteDayOverride, type RouteKind, type RouteSeason } from './calendar.js';
import {
  BOOKING_HEADER_COLUMNS, BOOKING_HEADER_DATE_COLUMNS, BOOKING_HEADER_NUMERIC_COLUMNS, BOOKING_HEADER_TIMESTAMP_COLUMNS,
  type BookingHeader,
} from './booking-header.js';
import type { BookingPassenger, BookingPassengerInput } from './booking-passengers.js';
import type { BookingAddOn, BookingAddOnInput } from './booking-addons.js';
import { pickupFields } from './pickup.js';
import {
  agentSummary, agentView, latestActivity, selectAgents, sortMarkets, sortSalesPeople,
  type Agent, type AgentActivity, type AgentListQuery, type AgentSummary, type Market, type PayType, type SalesPerson, type StoredAgent, type VatMode,
} from './agents.js';
import {
  assertOwner, assertRateTypeUnused, assertRouteBlock, generateRateTypeCode, newRateTypeRow, nextRouteSeq, patchedRateTypeRow, rateTypeExists, rateTypeView, routeRows, selectRateTypes,
  type BundleAppliesTo, type BundleMode, type NationalityScope, type RateTier, type RateType, type RateTypeCreate, type RateTypeListQuery, type RateTypePatch, type RateTypeRows,
  type RateTypeSummary, type RouteBlock, type RouteRows, type SeatPriceRow,
} from './rate-types.js';
import {
  decidedRecord, decideStatus, discountOf, focCountOf, reweigh,
  type ApprovalDay, type ApprovalKind, type ApprovalStatus, type ApprovalWarning, type BookingApproval, type NewApproval,
} from './booking-approvals.js';

/**
 * `bookingHoldsSeats` in SQL, for the seat counts that cannot load every booking: a
 * `pending_approval` booking waiting for an over-allotment approval holds no seats. The rule is
 * written once in `booking-approvals.ts`; this is its translation, kept equal by running the suite
 * on both stores. `b` must be the booking.
 */
const WAITING_FOR_SEATS = `(b.status = 'pending_approval' AND EXISTS (
  SELECT 1 FROM booking_approvals ap WHERE ap.booking_id = b.id AND ap.kind = 'approval' AND ap.status = 'pending' AND ap.over_capacity))`;

const optionalInt = (value: unknown): number | undefined => value === null || value === undefined ? undefined : Number(value);
/** Calendar rows, read with their dates cast to text in SQL. */
const season = (row: QueryResultRow): RouteSeason => ({ id: String(row.id), route_id: String(row.route_id), kind: row.kind as RouteSeason['kind'], from_date: String(row.from_date), to_date: String(row.to_date) });
const dayOverride = (row: QueryResultRow): RouteDayOverride => ({ route_id: String(row.route_id), service_date: String(row.service_date), kind: row.kind as RouteDayOverride['kind'] });
type LockInput = Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>;
/** `40001` serialization failure, `40P01` deadlock. Both mean "try again", not "the request was wrong". */
const TRANSACTION_ATTEMPTS = 8;
const isRetryable = (error: unknown): boolean => error instanceof Error && ['40001', '40P01'].includes((error as Error & { code?: string }).code ?? '');
const asIso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const dateOnly = (value: unknown): string => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value);

/**
 * A booking with its trips and their passenger cells, assembled in one round trip.
 *
 * Dates are cast to text inside the JSON so the driver never hands back a `Date` for us to
 * re-render. Nothing is aggregated or derived here — totals and seat holdings come from
 * `bookingView`, which the in-process store calls too.
 */
/**
 * `DATE` columns are cast in the query and aliased, rather than relying on `b.*` being overridden
 * by a later duplicate name. `pg` builds its row object by field name, so a duplicate would work by
 * position — a rule nothing in the file states and a reader could reasonably reorder.
 */
const HEADER_DATE_SELECT = BOOKING_HEADER_DATE_COLUMNS.map((column) => `b.${column}::text AS ${column}_text`).join(', ');

const BOOKING_SELECT = `SELECT b.*, ${HEADER_DATE_SELECT}, COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'seq', t.seq, 'route_id', t.route_id, 'service_date', t.service_date::text, 'booking_mode', t.booking_mode, 'charter_boat_id', t.charter_boat_id,
      'zone', t.zone, 'pickup_time', t.pickup_time, 'pickup_time_end', t.pickup_time_end, 'pickup_at_pier', t.pickup_at_pier, 'ovn', t.ovn, 'ovn_return_date', t.ovn_return_date::text, 'ovn_leg', t.ovn_leg, 'ovn_of', t.ovn_of,
      'pax', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', p.category, 'residency', p.residency, 'count', p.count) ORDER BY p.category, p.residency)
                       FROM booking_trip_pax p WHERE p.booking_trip_id = t.id), '[]'::jsonb),
      'lock_draws', COALESCE((SELECT jsonb_agg(jsonb_build_object('lock_id', d.seat_lock_id, 'qty', d.qty) ORDER BY d.seat_lock_id)
                              FROM booking_trip_lock_draws d WHERE d.booking_trip_id = t.id), '[]'::jsonb)
    ) ORDER BY t.seq)
    FROM booking_trips t WHERE t.booking_id = b.id), '[]'::jsonb) AS trips,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', pg.seq, 'name', pg.name, 'nationality', pg.nationality, 'type', pg.type, 'foc', pg.foc) ORDER BY pg.seq)
    FROM booking_passengers pg WHERE pg.booking_id = b.id), '[]'::jsonb) AS passengers,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', a.seq, 'type', a.type, 'label', a.label, 'amount', a.amount, 'qty', a.qty, 'note', a.note,
      'join_adults', a.join_adults, 'join_children', a.join_children) ORDER BY a.seq)
    FROM booking_addons a WHERE a.booking_id = b.id), '[]'::jsonb) AS add_ons,
  (SELECT jsonb_build_object('category', c.category, 'group', c.grp, 'note', c.note, 'charge_type', c.charge_type, 'charge_amount', c.charge_amount, 'at', c.at, 'by', c.by)
    FROM booking_cancellations c WHERE c.booking_id = b.id) AS cancellation,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('from_date', r.from_date::text, 'to_date', r.to_date::text, 'reason', r.reason, 'charge_type', r.charge_type,
      'charge_amount', r.charge_amount, 'collect', r.collect, 'at', r.at, 'by', r.by) ORDER BY r.at, r.id)
    FROM booking_reschedules r WHERE r.booking_id = b.id), '[]'::jsonb) AS reschedules,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('trip_id', pc.booking_trip_id, 'service_date', pc.service_date::text, 'pax_removed', pc.pax_removed, 'count', pc.count,
      'category', pc.category, 'group', pc.grp, 'note', pc.note, 'charged_count', pc.charged_count, 'charged_amount', pc.charged_amount,
      'waived_count', pc.waived_count, 'waived_amount', pc.waived_amount, 'at', pc.at, 'by', pc.by) ORDER BY pc.at, pc.id)
    FROM booking_partial_cancels pc WHERE pc.booking_id = b.id), '[]'::jsonb) AS partial_cancels,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('type', f.type, 'label', f.label, 'amount', f.amount, 'at', f.at) ORDER BY f.at, f.id)
    FROM booking_fee_items f WHERE f.booking_id = b.id), '[]'::jsonb) AS fee_items,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('kind', ap.kind, 'status', ap.status, 'over_capacity', ap.over_capacity, 'over_total', ap.over_total,
      'discount', ap.discount, 'foc_count', ap.foc_count, 'target_status', ap.target_status, 'requested_by', ap.requested_by, 'requested_at', ap.requested_at,
      'decided_by', ap.decided_by, 'decided_at', ap.decided_at, 'note', ap.note,
      'days', COALESCE((SELECT jsonb_agg(jsonb_build_object('route_id', ad.route_id, 'service_date', ad.service_date::text, 'need', ad.need, 'over_by', ad.over_by)
                                         ORDER BY ad.service_date, ad.route_id COLLATE "C")
                        FROM booking_approval_days ad WHERE ad.approval_id = ap.id), '[]'::jsonb)) ORDER BY ap.requested_at, ap.id)
    FROM booking_approvals ap WHERE ap.booking_id = b.id), '[]'::jsonb) AS approvals
  FROM bookings b`;

/**
 * A `timestamptz` inside JSON arrives as text in the session's zone (`2026-10-05 09:11:09.1+07`),
 * not the `Z` instant the in-process store writes, so it is re-rendered the same way.
 */
const jsonInstant = (value: unknown): string => new Date(String(value)).toISOString();
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const NUMERIC_HEADER = new Set<string>(BOOKING_HEADER_NUMERIC_COLUMNS);
const TIMESTAMP_HEADER = new Set<string>(BOOKING_HEADER_TIMESTAMP_COLUMNS);
const DATE_HEADER = new Set<string>(BOOKING_HEADER_DATE_COLUMNS);

/** Reads the header columns off a row, converting the three types `pg` does not hand back as-is. */
const newTripId = (): string => `trip_${randomUUID()}`;

const header = (row: QueryResultRow): BookingHeader => {
  const values: Record<string, unknown> = {};
  for (const column of BOOKING_HEADER_COLUMNS) {
    const raw = DATE_HEADER.has(column) ? row[`${column}_text`] : row[column];
    if (raw === null || raw === undefined) continue;
    values[column] = NUMERIC_HEADER.has(column) ? Number(raw) : TIMESTAMP_HEADER.has(column) ? asIso(raw) : raw;
  }
  return values as BookingHeader;
};

const stored = (row: QueryResultRow): StoredBooking => ({
  ...header(row),
  id: String(row.id), status: row.status as Booking['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
  cancellation_reason: row.cancellation_reason ?? undefined, external_id: row.external_id ?? undefined, agent_id: row.agent_id ?? undefined,
  voucher_ref: row.voucher_ref ?? undefined, rate_type_ref: row.rate_type_ref ?? undefined, booking_data: row.booking_data ?? undefined,
  trips: (row.trips as Record<string, unknown>[]).map((trip) => ({
    id: String(trip.id), seq: Number(trip.seq), route_id: String(trip.route_id), service_date: String(trip.service_date), booking_mode: String(trip.booking_mode),
    pax: (trip.pax as Record<string, unknown>[]).map((cell) => ({ category: cell.category as PaxCategory, residency: cell.residency as PaxResidency, count: Number(cell.count) })),
    ...(trip.charter_boat_id ? { charter_boat_id: String(trip.charter_boat_id) } : {}),
    lock_draws: (trip.lock_draws as Record<string, unknown>[]).map((draw): LockDraw => ({ lock_id: String(draw.lock_id), qty: Number(draw.qty) })),
    ...(trip.zone ? { zone: String(trip.zone) } : {}),
    ...pickupFields({ pickup_time: trip.pickup_time ? String(trip.pickup_time) : undefined, pickup_time_end: trip.pickup_time_end ? String(trip.pickup_time_end) : undefined, pickup_at_pier: trip.pickup_at_pier === true }),
    ...(trip.ovn ? { ovn: trip.ovn as OvnMode } : {}),
    ...(trip.ovn_return_date ? { ovn_return_date: String(trip.ovn_return_date) } : {}),
    ovn_leg: trip.ovn_leg === true,
    ...(trip.ovn_of ? { ovn_of: String(trip.ovn_of) } : {}),
  })),
  passengers: (row.passengers as Record<string, unknown>[]).map((passenger) => ({
    seq: Number(passenger.seq), name: String(passenger.name),
    nationality: passenger.nationality ?? undefined, type: passenger.type ?? undefined,
    foc: passenger.foc ?? undefined,
  })) as BookingPassenger[],
  // A NULL column is left off rather than sent as null, matching the in-process store, which never
  // set it. `amount` is NUMERIC; Number() keeps it a JSON number whichever way `pg` hands it over.
  add_ons: (row.add_ons as Record<string, unknown>[]).map((addOn): BookingAddOn => ({
    seq: Number(addOn.seq), type: String(addOn.type),
    ...(addOn.label == null ? {} : { label: String(addOn.label) }),
    ...(addOn.amount == null ? {} : { amount: Number(addOn.amount) }),
    ...(addOn.qty == null ? {} : { qty: Number(addOn.qty) }),
    ...(addOn.note == null ? {} : { note: String(addOn.note) }),
    ...(addOn.join_adults == null ? {} : { join_adults: Number(addOn.join_adults) }),
    ...(addOn.join_children == null ? {} : { join_children: Number(addOn.join_children) }),
  })),
  ...(row.cancellation ? { cancellation: cancellation(row.cancellation as Record<string, unknown>) } : {}),
  reschedules: (row.reschedules as Record<string, unknown>[]).map((r): BookingReschedule => ({
    from_date: String(r.from_date), to_date: String(r.to_date), reason: textOrNull(r.reason), charge_type: r.charge_type as ChargeType,
    charge_amount: Number(r.charge_amount), collect: r.collect as Collect, at: jsonInstant(r.at), by: textOrNull(r.by),
  })),
  partial_cancels: (row.partial_cancels as Record<string, unknown>[]).map((p): BookingPartialCancel => ({
    trip_id: textOrNull(p.trip_id), service_date: textOrNull(p.service_date), pax_removed: p.pax_removed as PaxGrid, count: Number(p.count),
    category: textOrNull(p.category), group: textOrNull(p.group) as CancelGroup | null, note: textOrNull(p.note),
    charged: { count: Number(p.charged_count), amount: Number(p.charged_amount) }, waived: { count: Number(p.waived_count), amount: Number(p.waived_amount) },
    at: jsonInstant(p.at), by: textOrNull(p.by),
  })),
  fee_items: (row.fee_items as Record<string, unknown>[]).map((f): BookingFeeItem => ({
    type: String(f.type), label: textOrNull(f.label), amount: Number(f.amount), at: jsonInstant(f.at),
  })),
  approvals: (row.approvals as Record<string, unknown>[]).map(approval),
});
const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const approval = (a: Record<string, unknown>): BookingApproval => ({
  kind: a.kind as ApprovalKind, status: a.status as ApprovalStatus, over_capacity: a.over_capacity === true,
  over_total: numberOrNull(a.over_total), discount: numberOrNull(a.discount), foc_count: numberOrNull(a.foc_count),
  target_status: a.target_status as Booking['status'], requested_by: textOrNull(a.requested_by), requested_at: jsonInstant(a.requested_at),
  decided_by: textOrNull(a.decided_by), decided_at: a.decided_at == null ? null : jsonInstant(a.decided_at), note: textOrNull(a.note),
  days: (a.days as Record<string, unknown>[]).map((d): ApprovalDay => ({ route_id: String(d.route_id), service_date: String(d.service_date), need: Number(d.need), over_by: Number(d.over_by) })),
});
const cancellation = (c: Record<string, unknown>): BookingCancellation => ({
  category: String(c.category), group: c.group as CancelGroup, note: textOrNull(c.note), charge_type: c.charge_type as ChargeType,
  charge_amount: Number(c.charge_amount), at: jsonInstant(c.at), by: textOrNull(c.by),
});
const booking = (row: QueryResultRow): Booking => bookingView(stored(row));
const lock = (row: QueryResultRow): SeatLock => ({ id: String(row.id), route_id: String(row.route_id), service_date: dateOnly(row.service_date), pax: Number(row.pax), status: row.status as SeatLock['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at), released_at: row.released_at ? asIso(row.released_at) : undefined, agent_id: row.agent_id ?? undefined, drawn_pax: Number(row.drawn_pax ?? 0) });

const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/**
 * Every `agents` column with its `DATE`s cast to text, and the programmes in order. The row is read
 * into `StoredAgent` and nothing else; `agents.ts` decides everything the API says about it.
 */
const AGENT_SELECT = `SELECT a.*, a.contract_start::text AS contract_start_text, a.contract_end::text AS contract_end_text,
    a.signatory_signed_date::text AS signatory_signed_date_text,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('route_id', p.route_id, 'book_from', p.book_from::text, 'book_to', p.book_to::text, 'note', p.note) ORDER BY p.idx, p.route_id)
              FROM agent_programs p WHERE p.agent_id = a.id), '[]'::jsonb) AS programs
  FROM agents a`;

const storedAgent = (row: QueryResultRow): StoredAgent => ({
  id: String(row.id), code: text(row.code), name: String(row.name),
  market_id: text(row.market_id), sub_market: text(row.sub_market), sales_id: text(row.sales_id), color: text(row.color),
  pay_type: text(row.pay_type) as PayType | null, vat_mode: String(row.vat_mode) as VatMode,
  credit_days: num(row.credit_days), credit_limit: num(row.credit_limit),
  contact: text(row.contact), email: text(row.email), phone: text(row.phone), note: text(row.note),
  rate_type_id: text(row.rate_type_id), contract_template_id: text(row.contract_template_id),
  contract_status: text(row.contract_status), contract_version: text(row.contract_version),
  contract_start: text(row.contract_start_text), contract_end: text(row.contract_end_text),
  legal_name: text(row.legal_name), tax_id: text(row.tax_id), tat_license: text(row.tat_license), address: text(row.address),
  company_tel: text(row.company_tel), hotline: text(row.hotline), fax: text(row.fax), website: text(row.website),
  signatory_name: text(row.signatory_name), signatory_designation: text(row.signatory_designation), signatory_tel: text(row.signatory_tel),
  signatory_signed_date: text(row.signatory_signed_date_text),
  booking_method: text(row.booking_method), booking_cutoff: text(row.booking_cutoff), booking_cancel_policy: text(row.booking_cancel_policy),
  booking_email: text(row.booking_email), booking_phone: text(row.booking_phone),
  house: row.house === true, active: row.active === true, created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
  programs: (row.programs as Record<string, unknown>[]).map((program) => ({
    route_id: String(program.route_id), book_from: text(program.book_from), book_to: text(program.book_to), note: text(program.note),
  })),
});

/** Groups rows under a route-and-date key, so assembling a range is a lookup per cell rather than a scan. */
const byDay = <T extends QueryResultRow>(rows: T[]): Map<string, T[]> => {
  const days = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.route_id} ${row.service_date}`;
    const bucket = days.get(key);
    if (bucket) bucket.push(row); else days.set(key, [row]);
  }
  return days;
};

/** PostgreSQL repository. Advisory transaction locks serialize one route/day capacity pool across all API instances. */
export class PostgresOperationsStore {
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<PoolClient>();
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }
  private client(): Pool | PoolClient { return this.context.getStore() ?? this.pool; }
  async close(): Promise<void> { await this.pool.end(); }

  /**
   * A serializable unit of work, retried when the database asks us to.
   *
   * Capacity is read from `booking_trips` and written to the same table, so two transactions that
   * never touch the same route or day can still be flagged as a read/write dependency: predicate
   * locks are taken by page, and a small table is a single page. PostgreSQL's answer to `40001` is
   * literally "the transaction might succeed if retried", and a SERIALIZABLE store without a retry
   * loop is incomplete — it turns a contended write into a 500 for the caller.
   *
   * Retrying is safe because a rolled-back attempt leaves nothing behind and every handler re-reads
   * what it needs. Deadlocks (`40P01`) are retried on the same grounds.
   */
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return await work();
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await this.context.run(client, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt >= TRANSACTION_ATTEMPTS || !isRetryable(error)) throw error;
      } finally { client.release(); }
      // Contended pools are already serialized by the advisory lock, so a jittered pause is enough to
      // let the winner commit rather than have both sides collide again immediately. It doubles each
      // time: a write now also touches its history and action records, which every booking read
      // scans, so several writers can keep colliding for longer than a fixed step outlasts.
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 5 * (1 + Math.random())));
    }
  }
  private async lockPool(routeId: string, date: string): Promise<void> { await this.client().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${routeId}:${date}`]); }

  /** One route's day, with per-boat and per-lock detail. The rules are `dayCapacity`'s; this only gathers rows. */
  async day(routeId: string, serviceDate: string, exclude: Exclusion = {}): Promise<DayState> {
    return (await this.dayRange([routeId], serviceDate, serviceDate, exclude))[0];
  }

  async capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Promise<Capacity> {
    return capacityNumbers(await this.day(routeId, serviceDate, exclude));
  }

  /**
   * `day` for every route in `routeIds` on every date in `from..to`: date first, then routes in the
   * order given. Three queries whatever the width of the range; a day with nothing on it still gets
   * an all-zero entry.
   */
  async dayRange(routeIds: readonly string[], from: string, to: string, exclude: Exclusion = {}): Promise<RouteDay[]> {
    // `id IS DISTINCT FROM NULL` is true for every row, so an absent exclusion needs no query variant.
    // The list of statuses that release their seats is passed in rather than written here, and it is
    // a denylist: `booking-status.ts` owns that rule and its direction.
    // Nothing is decided in SQL. The licence clamp, which boats a charter takes and what a lock still
    // holds are all `dayCapacity`'s; writing any of them a second time here is how the stores drift.
    const ids = [...routeIds];
    const releasing = [...SEAT_RELEASING_STATUSES];
    const { rows: deployed } = await this.client().query(
      `SELECT d.route_id, d.service_date::text AS service_date, d.boat_id, d.capacity, d.license_pax, o.capacity AS override_capacity
       FROM deployments d
       LEFT JOIN boat_capacity_overrides o ON o.boat_id = d.boat_id AND o.service_date = d.service_date
       WHERE d.route_id = ANY($1::text[]) AND d.service_date BETWEEN $2 AND $3`, [ids, from, to]);
    const { rows: trips } = await this.client().query(
      `SELECT t.route_id, t.service_date::text AS service_date, t.booking_mode, t.charter_boat_id, SUM(p.count)::int AS pax
       FROM booking_trips t
       JOIN bookings b ON b.id = t.booking_id
       JOIN booking_trip_pax p ON p.booking_trip_id = t.id
       WHERE t.route_id = ANY($1::text[]) AND t.service_date BETWEEN $2 AND $3 AND b.status <> ALL($5::text[]) AND NOT ${WAITING_FOR_SEATS}
         AND t.booking_id IS DISTINCT FROM $4
       GROUP BY t.route_id, t.service_date, t.booking_mode, t.charter_boat_id`, [ids, from, to, exclude.bookingId ?? null, releasing]);
    const { rows: locks } = await this.client().query(
      `SELECT l.id, l.route_id, l.service_date::text AS service_date, l.pax,
              COALESCE((SELECT SUM(d.qty) FROM booking_trip_lock_draws d
                        JOIN booking_trips t ON t.id = d.booking_trip_id
                        JOIN bookings b ON b.id = t.booking_id
                        WHERE d.seat_lock_id = l.id AND b.status <> ALL($5::text[]) AND NOT ${WAITING_FOR_SEATS} AND t.booking_id IS DISTINCT FROM $4), 0)::int AS drawn
       FROM seat_locks l
       WHERE l.route_id = ANY($1::text[]) AND l.service_date BETWEEN $2 AND $3 AND l.status = 'active' AND l.id IS DISTINCT FROM $6`,
      [ids, from, to, exclude.bookingId ?? null, releasing, exclude.lockId ?? null]);
    const { rows: kinds } = await this.client().query('SELECT id, kind FROM routes WHERE id = ANY($1::text[])', [ids]);
    const kindOf = new Map(kinds.map((row) => [String(row.id), row.kind as RouteKind]));

    const deployedByDay = byDay(deployed), tripsByDay = byDay(trips), locksByDay = byDay(locks);
    const days: RouteDay[] = [];
    for (const date of eachDate(from, to)) {
      for (const routeId of ids) {
        const key = `${routeId} ${date}`;
        days.push({
          route_id: routeId, service_date: date,
          ...dayCapacity(
            (deployedByDay.get(key) ?? []).map((row): DayDeployment => ({ boat_id: String(row.boat_id), capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), override_capacity: optionalInt(row.override_capacity) })),
            (tripsByDay.get(key) ?? []).map((row): HeldTrip => ({ booking_mode: String(row.booking_mode), pax: Number(row.pax), charter_boat_id: row.charter_boat_id ?? undefined })),
            (locksByDay.get(key) ?? []).map((row): HeldLock => ({ id: String(row.id), pax: Number(row.pax), drawn: Number(row.drawn) })),
            kindOf.get(routeId)),
        });
      }
    }
    return days;
  }

  /**
   * Weighs every day a booking touches, so a multi-day booking is refused as a whole or not at all.
   *
   * Pools are locked before any is read, and in a fixed order: two concurrent bookings covering the
   * same days in opposite order would otherwise each hold what the other is waiting for. `vacating`
   * adds the days an amendment is leaving, which must be held too or a competitor can take the seats
   * between the check and the write. A lock lives on one route and day, so the pool lock also
   * serializes every draw on it.
   */
  private async assertTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, vacating: readonly { route_id: string; service_date: string }[] = []): Promise<void> {
    const days = demandByDay(trips);
    const pools = new Map<string, { route_id: string; service_date: string }>();
    for (const day of [...days, ...vacating]) pools.set(`${day.route_id} ${day.service_date}`, { route_id: day.route_id, service_date: day.service_date });
    for (const key of [...pools.keys()].sort()) { const pool = pools.get(key)!; await this.lockPool(pool.route_id, pool.service_date); }
    for (const demand of days) assertDayFits(await this.day(demand.route_id, demand.service_date, exclude), demand);
  }

  async createDeployment(input: Deployment): Promise<Deployment> {
    // The licence is resolved from the catalogue on write, so the seat pool never has to reach for
    // it at read time and a deployment row always carries its own ceiling.
    const { rows: [row] } = await this.client().query(`INSERT INTO deployments (boat_id, route_id, service_date, capacity, license_pax, registered_persons)
      VALUES ($1,$2,$3,$4, COALESCE($5, (SELECT license_pax FROM boats WHERE id = $1)), $6)
      ON CONFLICT (service_date, boat_id) DO UPDATE SET route_id = EXCLUDED.route_id, capacity = EXCLUDED.capacity, license_pax = EXCLUDED.license_pax, registered_persons = EXCLUDED.registered_persons
      RETURNING boat_id, route_id, service_date::text, capacity, license_pax, registered_persons`,
      [input.boat_id, input.route_id, input.service_date, input.capacity, input.license_pax ?? null, input.registered_persons ?? input.capacity]);
    return { boat_id: String(row.boat_id), route_id: String(row.route_id), service_date: String(row.service_date), capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), registered_persons: optionalInt(row.registered_persons) };
  }
  async deleteDeployment(date: string, boat: string): Promise<boolean> { return (await this.client().query('DELETE FROM deployments WHERE service_date = $1 AND boat_id = $2', [date, boat])).rowCount === 1; }
  async listDeployments(from?: string, to?: string, routeId?: string): Promise<Deployment[]> {
    const { rows } = await this.client().query('SELECT boat_id, route_id, service_date::text, capacity, license_pax, registered_persons FROM deployments WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) AND ($3::text IS NULL OR route_id = $3) ORDER BY service_date, boat_id', [from ?? null, to ?? null, routeId ?? null]);
    return rows.map((row) => ({ ...row, capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), registered_persons: optionalInt(row.registered_persons) }));
  }

  /**
   * Moves the stored itinerary from `current` to `planned` (see `planTrips`) without deleting any
   * trip that is kept. A kept trip's row is updated in place, because rows in other tables hang off
   * its id and a delete would cascade through them. Only its pax cells and lock draws — which belong
   * to the trip and have no identity of their own — are rewritten. A kept trip that moved to another
   * route or day loses its van data, which was arranged for the old departure (`movedTripIds`).
   */
  private async writeTrips(bookingId: string, current: readonly StoredTrip[], planned: readonly StoredTrip[]): Promise<void> {
    const keep = new Set(planned.map((trip) => trip.id));
    const removed = current.filter((trip) => !keep.has(trip.id)).map((trip) => trip.id);
    if (removed.length > 0) await this.client().query('DELETE FROM booking_trips WHERE booking_id = $1 AND id = ANY($2::text[])', [bookingId, removed]);
    const moved = movedTripIds(current, planned);
    if (moved.length > 0) {
      await this.client().query('DELETE FROM booking_trip_van_allocations WHERE booking_trip_id = ANY($1::text[])', [moved]);
      await this.client().query('DELETE FROM booking_trip_operations WHERE booking_trip_id = ANY($1::text[])', [moved]);
    }
    const existing = new Set(current.map((trip) => trip.id).filter((id) => keep.has(id)));
    // `UNIQUE (booking_id, seq)` is checked row by row, so reordering in place would collide halfway
    // through a swap. The kept rows are first moved above every position the new list uses.
    if (existing.size > 0) {
      const clear = Math.max(planned.length, ...current.map((trip) => trip.seq + 1));
      await this.client().query('UPDATE booking_trips SET seq = seq + $2 WHERE booking_id = $1', [bookingId, clear]);
    }
    for (const trip of planned) {
      const values = [trip.id, bookingId, trip.seq, trip.route_id, trip.service_date, trip.booking_mode, trip.charter_boat_id ?? null,
        trip.zone ?? null, trip.pickup_time ?? null, trip.ovn ?? null, trip.ovn_return_date ?? null, trip.ovn_leg, trip.ovn_of ?? null,
        trip.pickup_time_end ?? null, trip.pickup_at_pier === true];
      if (existing.has(trip.id)) {
        await this.client().query(`UPDATE booking_trips SET seq = $3, route_id = $4, service_date = $5, booking_mode = $6, charter_boat_id = $7,
          zone = $8, pickup_time = $9, ovn = $10, ovn_return_date = $11, ovn_leg = $12, ovn_of = $13, pickup_time_end = $14, pickup_at_pier = $15
          WHERE id = $1 AND booking_id = $2`, values);
        await this.client().query('DELETE FROM booking_trip_pax WHERE booking_trip_id = $1', [trip.id]);
        await this.client().query('DELETE FROM booking_trip_lock_draws WHERE booking_trip_id = $1', [trip.id]);
      } else {
        await this.client().query(`INSERT INTO booking_trips (id, booking_id, seq, route_id, service_date, booking_mode, charter_boat_id, zone, pickup_time, ovn, ovn_return_date, ovn_leg, ovn_of,
          pickup_time_end, pickup_at_pier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, values);
      }
      for (const cell of trip.pax) {
        await this.client().query('INSERT INTO booking_trip_pax (booking_trip_id, category, residency, count) VALUES ($1,$2,$3,$4)', [trip.id, cell.category, cell.residency, cell.count]);
      }
      for (const draw of trip.lock_draws) {
        await this.client().query('INSERT INTO booking_trip_lock_draws (booking_trip_id, seat_lock_id, qty) VALUES ($1,$2,$3)', [trip.id, draw.lock_id, draw.qty]);
      }
    }
  }

  private async writePassengers(bookingId: string, passengers: readonly BookingPassengerInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_passengers WHERE booking_id = $1', [bookingId]);
    for (const [seq, passenger] of passengers.entries()) {
      await this.client().query('INSERT INTO booking_passengers (booking_id, seq, name, nationality, type, foc) VALUES ($1,$2,$3,$4,$5,$6)',
        [bookingId, seq, passenger.name, passenger.nationality ?? null, passenger.type ?? null, passenger.foc ?? null]);
    }
  }

  /** Replaces the whole list, the same delete-and-insert `writePassengers` does. */
  private async writeAddOns(bookingId: string, addOns: readonly BookingAddOnInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_addons WHERE booking_id = $1', [bookingId]);
    for (const [seq, addOn] of addOns.entries()) {
      await this.client().query(
        'INSERT INTO booking_addons (booking_id, seq, type, label, amount, qty, note, join_adults, join_children) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [bookingId, seq, addOn.type, addOn.label ?? null, addOn.amount ?? null, addOn.qty ?? null, addOn.note ?? null, addOn.join_adults ?? null, addOn.join_children ?? null]);
    }
  }

  /** Answers 400 before `booking_trips_route_fk` or the lock draw's foreign key can answer 500. */
  /**
   * `assertTrips`, but over the allotment is an answer rather than a refusal: the days the trips put
   * over it (`weighDay`). The same pool locks, in the same order, so the answer cannot go stale before
   * the write.
   */
  private async weighTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, vacating: readonly { route_id: string; service_date: string }[] = []): Promise<ApprovalDay[]> {
    const days = demandByDay(trips);
    const pools = new Map<string, { route_id: string; service_date: string }>();
    for (const day of [...days, ...vacating]) pools.set(`${day.route_id} ${day.service_date}`, { route_id: day.route_id, service_date: day.service_date });
    for (const key of [...pools.keys()].sort()) { const pool = pools.get(key)!; await this.lockPool(pool.route_id, pool.service_date); }
    const over: ApprovalDay[] = [];
    for (const demand of days) {
      const weight = weighDay(await this.day(demand.route_id, demand.service_date, exclude), demand);
      if (weight) over.push({ route_id: demand.route_id, service_date: demand.service_date, ...weight });
    }
    return over;
  }

  /** One approval waits per kind: a new request replaces a pending one of its kind. */
  private async requestApprovals(bookingId: string, requests: readonly NewApproval[]): Promise<void> {
    for (const request of requests) {
      await this.replacePending(bookingId, request.kind);
      const { rows: [row] } = await this.client().query(
        `INSERT INTO booking_approvals (booking_id, kind, status, over_capacity, over_total, discount, foc_count, target_status, requested_by)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [bookingId, request.kind, request.over_capacity, request.over_total, request.discount, request.foc_count, request.target_status, request.requested_by]);
      for (const day of request.days) {
        await this.client().query('INSERT INTO booking_approval_days (approval_id, route_id, service_date, need, over_by) VALUES ($1,$2,$3,$4,$5)',
          [row.id, day.route_id, day.service_date, day.need, day.over_by]);
      }
    }
  }
  private async replacePending(bookingId: string, kind: ApprovalKind): Promise<void> {
    await this.client().query("UPDATE booking_approvals SET status = 'replaced' WHERE booking_id = $1 AND kind = $2 AND status = 'pending'", [bookingId, kind]);
  }

  /** `assertRoutesOpen` against the calendar of the routes and days in question, read alone. */
  private async assertOpen(trips: readonly RouteDate[]): Promise<void> {
    if (trips.length === 0) return;
    const ids = [...new Set(trips.map((trip) => trip.route_id))];
    const dates = [...new Set(trips.map((trip) => trip.service_date))];
    const { rows: seasons } = await this.client().query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons WHERE route_id = ANY($1::text[])', [ids]);
    const { rows: overrides } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE route_id = ANY($1::text[]) AND service_date = ANY($2::date[])', [ids, dates]);
    const { rows: names } = await this.client().query('SELECT id, name FROM routes WHERE id = ANY($1::text[])', [ids]);
    assertRoutesOpen(
      routeCalendar(seasons.map(season), overrides.map(dayOverride)),
      trips, new Map(names.map((row) => [String(row.id), String(row.name)])));
  }

  private async assertRoutes(trips: readonly BookingTripInput[]): Promise<void> {
    const ids = [...new Set(trips.map((trip) => trip.route_id))];
    const { rows } = await this.client().query('SELECT id FROM routes WHERE id = ANY($1::text[])', [ids]);
    assertKnownRoutes(new Set(rows.map((row) => String(row.id))), trips);
    const { rows: locks } = await this.client().query('SELECT id FROM seat_locks WHERE id = ANY($1::text[])', [drawnLockIds(trips)]);
    assertKnownLocks(new Set(locks.map((row) => String(row.id))), trips);
  }

  /** Appends one history line inside the transaction of the write it describes. */
  private async log(bookingId: string, entry: HistoryLine): Promise<void> {
    await this.client().query('INSERT INTO booking_history (booking_id, by, kind, tag, text) VALUES ($1,$2,$3,$4,$5)', [bookingId, entry.by, entry.kind, entry.tag, entry.text]);
  }
  /** Oldest first; the serial id orders lines written in one transaction, which share `now()`. */
  async bookingHistory(id: string): Promise<HistoryEntry[] | undefined> {
    const { rows: [known] } = await this.client().query('SELECT 1 FROM bookings WHERE id = $1', [id]);
    if (!known) return undefined;
    const { rows } = await this.client().query('SELECT at, by, kind, tag, text FROM booking_history WHERE booking_id = $1 ORDER BY at, id', [id]);
    return rows.map((row) => ({ at: asIso(row.at), by: textOrNull(row.by), kind: String(row.kind), tag: textOrNull(row.tag), text: String(row.text) }));
  }
  /** Every action's write is signed by the token's user; without one (auth off) the column is left alone. */
  private async touch(id: string, actor: string | undefined, extra = '', values: unknown[] = []): Promise<void> {
    await this.client().query(`UPDATE bookings SET updated_at = now(), updated_by = COALESCE($2, updated_by)${extra} WHERE id = $1`, [id, actor ?? null, ...values]);
  }

  async createBooking(input: BookingInput, actor?: string): Promise<Booking> {
    if (input.external_id !== undefined) {
      const { rows: [taken] } = await this.client().query('SELECT id FROM bookings WHERE external_id = $1', [input.external_id]);
      if (taken) externalIdTaken(input.external_id, String(taken.id));
    }
    const planned = planTrips([], input.trips, newTripId);
    await this.assertRoutes(input.trips);
    await this.assertOpen(tripsToCheckOpen(input.external_id, [], planned));
    // Weighed first, then decided: the days over the allotment are a fact the status depends on.
    const decision = decideStatus(input.intent ?? 'confirm', {
      focCount: focCountOf(input.trips), focReason: input.header?.foc_reason, discount: discountOf(input.header ?? {}),
      overDays: await this.weighTrips(input.trips),
    }, actor);
    const status = decision.status;
    const head: BookingHeader = { ...input.header, ...(status === 'confirmed' ? confirmationStamp(actor, new Date().toISOString()) : {}) };
    const id = `booking_${randomUUID()}`;
    // Only the header columns the caller actually supplied are written, so a NULL keeps meaning
    // "never given" rather than "explicitly blanked". The column list is generated rather than
    // typed out: a statement maintained by hand is one that silently stops writing a new field.
    const columns = ['id', 'status', 'external_id', 'agent_id', 'voucher_ref', 'rate_type_ref', 'booking_mode'];
    const values: unknown[] = [id, status, input.external_id ?? null, input.agent_id ?? null, input.voucher_ref ?? null, input.rate_type_ref ?? null, input.trips[0]?.booking_mode ?? null];
    for (const column of BOOKING_HEADER_COLUMNS) {
      const value = head[column];
      if (value === undefined) continue;
      columns.push(column);
      values.push(value);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`);
    // The blob is still written beside the columns: this is the dual-write step, not the drop.
    columns.push('booking_data');
    values.push(JSON.stringify(input.booking_data ?? {}));
    placeholders.push(`$${values.length}::jsonb`);
    try {
      await this.client().query(`INSERT INTO bookings (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
    } catch (error) {
      // A concurrent create with the same external_id committed after the check above.
      const e = error as Error & { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'bookings_external_id_unique') externalIdTaken(input.external_id!);
      throw error;
    }
    await this.writeTrips(id, [], planned);
    await this.writePassengers(id, input.passengers ?? []);
    await this.writeAddOns(id, input.add_ons ?? []);
    await this.requestApprovals(id, decision.approvals);
    await this.log(id, createdLine(actor));
    for (const line of decision.history) await this.log(id, line);
    return (await this.booking(id))!;
  }

  async listBookings(query: BookingListQuery) {
    const cursor = query.cursor ? decodeBookingCursor(query.cursor) : undefined;
    // The direction is one of two fixed strings, never caller text, so it is safe to splice in.
    const [after, order] = query.order === 'desc' ? ['<', 'DESC'] : ['>', 'ASC'];
    // One WHERE for the page and the count, so `total` counts exactly what paging walks through.
    // `q` and `voucherRef` arrive lower-cased; `position` is a plain substring test, so a `%` or `_`
    // in the search text means itself, as it does to the in-process store's `includes`.
    const filters = `EXISTS (SELECT 1 FROM booking_trips t
        WHERE t.booking_id = b.id
          AND ($1::text IS NULL OR t.route_id = $1)
          AND ($2::date IS NULL OR t.service_date = $2)
          AND ($3::date IS NULL OR t.service_date >= $3)
          AND ($4::date IS NULL OR t.service_date <= $4))
        AND ($5::text IS NULL OR b.agent_id = $5)
        AND ($6::text[] IS NULL OR b.status = ANY($6))
        AND ($7::text IS NULL OR lower(b.voucher_ref) = $7)
        AND ($8::text IS NULL OR position($8 IN lower(b.id)) > 0 OR position($8 IN lower(COALESCE(b.voucher_ref, ''))) > 0 OR position($8 IN lower(COALESCE(b.lead_pax, ''))) > 0)`;
    const params = [query.routeId ?? null, query.serviceDate ?? null, query.from ?? null, query.to ?? null, query.agentId ?? null, query.statuses ?? null, query.voucherRef ?? null, query.q ?? null];
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      this.client().query(`${BOOKING_SELECT}
      WHERE ${filters}
        AND ($9::timestamptz IS NULL OR (b.created_at, b.id) ${after} ($9::timestamptz, $10::text))
      ORDER BY b.created_at ${order}, b.id ${order}
      LIMIT $11`, [...params, cursor?.created_at ?? null, cursor?.id ?? null, query.limit + 1]),
      this.client().query(`SELECT count(*)::int AS total FROM bookings b WHERE ${filters}`, params),
    ]);
    const page = rows.slice(0, query.limit);
    return { bookings: page.map(booking), ...(rows.length > query.limit ? { next_cursor: encodeBookingCursor({ created_at: asIso(page[page.length - 1].created_at), id: String(page[page.length - 1].id) }) } : {}), total: Number(total) };
  }
  async booking(id: string): Promise<Booking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && booking(row); }
  private async storedBooking(id: string): Promise<StoredBooking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && stored(row); }

  /** `entry` replaces the default `Edited · …` line, for the older reschedule body that comes through here. */
  async amendBooking(id: string, requested: BookingChanges, actor?: string, entry?: HistoryLine): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    assertEditable(current.status);
    const changes = stripServerOwned(requested, current as unknown as Record<string, unknown> & { status: Booking['status'] });
    const replacement = nextTrips(current.trips, changes);
    const planned = planTrips(current.trips, replacement, newTripId);
    await this.assertRoutes(replacement);
    await this.assertOpen(tripsToCheckOpen(current.external_id, current.trips, planned));
    const reweighed = reweighs(current, changes, claimsMoreSeats(current.trips, planned))
      ? reweigh(current, await this.weighTrips(replacement, { bookingId: id }, current.trips), actor) : undefined;
    const status = reweighed?.status ?? current.status;
    await this.log(id, entry ?? editedLine(actor, changes, current.status));
    await this.writeTrips(id, current.trips, planned);
    // Only the columns the amendment mentions are in the SET list, so an unmentioned one keeps its
    // value; a mentioned one carrying null is set to NULL. Built from BOOKING_HEADER_COLUMNS for
    // the same reason the INSERT is — a statement typed out by hand stops writing new fields.
    const assignments = ['booking_mode = $2', 'status = $3', 'updated_at = now()'];
    const values: unknown[] = [id, replacement[0]?.booking_mode ?? null, status];
    if (status === 'confirmed' && reweighed && !current.confirmed_at) { values.push(actor ?? null); assignments.push(`confirmed_at = now(), confirmed_by = ${values.length}`); }
    for (const column of BOOKING_HEADER_COLUMNS) {
      const value = changes.header?.[column];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    await this.client().query(`UPDATE bookings SET ${assignments.join(', ')} WHERE id = $1`, values);
    // `booking_data` is deliberately left as it was written at create time. The blob is on its way
    // out, and re-serialising an amendment into it would grow the thing being deleted.
    if (changes.passengers) await this.writePassengers(id, changes.passengers);
    if (changes.add_ons) await this.writeAddOns(id, changes.add_ons);
    if (reweighed?.request) await this.requestApprovals(id, [reweighed.request]);
    else if (reweighed) await this.replacePending(id, 'approval');
    for (const line of reweighed?.history ?? []) await this.log(id, line);
    return this.booking(id);
  }

  async cancelBooking(id: string, request: CancelRequest, actor?: string): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    const plan = planCancel(current, request, actor);
    await this.touch(id, actor, ", status = 'cancelled', cancellation_reason = $3", [plan.cancellation_reason]);
    if (plan.record) {
      const r = plan.record;
      await this.client().query(`INSERT INTO booking_cancellations (booking_id, category, grp, note, charge_type, charge_amount, by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (booking_id) DO UPDATE SET category = EXCLUDED.category, grp = EXCLUDED.grp, note = EXCLUDED.note, charge_type = EXCLUDED.charge_type,
          charge_amount = EXCLUDED.charge_amount, at = now(), by = EXCLUDED.by`, [id, r.category, r.group, r.note, r.charge_type, r.charge_amount, r.by]);
    } else {
      await this.client().query('DELETE FROM booking_cancellations WHERE booking_id = $1', [id]);
    }
    await this.log(id, plan.history);
    return this.booking(id);
  }

  /**
   * `/confirm`, `/approve`, `/reject`, `/cancel-weather`. The rules are `planStatusCommand`'s. Approving
   * an over-allotment booking gives it seats even past the licence, with warnings (`licenceWarnings`).
   */
  async changeBookingStatus(
    id: string, command: StatusCommand, request: StatusCommandRequest, actor?: string,
  ): Promise<{ booking: Booking; warnings: ApprovalWarning[] } | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    const plan = planStatusCommand(command, current, request, actor);
    let warnings: ApprovalWarning[] = [];
    if (plan.claims) {
      const days = new Map<string, DayState>();
      for (const trip of current.trips) {
        const key = dayKey(trip.route_id, trip.service_date);
        if (!days.has(key)) days.set(key, await this.day(trip.route_id, trip.service_date, { bookingId: id }));
      }
      warnings = licenceWarnings(current.trips, (routeId, date) => days.get(dayKey(routeId, date))!);
    }
    if (plan.decide) {
      const { rowCount } = await this.client().query(
        "UPDATE booking_approvals SET status = $3, decided_by = $4, decided_at = now(), note = $5 WHERE booking_id = $1 AND kind = $2 AND status = 'pending'",
        [id, plan.decide.kind, plan.decide.status, actor ?? null, plan.decide.note]);
      if (rowCount === 0) {
        const record = decidedRecord(plan.decide.kind, plan.decide.status, plan.status, focCountOf(current.trips), actor, '', plan.decide.note);
        await this.client().query(
          `INSERT INTO booking_approvals (booking_id, kind, status, over_capacity, foc_count, target_status, decided_by, decided_at, note)
           VALUES ($1,$2,$3,false,$4,$5,$6,now(),$7)`,
          [id, record.kind, record.status, record.foc_count, record.target_status, record.decided_by, record.note]);
      }
    }
    await this.requestApprovals(id, plan.request);
    // `touch` binds $1 (id) and $2 (actor); these extra assignments follow from $3.
    const values: unknown[] = [plan.status];
    const sets = [', status = $3'];
    if (plan.confirms) { values.push(actor ?? null); sets.push(`, confirmed_at = now(), confirmed_by = $${values.length + 2}`); }
    if (plan.cancellation_reason !== undefined) { values.push(plan.cancellation_reason); sets.push(`, cancellation_reason = $${values.length + 2}`); }
    await this.touch(id, actor, sets.join(''), values);
    for (const line of plan.history) await this.log(id, line);
    return { booking: (await this.booking(id))!, warnings };
  }

  /**
   * Back to `confirmed`, lock seats redrawn as far as the locks allow (`restoreTrips`). The pools are
   * locked before the days are read, so the lock remainders it decides on cannot move underneath it.
   */
  async restoreBooking(id: string, actor?: string): Promise<{ booking: Booking; warnings: LockShortWarning[] } | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    assertRestorable(current.status);
    const days = new Map<string, DayState>();
    const pools = [...new Map(current.trips.map((trip) => [dayKey(trip.route_id, trip.service_date), trip])).entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [key, trip] of pools) {
      await this.lockPool(trip.route_id, trip.service_date);
      days.set(key, await this.day(trip.route_id, trip.service_date, { bookingId: id }));
    }
    const { trips, warnings } = restoreTrips(current.trips, days);
    await this.assertOpen(current.trips);
    await this.assertTrips(trips, { bookingId: id });
    await this.writeTrips(id, current.trips, planTrips(current.trips, trips, newTripId));
    await this.touch(id, actor, ", status = 'confirmed', cancellation_reason = NULL");
    await this.client().query('DELETE FROM booking_cancellations WHERE booking_id = $1', [id]);
    await this.log(id, restoredLine(actor, warnings));
    return { booking: (await this.booking(id))!, warnings };
  }

  async partialCancel(id: string, request: PartialCancelRequest, actor?: string): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    if (request.kind === 'count') {
      await this.writeTrips(id, current.trips, planTrips(current.trips, partialCancelTrips(current.trips, current.status, request.count), newTripId));
      await this.touch(id, actor);
      await this.log(id, partialCountLine(actor, request.count));
      return this.booking(id);
    }
    assertOpen(current.status, 'partial cancel');
    // Seats only go down here, so there is no capacity check — see `claimsMoreSeats`.
    const { trips, trip, count } = partialCancelByKey(current.trips, request);
    const record = partialCancelRecord(trip, request, count, actor);
    await this.writeTrips(id, current.trips, planTrips(current.trips, trips, newTripId));
    await this.touch(id, actor, ', total = $3', [totalAfterRefund(current.total, request.waived) ?? null]);
    await this.client().query(`INSERT INTO booking_partial_cancels (booking_id, booking_trip_id, service_date, pax_removed, count, category, grp, note,
        charged_count, charged_amount, waived_count, waived_amount, by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, record.trip_id, record.service_date, JSON.stringify(record.pax_removed), record.count, record.category, record.group, record.note,
        record.charged.count, record.charged.amount, record.waived.count, record.waived.amount, record.by]);
    await this.log(id, partialCancelLine(actor, record));
    return this.booking(id);
  }

  async rescheduleBooking(id: string, request: RescheduleRequest, actor?: string): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    if (request.kind === 'move') {
      const from = current.trips[0]?.service_date ?? '';
      return this.amendBooking(id, { route_id: request.route_id, service_date: request.service_date, ...(request.pax === undefined ? {} : { pax: request.pax }) }, actor, movedLine(actor, from, request.service_date));
    }
    assertOpen(current.status, 'reschedule');
    const { trips, locksReturned } = rescheduleTrips(current.trips, request.from_date, request.to_date);
    const planned = planTrips(current.trips, trips, newTripId);
    await this.assertRoutes(trips);
    await this.assertOpen(tripsToCheckOpen(undefined, current.trips, planned));
    if (claimsMoreSeats(current.trips, planned)) await this.assertTrips(trips, { bookingId: id }, current.trips);
    await this.writeTrips(id, current.trips, planned);
    const plan = planRescheduleRecord(current, request, actor, locksReturned);
    const r = plan.record;
    await this.client().query(`INSERT INTO booking_reschedules (booking_id, from_date, to_date, reason, charge_type, charge_amount, collect, by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, r.from_date, r.to_date, r.reason, r.charge_type, r.charge_amount, r.collect, r.by]);
    if (plan.fee_item) {
      await this.client().query('INSERT INTO booking_fee_items (booking_id, type, label, amount) VALUES ($1,$2,$3,$4)', [id, plan.fee_item.type, plan.fee_item.label, plan.fee_item.amount]);
    }
    await this.touch(id, actor);
    await this.log(id, plan.history);
    return this.booking(id);
  }

  /** Locks with what holding bookings have drawn from each, however many filters are given. */
  private async readLocks(filter: { id?: string; routeId?: string; date?: string }): Promise<SeatLock[]> {
    const { rows } = await this.client().query(`SELECT l.*,
        COALESCE((SELECT SUM(d.qty) FROM booking_trip_lock_draws d
                  JOIN booking_trips t ON t.id = d.booking_trip_id
                  JOIN bookings b ON b.id = t.booking_id
                  WHERE d.seat_lock_id = l.id AND b.status <> ALL($4::text[]) AND NOT ${WAITING_FOR_SEATS}), 0)::int AS drawn_pax
      FROM seat_locks l
      WHERE ($1::text IS NULL OR l.id = $1) AND ($2::text IS NULL OR l.route_id = $2) AND ($3::date IS NULL OR l.service_date = $3)
      ORDER BY l.created_at`, [filter.id ?? null, filter.routeId ?? null, filter.date ?? null, [...SEAT_RELEASING_STATUSES]]);
    return rows.map(lock);
  }
  async createLock(input: LockInput): Promise<SeatLock> {
    await this.assertOpen([input]);
    await this.lockPool(input.route_id, input.service_date);
    assertLockFits(await this.day(input.route_id, input.service_date), input.pax, 0);
    const id = `lock_${randomUUID()}`;
    await this.client().query("INSERT INTO seat_locks (id,route_id,service_date,pax,agent_id,status) VALUES ($1,$2,$3,$4,$5,'active')", [id, input.route_id, input.service_date, input.pax, input.agent_id ?? null]);
    return (await this.readLocks({ id }))[0];
  }
  async listLocks(routeId?: string, date?: string): Promise<SeatLock[]> { return this.readLocks({ routeId, date }); }
  async amendLock(id: string, changes: Partial<Pick<SeatLock, 'pax' | 'agent_id'>>): Promise<SeatLock | undefined> {
    const [current] = await this.readLocks({ id });
    if (!current) return undefined;
    const seats = changes.pax ?? current.pax;
    if (current.status === 'active' && seats !== current.pax) {
      await this.lockPool(current.route_id, current.service_date);
      // Re-read under the pool lock: a draw on this lock takes the same lock, so this count is final.
      const [locked] = await this.readLocks({ id });
      assertLockFits(await this.day(current.route_id, current.service_date, { lockId: id }), seats, locked.drawn_pax ?? 0);
    }
    await this.client().query('UPDATE seat_locks SET pax=$2, agent_id=$3, updated_at=now() WHERE id=$1', [id, seats, changes.agent_id ?? current.agent_id ?? null]);
    return (await this.readLocks({ id }))[0];
  }
  async releaseLock(id: string): Promise<SeatLock | undefined> {
    const { rowCount } = await this.client().query("UPDATE seat_locks SET status='released', released_at=COALESCE(released_at, now()), updated_at=now() WHERE id=$1", [id]);
    return rowCount === 0 ? undefined : (await this.readLocks({ id }))[0];
  }
  async allotment(routeId: string, date: string, exclude: Exclusion = {}): Promise<Capacity & { route_id: string; service_date: string; deployments: Deployment[] }> { return { route_id: routeId, service_date: date, ...(await this.capacity(routeId,date,exclude)), deployments: await this.listDeployments(date,date,routeId) }; }

  /**
   * One edit to a route's calendar: the rules are `applyCalendarChange` and `assertCloseAllowed`, and
   * this gathers the rows and writes the result. The route's row is locked first, so two edits to
   * one route cannot both judge the calendar as it was before the other.
   */
  async changeCalendar(routeId: string, change: CalendarChange, closeAnyway: boolean, today: string): Promise<void> {
    const { rows: [route] } = await this.client().query('SELECT id FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
    if (!route) refuse('Route not found', 404);
    const { rows: seasons } = await this.client().query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons WHERE route_id = $1', [routeId]);
    const { rows: overrides } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE route_id = $1', [routeId]);
    const current = { seasons: seasons.map(season), overrides: overrides.map(dayOverride) };
    const next = applyCalendarChange(current.seasons, current.overrides, change);
    const { rows: trips } = await this.client().query(
      `SELECT DISTINCT t.service_date::text AS service_date, COALESCE(b.voucher_ref, b.id) AS booking_ref
       FROM booking_trips t JOIN bookings b ON b.id = t.booking_id
       WHERE t.route_id = $1 AND t.service_date >= $2 AND b.status <> ALL($3::text[])`, [routeId, today, [...SEAT_RELEASING_STATUSES]]);
    const { rows: boats } = await this.client().query('SELECT service_date::text AS service_date, boat_id FROM deployments WHERE route_id = $1 AND service_date >= $2', [routeId, today]);
    const holds: CalendarHold[] = [
      ...trips.map((row) => ({ service_date: String(row.service_date), booking_ref: String(row.booking_ref) })),
      ...boats.map((row) => ({ service_date: String(row.service_date), boat_id: String(row.boat_id) })),
    ];
    assertCloseAllowed(routeId, routeCalendar(current.seasons, current.overrides), routeCalendar(next.seasons, next.overrides), holds, closeAnyway);
    switch (change.op) {
      case 'add-season': {
        const s = change.season;
        await this.client().query('INSERT INTO route_seasons (id, route_id, kind, from_date, to_date) VALUES ($1,$2,$3,$4,$5)', [s.id, routeId, s.kind, s.from_date, s.to_date]);
        break;
      }
      case 'delete-season': await this.client().query('DELETE FROM route_seasons WHERE id = $1 AND route_id = $2', [change.season_id, routeId]); break;
      case 'set-day':
        await this.client().query(`INSERT INTO route_day_overrides (route_id, service_date, kind) VALUES ($1,$2,$3)
          ON CONFLICT (route_id, service_date) DO UPDATE SET kind = EXCLUDED.kind`, [routeId, change.override.service_date, change.override.kind]);
        break;
      case 'clear-day': await this.client().query('DELETE FROM route_day_overrides WHERE route_id = $1 AND service_date = $2', [routeId, change.service_date]); break;
    }
  }
  newSeasonId(): string { return `season_${randomUUID()}`; }

  /** Reference data. Dates are cast in SQL so the driver never hands back a Date to re-render. */
  async listRoutes(): Promise<Route[]> {
    const { rows } = await this.client().query(`SELECT r.id, r.name, r.kind, r.ext_id, r.pier, r.family_id, r.color, r.islands, r.sort,
      COALESCE((SELECT array_agg(t.departs_at ORDER BY t.idx) FROM route_times t WHERE t.route_id = r.id), '{}') AS times
      FROM routes r ORDER BY r.sort NULLS LAST, r.id`);
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: row.kind, ext_id: row.ext_id ?? undefined, pier: row.pier ?? undefined, family_id: row.family_id ?? undefined, color: row.color ?? undefined, islands: row.islands ?? undefined, sort: row.sort === null ? undefined : Number(row.sort), times: row.times ?? [] }));
  }
  /**
   * The boat catalogue. `license_pax` stays undefined for a boat with no licence on file rather
   * than borrowing `capacity`, so the fallback stays in `charterCeiling` and nothing downstream can
   * mistake a resolved number for a registration the vessel does not hold.
   */
  async listBoats(): Promise<Boat[]> {
    const { rows } = await this.client().query('SELECT id, name, type, pier, capacity, license_pax, crew FROM boats ORDER BY name, id');
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), type: row.type ?? undefined, pier: row.pier ?? undefined,
      capacity: Number(row.capacity), license_pax: row.license_pax === null ? undefined : Number(row.license_pax),
      crew: row.crew === null ? undefined : Number(row.crew),
    }));
  }
  async listSeasons(): Promise<RouteSeason[]> {
    const { rows } = await this.client().query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons ORDER BY route_id, from_date');
    return rows.map(season);
  }
  /**
   * Agents, markets and salespeople. There are about 130 agents, so the list is read whole and handed
   * to `selectAgents`: filtering and sorting in SQL would be a second copy of that rule to keep in step.
   */
  async listMarkets(): Promise<Market[]> {
    const { rows } = await this.client().query(`SELECT m.id, m.name, m.color, m.sort,
      COALESCE((SELECT array_agg(s.name ORDER BY s.idx, s.name) FROM market_subs s WHERE s.market_id = m.id), '{}') AS subs FROM markets m`);
    return sortMarkets(rows.map((row) => ({ id: String(row.id), name: String(row.name), color: text(row.color), sort: num(row.sort), subs: (row.subs as string[]).map(String) })));
  }
  async listSalesPeople(): Promise<SalesPerson[]> {
    const { rows } = await this.client().query('SELECT id, code, name, full_name, designation, email, tel, color, active FROM sales_people');
    return sortSalesPeople(rows.map((row) => ({
      id: String(row.id), code: text(row.code), name: String(row.name), full_name: text(row.full_name), designation: text(row.designation),
      email: text(row.email), tel: text(row.tel), color: text(row.color), active: row.active === true,
    })));
  }
  async listAgents(query: AgentListQuery): Promise<AgentSummary[]> {
    const { rows } = await this.client().query(AGENT_SELECT);
    return selectAgents(rows.map(storedAgent), await this.listMarkets(), await this.listSalesPeople(), query).map(agentSummary);
  }
  async agent(id: string): Promise<Agent | undefined> {
    const { rows: [row] } = await this.client().query(`${AGENT_SELECT} WHERE a.id = $1`, [id]);
    return row && agentView(storedAgent(row));
  }
  /** Undefined for an unknown agent. The serial id orders two entries written at the same instant. */
  async agentActivity(id: string, limit: number): Promise<AgentActivity[] | undefined> {
    const { rows: [known] } = await this.client().query('SELECT 1 FROM agents WHERE id = $1', [id]);
    if (!known) return undefined;
    const { rows } = await this.client().query('SELECT id, at, by, kind, text FROM agent_activity WHERE agent_id = $1', [id]);
    return latestActivity(rows.map((row) => ({ at: asIso(row.at), by: text(row.by), kind: String(row.kind), text: String(row.text), seq: Number(row.id) })), limit);
  }

  // ── Rate types ─────────────────────────────────────────────────────────────────────────────────
  // The rows are read and written here; everything the API says about them is `rate-types.ts`'s.

  /** Every row of the given rate types (all of them when `ids` is undefined), grouped by rate type. */
  private async readRateTypes(ids?: readonly string[]): Promise<RateTypeRows[]> {
    const params = [ids === undefined ? null : [...ids]];
    const where = (column: string) => `WHERE ($1::text[] IS NULL OR ${column} = ANY($1))`;
    const n = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    // One after another, not Promise.all: inside a transaction these share one connection, and `pg`
    // deprecates queuing a query on a client that is still running one (removed in pg@9).
    const select = async (sql: string) => (await this.client().query(sql, params)).rows;
    const rates = await select(`SELECT id, code, name, note, color, owner_sales_id, valid_from::text, valid_to::text, active, nationality_scope, transfer_unit,
      created_on::text, created_at, updated_at FROM rate_types ${where('id')}`);
    const routes = await select(`SELECT rate_type_id, route_id, seq, travel_from::text, travel_to::text, longtail_bundle, longtail_bundle_adult, longtail_bundle_child,
      longtail_bundle_applies_to FROM rate_type_routes ${where('rate_type_id')}`);
    const seat = await select(`SELECT rate_type_id, route_id, zone, category, residency, tier, price FROM rate_type_seat_prices ${where('rate_type_id')}`);
    const charter = await select(`SELECT rate_type_id, route_id, boat_type, starter_price, starter_includes, extra_per_pax FROM rate_type_charter_prices ${where('rate_type_id')}`);
    const longtail = await select(`SELECT rate_type_id, route_id, join_adult, join_child, charter_price, charter_capacity FROM rate_type_longtail_prices ${where('rate_type_id')}`);
    const transfer = await select(`SELECT rate_type_id, route_id, zone, vehicle, price FROM rate_type_transfer_prices ${where('rate_type_id')}`);
    const all = new Map<string, RateTypeRows>();
    for (const r of rates) {
      all.set(String(r.id), {
        rate: {
          id: String(r.id), code: String(r.code), name: String(r.name), note: text(r.note), color: text(r.color), owner_sales_id: text(r.owner_sales_id),
          valid_from: text(r.valid_from), valid_to: text(r.valid_to), active: r.active === true, nationality_scope: text(r.nationality_scope) as NationalityScope | null,
          transfer_unit: text(r.transfer_unit), created_on: text(r.created_on), created_at: asIso(r.created_at), updated_at: asIso(r.updated_at),
        },
        routes: [], seat: [], charter: [], longtail: [], transfer: [],
      });
    }
    const of = (row: QueryResultRow) => all.get(String(row.rate_type_id));
    for (const r of routes) of(r)?.routes.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), seq: Number(r.seq), travel_from: text(r.travel_from), travel_to: text(r.travel_to),
      longtail_bundle: text(r.longtail_bundle) as BundleMode | null, longtail_bundle_adult: n(r.longtail_bundle_adult), longtail_bundle_child: n(r.longtail_bundle_child),
      longtail_bundle_applies_to: text(r.longtail_bundle_applies_to) as BundleAppliesTo | null,
    });
    for (const r of seat) of(r)?.seat.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), zone: String(r.zone), category: r.category as SeatPriceRow['category'],
      residency: r.residency as SeatPriceRow['residency'], tier: r.tier as RateTier, price: Number(r.price),
    });
    for (const r of charter) of(r)?.charter.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), boat_type: String(r.boat_type),
      starter_price: n(r.starter_price), starter_includes: n(r.starter_includes), extra_per_pax: n(r.extra_per_pax),
    });
    for (const r of longtail) of(r)?.longtail.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), join_adult: n(r.join_adult), join_child: n(r.join_child),
      charter_price: n(r.charter_price), charter_capacity: n(r.charter_capacity),
    });
    for (const r of transfer) of(r)?.transfer.push({ rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), zone: String(r.zone), vehicle: String(r.vehicle), price: Number(r.price) });
    return [...all.values()];
  }

  async listRateTypes(query: RateTypeListQuery): Promise<RateTypeSummary[]> { return selectRateTypes(await this.readRateTypes(), query); }
  async rateType(id: string): Promise<RateType | undefined> { const [rows] = await this.readRateTypes([id]); return rows && rateTypeView(rows); }

  /** Answers 400 before a foreign key could answer 500: unknown routes, wrong zones, an owner who is not a salesperson. */
  private async assertRateTypeRefs(blocks: readonly { route_id: string; block: RouteBlock; label: string }[], owner: string | null | undefined): Promise<void> {
    if (blocks.length > 0) {
      const { rows } = await this.client().query('SELECT id, pier FROM routes WHERE id = ANY($1::text[])', [blocks.map((b) => b.route_id)]);
      const catalogue = new Map(rows.map((row) => [String(row.id), { id: String(row.id), pier: row.pier ?? undefined }]));
      for (const { route_id, block, label } of blocks) assertRouteBlock(block, route_id, catalogue, label);
    }
    if (owner !== null && owner !== undefined) {
      const { rows } = await this.client().query('SELECT id FROM sales_people WHERE id = $1', [owner]);
      assertOwner(owner, new Set(rows.map((row) => String(row.id))));
    }
  }

  /** One route's rows: the route, then each price table in one statement however many cells it has. */
  private async insertRouteRows(rows: RouteRows): Promise<void> {
    const r = rows.route;
    await this.client().query(`INSERT INTO rate_type_routes (rate_type_id, route_id, seq, travel_from, travel_to, longtail_bundle, longtail_bundle_adult,
      longtail_bundle_child, longtail_bundle_applies_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [r.rate_type_id, r.route_id, r.seq, r.travel_from, r.travel_to, r.longtail_bundle, r.longtail_bundle_adult, r.longtail_bundle_child, r.longtail_bundle_applies_to]);
    const key = [r.rate_type_id, r.route_id];
    if (rows.seat.length > 0) {
      await this.client().query(`INSERT INTO rate_type_seat_prices (rate_type_id, route_id, zone, category, residency, tier, price)
        SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[])`,
      [...key, rows.seat.map((s) => s.zone), rows.seat.map((s) => s.category), rows.seat.map((s) => s.residency), rows.seat.map((s) => s.tier), rows.seat.map((s) => s.price)]);
    }
    if (rows.charter.length > 0) {
      await this.client().query(`INSERT INTO rate_type_charter_prices (rate_type_id, route_id, boat_type, starter_price, starter_includes, extra_per_pax)
        SELECT $1, $2, * FROM unnest($3::text[], $4::numeric[], $5::int[], $6::numeric[])`,
      [...key, rows.charter.map((c) => c.boat_type), rows.charter.map((c) => c.starter_price), rows.charter.map((c) => c.starter_includes), rows.charter.map((c) => c.extra_per_pax)]);
    }
    for (const l of rows.longtail) {
      await this.client().query('INSERT INTO rate_type_longtail_prices (rate_type_id, route_id, join_adult, join_child, charter_price, charter_capacity) VALUES ($1,$2,$3,$4,$5,$6)',
        [...key, l.join_adult, l.join_child, l.charter_price, l.charter_capacity]);
    }
    if (rows.transfer.length > 0) {
      await this.client().query(`INSERT INTO rate_type_transfer_prices (rate_type_id, route_id, zone, vehicle, price)
        SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::numeric[])`,
      [...key, rows.transfer.map((t) => t.zone), rows.transfer.map((t) => t.vehicle), rows.transfer.map((t) => t.price)]);
    }
  }

  async createRateType(input: RateTypeCreate): Promise<RateType> {
    await this.assertRateTypeRefs(input.routes.map(({ route_id, block }, index) => ({ route_id, block, label: `routes[${index}]` })), input.header.owner);
    if (input.header.id !== undefined && (await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [input.header.id])).rowCount) rateTypeExists('id', input.header.id);
    const codes = new Set((await this.client().query('SELECT code FROM rate_types')).rows.map((row) => String(row.code)));
    if (input.header.code !== undefined && codes.has(input.header.code)) rateTypeExists('code', input.header.code);
    const id = input.header.id ?? `rt_${randomUUID()}`;
    const row = newRateTypeRow(input.header, id, input.header.code ?? generateRateTypeCode(input.header.name, codes), new Date().toISOString());
    try {
      await this.client().query(`INSERT INTO rate_types (id, code, name, note, color, owner_sales_id, valid_from, valid_to, active, nationality_scope, transfer_unit, created_on)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id, row.code, row.name, row.note, row.color, row.owner_sales_id, row.valid_from, row.valid_to, row.active, row.nationality_scope, row.transfer_unit, row.created_on]);
    } catch (error) {
      // Two creates racing for the same id or code: the checks above both passed, the index caught it.
      const e = error as Error & { code?: string; constraint?: string };
      if (e.code === '23505') rateTypeExists(e.constraint === 'rate_types_pkey' ? 'id' : 'code', e.constraint === 'rate_types_pkey' ? row.id : row.code);
      throw error;
    }
    for (const [seq, { route_id, block }] of input.routes.entries()) await this.insertRouteRows(routeRows(id, route_id, seq, block));
    return (await this.rateType(id))!;
  }

  async patchRateType(id: string, patch: RateTypePatch): Promise<RateType | undefined> {
    const [current] = await this.readRateTypes([id]);
    if (!current) return undefined;
    await this.assertRateTypeRefs([], patch.owner);
    const next = patchedRateTypeRow(current.rate, patch, new Date().toISOString());
    await this.client().query(`UPDATE rate_types SET name = $2, note = $3, color = $4, owner_sales_id = $5, valid_from = $6, valid_to = $7, active = $8,
      nationality_scope = $9, transfer_unit = $10, updated_at = now() WHERE id = $1`,
    [id, next.name, next.note, next.color, next.owner_sales_id, next.valid_from, next.valid_to, next.active, next.nationality_scope, next.transfer_unit]);
    return this.rateType(id);
  }

  /** Replaces one route's block; a route new to the rate goes after the ones it has. */
  async putRateTypeRoute(id: string, routeId: string, block: RouteBlock): Promise<RateType | undefined> {
    if (!(await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [id])).rowCount) return undefined;
    await this.assertRateTypeRefs([{ route_id: routeId, block, label: '' }], undefined);
    const { rows } = await this.client().query('SELECT route_id, seq FROM rate_type_routes WHERE rate_type_id = $1', [id]);
    const existing = rows.find((row) => String(row.route_id) === routeId);
    const seq = existing ? Number(existing.seq) : nextRouteSeq(rows.map((row) => ({ seq: Number(row.seq) })));
    // The prices cascade from the route row, so deleting it and writing the block again replaces the lot.
    await this.client().query('DELETE FROM rate_type_routes WHERE rate_type_id = $1 AND route_id = $2', [id, routeId]);
    await this.insertRouteRows(routeRows(id, routeId, seq, block));
    await this.client().query('UPDATE rate_types SET updated_at = now() WHERE id = $1', [id]);
    return this.rateType(id);
  }

  /** Undefined for an unknown rate type, false for a route the rate does not cover. */
  async deleteRateTypeRoute(id: string, routeId: string): Promise<boolean | undefined> {
    if (!(await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [id])).rowCount) return undefined;
    const { rowCount } = await this.client().query('DELETE FROM rate_type_routes WHERE rate_type_id = $1 AND route_id = $2', [id, routeId]);
    if (!rowCount) return false;
    await this.client().query('UPDATE rate_types SET updated_at = now() WHERE id = $1', [id]);
    return true;
  }

  async deleteRateType(id: string): Promise<boolean> {
    if (!(await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [id])).rowCount) return false;
    const { rows: [used] } = await this.client().query(`SELECT (SELECT count(*) FROM agents WHERE rate_type_id = $1)::int AS agents,
      (SELECT count(*) FROM bookings WHERE rate_type_ref = $1)::int AS bookings`, [id]);
    assertRateTypeUnused(id, { agents: Number(used.agents), bookings: Number(used.bookings) });
    await this.client().query('DELETE FROM rate_types WHERE id = $1', [id]);
    return true;
  }

  async listDayOverrides(from?: string, to?: string): Promise<RouteDayOverride[]> {
    const { rows } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) ORDER BY route_id, service_date', [from ?? null, to ?? null]);
    return rows.map(dayOverride);
  }
}
