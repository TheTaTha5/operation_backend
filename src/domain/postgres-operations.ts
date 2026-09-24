import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  assertKnownLocks, assertKnownRoutes, bookingView, claimsSeats, demandByDay, drawnLockIds, nextTrips, partialCancelTrips, tripsChanged,
  type Boat, type Booking, type BookingChanges, type BookingInput, type BookingListQuery, type BookingTripInput, type Deployment, type Exclusion, type LockDraw, type RouteDay, type SeatLock, type StoredBooking,
  decodeBookingCursor, encodeBookingCursor,
} from './operations.js';
import { type PaxCategory, type PaxResidency } from './pax.js';
import { holdsSeats, SEAT_RELEASING_STATUSES } from './booking-status.js';
import { assertDayFits, assertLockFits, capacityNumbers, dayCapacity, type Capacity, type DayDeployment, type DayState, type HeldLock, type HeldTrip } from './capacity.js';
import { eachDate, type Route, type RouteDayOverride, type RouteSeason } from './calendar.js';
import {
  BOOKING_HEADER_COLUMNS, BOOKING_HEADER_DATE_COLUMNS, BOOKING_HEADER_NUMERIC_COLUMNS, BOOKING_HEADER_TIMESTAMP_COLUMNS,
  type BookingHeader,
} from './booking-header.js';
import type { BookingPassenger, BookingPassengerInput } from './booking-passengers.js';

const optionalInt = (value: unknown): number | undefined => value === null || value === undefined ? undefined : Number(value);
type LockInput = Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>;
/** `40001` serialization failure, `40P01` deadlock. Both mean "try again", not "the request was wrong". */
const TRANSACTION_ATTEMPTS = 5;
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
      'pax', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', p.category, 'residency', p.residency, 'count', p.count) ORDER BY p.category, p.residency)
                       FROM booking_trip_pax p WHERE p.booking_trip_id = t.id), '[]'::jsonb),
      'lock_draws', COALESCE((SELECT jsonb_agg(jsonb_build_object('lock_id', d.seat_lock_id, 'qty', d.qty) ORDER BY d.seat_lock_id)
                              FROM booking_trip_lock_draws d WHERE d.booking_trip_id = t.id), '[]'::jsonb)
    ) ORDER BY t.seq)
    FROM booking_trips t WHERE t.booking_id = b.id), '[]'::jsonb) AS trips,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', pg.seq, 'name', pg.name, 'nationality', pg.nationality, 'type', pg.type, 'foc', pg.foc) ORDER BY pg.seq)
    FROM booking_passengers pg WHERE pg.booking_id = b.id), '[]'::jsonb) AS passengers
  FROM bookings b`;

const NUMERIC_HEADER = new Set<string>(BOOKING_HEADER_NUMERIC_COLUMNS);
const TIMESTAMP_HEADER = new Set<string>(BOOKING_HEADER_TIMESTAMP_COLUMNS);
const DATE_HEADER = new Set<string>(BOOKING_HEADER_DATE_COLUMNS);

/** Reads the header columns off a row, converting the three types `pg` does not hand back as-is. */
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
  })),
  passengers: (row.passengers as Record<string, unknown>[]).map((passenger) => ({
    seq: Number(passenger.seq), name: String(passenger.name),
    nationality: passenger.nationality ?? undefined, type: passenger.type ?? undefined,
    foc: passenger.foc ?? undefined,
  })) as BookingPassenger[],
});
const booking = (row: QueryResultRow): Booking => bookingView(stored(row));
const lock = (row: QueryResultRow): SeatLock => ({ id: String(row.id), route_id: String(row.route_id), service_date: dateOnly(row.service_date), pax: Number(row.pax), status: row.status as SeatLock['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at), released_at: row.released_at ? asIso(row.released_at) : undefined, agent_id: row.agent_id ?? undefined, drawn_pax: Number(row.drawn_pax ?? 0) });

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
      // Contended pools are already serialized by the advisory lock, so a short jittered pause is
      // enough to let the winner commit rather than have both sides collide again immediately.
      await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.random() * 10));
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
       WHERE t.route_id = ANY($1::text[]) AND t.service_date BETWEEN $2 AND $3 AND b.status <> ALL($5::text[])
         AND t.booking_id IS DISTINCT FROM $4
       GROUP BY t.route_id, t.service_date, t.booking_mode, t.charter_boat_id`, [ids, from, to, exclude.bookingId ?? null, releasing]);
    const { rows: locks } = await this.client().query(
      `SELECT l.id, l.route_id, l.service_date::text AS service_date, l.pax,
              COALESCE((SELECT SUM(d.qty) FROM booking_trip_lock_draws d
                        JOIN booking_trips t ON t.id = d.booking_trip_id
                        JOIN bookings b ON b.id = t.booking_id
                        WHERE d.seat_lock_id = l.id AND b.status <> ALL($5::text[]) AND t.booking_id IS DISTINCT FROM $4), 0)::int AS drawn
       FROM seat_locks l
       WHERE l.route_id = ANY($1::text[]) AND l.service_date BETWEEN $2 AND $3 AND l.status = 'active' AND l.id IS DISTINCT FROM $6`,
      [ids, from, to, exclude.bookingId ?? null, releasing, exclude.lockId ?? null]);

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
            (locksByDay.get(key) ?? []).map((row): HeldLock => ({ id: String(row.id), pax: Number(row.pax), drawn: Number(row.drawn) }))),
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

  private async writeTrips(bookingId: string, trips: readonly BookingTripInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_trips WHERE booking_id = $1', [bookingId]);
    for (const [seq, trip] of trips.entries()) {
      const id = `trip_${bookingId}_${seq}`;
      const charter = trip.booking_mode === 'charter';
      await this.client().query('INSERT INTO booking_trips (id, booking_id, seq, route_id, service_date, booking_mode, charter_boat_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, bookingId, seq, trip.route_id, trip.service_date, charter ? 'charter' : 'seat', charter ? trip.charter_boat_id ?? null : null]);
      for (const cell of trip.pax) {
        await this.client().query('INSERT INTO booking_trip_pax (booking_trip_id, category, residency, count) VALUES ($1,$2,$3,$4)', [id, cell.category, cell.residency, cell.count]);
      }
      for (const draw of charter ? [] : trip.lock_draws ?? []) {
        await this.client().query('INSERT INTO booking_trip_lock_draws (booking_trip_id, seat_lock_id, qty) VALUES ($1,$2,$3)', [id, draw.lock_id, draw.qty]);
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

  /** Answers 400 before `booking_trips_route_fk` or the lock draw's foreign key can answer 500. */
  private async assertRoutes(trips: readonly BookingTripInput[]): Promise<void> {
    const ids = [...new Set(trips.map((trip) => trip.route_id))];
    const { rows } = await this.client().query('SELECT id FROM routes WHERE id = ANY($1::text[])', [ids]);
    assertKnownRoutes(new Set(rows.map((row) => String(row.id))), trips);
    const { rows: locks } = await this.client().query('SELECT id FROM seat_locks WHERE id = ANY($1::text[])', [drawnLockIds(trips)]);
    assertKnownLocks(new Set(locks.map((row) => String(row.id))), trips);
  }

  async createBooking(input: BookingInput): Promise<Booking> {
    const status = input.status ?? 'confirmed';
    await this.assertRoutes(input.trips);
    // A booking created in a status that releases seats — a rejection being recorded, a cancelled
    // import — reserves nothing, so a full day must not stop it being written down.
    if (holdsSeats(status)) await this.assertTrips(input.trips);
    const id = `booking_${randomUUID()}`;
    // Only the header columns the caller actually supplied are written, so a NULL keeps meaning
    // "never given" rather than "explicitly blanked". The column list is generated rather than
    // typed out: a statement maintained by hand is one that silently stops writing a new field.
    const columns = ['id', 'status', 'external_id', 'agent_id', 'voucher_ref', 'rate_type_ref', 'booking_mode'];
    const values: unknown[] = [id, status, input.external_id ?? null, input.agent_id ?? null, input.voucher_ref ?? null, input.rate_type_ref ?? null, input.trips[0]?.booking_mode ?? null];
    for (const column of BOOKING_HEADER_COLUMNS) {
      const value = input.header?.[column];
      if (value === undefined) continue;
      columns.push(column);
      values.push(value);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`);
    // The blob is still written beside the columns: this is the dual-write step, not the drop.
    columns.push('booking_data');
    values.push(JSON.stringify(input.booking_data ?? {}));
    placeholders.push(`$${values.length}::jsonb`);
    await this.client().query(`INSERT INTO bookings (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
    await this.writeTrips(id, input.trips);
    await this.writePassengers(id, input.passengers ?? []);
    return (await this.booking(id))!;
  }

  async listBookings(query: BookingListQuery) {
    const cursor = query.cursor ? decodeBookingCursor(query.cursor) : undefined;
    const { rows } = await this.client().query(`${BOOKING_SELECT}
      WHERE EXISTS (SELECT 1 FROM booking_trips t
        WHERE t.booking_id = b.id
          AND ($1::text IS NULL OR t.route_id = $1)
          AND ($2::date IS NULL OR t.service_date = $2)
          AND ($3::date IS NULL OR t.service_date >= $3)
          AND ($4::date IS NULL OR t.service_date <= $4))
        AND ($5::timestamptz IS NULL OR (b.created_at, b.id) > ($5::timestamptz, $6::text))
      ORDER BY b.created_at, b.id
      LIMIT $7`, [query.routeId ?? null, query.serviceDate ?? null, query.from ?? null, query.to ?? null, cursor?.created_at ?? null, cursor?.id ?? null, query.limit + 1]);
    const page = rows.slice(0, query.limit);
    return { bookings: page.map(booking), ...(rows.length > query.limit ? { next_cursor: encodeBookingCursor({ created_at: asIso(page[page.length - 1].created_at), id: String(page[page.length - 1].id) }) } : {}) };
  }
  async booking(id: string): Promise<Booking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && booking(row); }
  private async storedBooking(id: string): Promise<StoredBooking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && stored(row); }

  async amendBooking(id: string, changes: BookingChanges): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    const replacement = nextTrips(current.trips, changes);
    const status = changes.status ?? current.status;
    await this.assertRoutes(replacement);
    if (claimsSeats(current.status, status, tripsChanged(current.trips, replacement))) await this.assertTrips(replacement, { bookingId: id }, current.trips);
    await this.writeTrips(id, replacement);
    // Only the columns the amendment mentions are in the SET list, so an unmentioned one keeps its
    // value; a mentioned one carrying null is set to NULL. Built from BOOKING_HEADER_COLUMNS for
    // the same reason the INSERT is — a statement typed out by hand stops writing new fields.
    const assignments = ['booking_mode = $2', 'status = $3', 'updated_at = now()'];
    const values: unknown[] = [id, replacement[0]?.booking_mode ?? null, status];
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
    return this.booking(id);
  }

  async cancelBooking(id: string, reason?: string): Promise<Booking | undefined> {
    const { rowCount } = await this.client().query("UPDATE bookings SET status='cancelled', cancellation_reason=$2, updated_at=now() WHERE id=$1 AND status <> 'cancelled'", [id, reason ?? null]);
    if (rowCount === 0 && !(await this.booking(id))) return undefined;
    return this.booking(id);
  }

  async partialCancel(id: string, count: number): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    await this.writeTrips(id, partialCancelTrips(current.trips, current.status, count));
    await this.client().query('UPDATE bookings SET updated_at=now() WHERE id=$1', [id]);
    return this.booking(id);
  }

  /** Locks with what holding bookings have drawn from each, however many filters are given. */
  private async readLocks(filter: { id?: string; routeId?: string; date?: string }): Promise<SeatLock[]> {
    const { rows } = await this.client().query(`SELECT l.*,
        COALESCE((SELECT SUM(d.qty) FROM booking_trip_lock_draws d
                  JOIN booking_trips t ON t.id = d.booking_trip_id
                  JOIN bookings b ON b.id = t.booking_id
                  WHERE d.seat_lock_id = l.id AND b.status <> ALL($4::text[])), 0)::int AS drawn_pax
      FROM seat_locks l
      WHERE ($1::text IS NULL OR l.id = $1) AND ($2::text IS NULL OR l.route_id = $2) AND ($3::date IS NULL OR l.service_date = $3)
      ORDER BY l.created_at`, [filter.id ?? null, filter.routeId ?? null, filter.date ?? null, [...SEAT_RELEASING_STATUSES]]);
    return rows.map(lock);
  }
  async createLock(input: LockInput): Promise<SeatLock> {
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

  /** Reference data. Dates are cast in SQL so the driver never hands back a Date to re-render. */
  async listRoutes(): Promise<Route[]> {
    const { rows } = await this.client().query(`SELECT r.id, r.name, r.pier, r.family_id, r.color, r.islands, r.sort,
      COALESCE((SELECT array_agg(t.departs_at ORDER BY t.idx) FROM route_times t WHERE t.route_id = r.id), '{}') AS times
      FROM routes r ORDER BY r.sort NULLS LAST, r.id`);
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), pier: row.pier ?? undefined, family_id: row.family_id ?? undefined, color: row.color ?? undefined, islands: row.islands ?? undefined, sort: row.sort === null ? undefined : Number(row.sort), times: row.times ?? [] }));
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
    return rows.map((row) => ({ id: String(row.id), route_id: String(row.route_id), kind: row.kind as RouteSeason['kind'], from_date: String(row.from_date), to_date: String(row.to_date) }));
  }
  async listDayOverrides(from?: string, to?: string): Promise<RouteDayOverride[]> {
    const { rows } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) ORDER BY route_id, service_date', [from ?? null, to ?? null]);
    return rows.map((row) => ({ route_id: String(row.route_id), service_date: String(row.service_date), kind: row.kind as RouteDayOverride['kind'] }));
  }
}
