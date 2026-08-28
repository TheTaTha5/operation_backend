import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  assertKnownRoutes, bookingView, demandByDay, nextTrips, partialCancelTrips, tripsChanged,
  type Booking, type BookingChanges, type BookingInput, type BookingTripInput, type Deployment, type Exclusion, type SeatLock, type StoredBooking,
} from './operations.js';
import { holdsSeats, SEAT_HOLDING_STATUSES, type PaxCategory, type PaxResidency } from './pax.js';
import type { Route, RouteDayOverride, RouteSeason } from './calendar.js';

type Capacity = { deployed_capacity: number; total_capacity: number; booked_pax: number; charter_pax: number; locked_pax: number; available_seats: number };
type LockInput = Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>;
const unavailable = (): never => { const error = new Error('Insufficient available seats'); (error as Error & { statusCode: number }).statusCode = 409; throw error; };
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
const BOOKING_SELECT = `SELECT b.*, COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'seq', t.seq, 'route_id', t.route_id, 'service_date', t.service_date::text, 'booking_mode', t.booking_mode,
      'pax', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', p.category, 'residency', p.residency, 'count', p.count) ORDER BY p.category, p.residency)
                       FROM booking_trip_pax p WHERE p.booking_trip_id = t.id), '[]'::jsonb)
    ) ORDER BY t.seq)
    FROM booking_trips t WHERE t.booking_id = b.id), '[]'::jsonb) AS trips
  FROM bookings b`;

const stored = (row: QueryResultRow): StoredBooking => ({
  id: String(row.id), status: row.status as Booking['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
  cancellation_reason: row.cancellation_reason ?? undefined, external_id: row.external_id ?? undefined, agent_id: row.agent_id ?? undefined,
  voucher_ref: row.voucher_ref ?? undefined, rate_type_ref: row.rate_type_ref ?? undefined, booking_data: row.booking_data ?? undefined,
  trips: (row.trips as Record<string, unknown>[]).map((trip) => ({
    id: String(trip.id), seq: Number(trip.seq), route_id: String(trip.route_id), service_date: String(trip.service_date), booking_mode: String(trip.booking_mode),
    pax: (trip.pax as Record<string, unknown>[]).map((cell) => ({ category: cell.category as PaxCategory, residency: cell.residency as PaxResidency, count: Number(cell.count) })),
  })),
});
const booking = (row: QueryResultRow): Booking => bookingView(stored(row));
const lock = (row: QueryResultRow): SeatLock => ({ id: String(row.id), route_id: String(row.route_id), service_date: dateOnly(row.service_date), pax: Number(row.pax), status: row.status as SeatLock['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at), released_at: row.released_at ? asIso(row.released_at) : undefined, agent_id: row.agent_id ?? undefined });

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

  async capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Promise<Capacity> {
    // `id IS DISTINCT FROM NULL` is true for every row, so an absent exclusion needs no query variant.
    // The seat-holding status list is passed in rather than written here: `pax.ts` owns that rule.
    const { rows: [row] } = await this.client().query(`SELECT
      COALESCE((SELECT SUM(capacity) FROM deployments WHERE route_id = $1 AND service_date = $2), 0)::int AS deployed_capacity,
      COALESCE((SELECT SUM(total_capacity) FROM deployments WHERE route_id = $1 AND service_date = $2), 0)::int AS total_capacity,
      COALESCE((SELECT SUM(p.count) FROM booking_trips t
                JOIN bookings b ON b.id = t.booking_id
                JOIN booking_trip_pax p ON p.booking_trip_id = t.id
                WHERE t.route_id = $1 AND t.service_date = $2 AND b.status = ANY($5::text[])
                  AND t.booking_mode <> 'charter' AND t.booking_id IS DISTINCT FROM $3), 0)::int AS booked_pax,
      COALESCE((SELECT SUM(p.count) FROM booking_trips t
                JOIN bookings b ON b.id = t.booking_id
                JOIN booking_trip_pax p ON p.booking_trip_id = t.id
                WHERE t.route_id = $1 AND t.service_date = $2 AND b.status = ANY($5::text[])
                  AND t.booking_mode = 'charter' AND t.booking_id IS DISTINCT FROM $3), 0)::int AS charter_pax,
      COALESCE((SELECT SUM(pax) FROM seat_locks WHERE route_id = $1 AND service_date = $2 AND status = 'active' AND id IS DISTINCT FROM $4), 0)::int AS locked_pax`,
      [routeId, serviceDate, exclude.bookingId ?? null, exclude.lockId ?? null, [...SEAT_HOLDING_STATUSES]]);
    const deployed_capacity = Number(row.deployed_capacity); const total_capacity = Number(row.total_capacity); const booked_pax = Number(row.booked_pax); const charter_pax = Number(row.charter_pax); const locked_pax = Number(row.locked_pax);
    return { deployed_capacity, total_capacity, booked_pax, charter_pax, locked_pax, available_seats: deployed_capacity - booked_pax - locked_pax };
  }
  private async assertCapacity(routeId: string, date: string, seats: number, charter = false, exclude: Exclusion = {}): Promise<void> { await this.lockPool(routeId, date); const capacity = await this.capacity(routeId, date, exclude); const available = charter ? capacity.total_capacity - capacity.booked_pax - capacity.charter_pax - capacity.locked_pax : capacity.available_seats; if (available < seats) unavailable(); }

  /**
   * Weighs every day a booking touches, so a multi-day booking is refused as a whole or not at all.
   *
   * Pools are locked before any is read, and in a fixed order: two concurrent bookings covering the
   * same days in opposite order would otherwise each hold what the other is waiting for. `vacating`
   * adds the days an amendment is leaving, which must be held too or a competitor can take the seats
   * between the check and the write.
   */
  private async assertTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, vacating: readonly { route_id: string; service_date: string }[] = []): Promise<void> {
    const days = demandByDay(trips);
    const pools = new Map<string, { route_id: string; service_date: string }>();
    for (const day of [...days, ...vacating]) pools.set(`${day.route_id} ${day.service_date}`, { route_id: day.route_id, service_date: day.service_date });
    for (const key of [...pools.keys()].sort()) { const pool = pools.get(key)!; await this.lockPool(pool.route_id, pool.service_date); }
    for (const day of days) {
      const capacity = await this.capacity(day.route_id, day.service_date, exclude);
      if (day.seat > 0 && capacity.available_seats < day.seat) unavailable();
      if (day.charter > 0 && capacity.total_capacity - capacity.booked_pax - capacity.charter_pax - capacity.locked_pax < day.charter) unavailable();
    }
  }

  async createDeployment(input: Deployment): Promise<Deployment> {
    await this.client().query(`INSERT INTO deployments (boat_id, route_id, service_date, capacity, license_pax, total_capacity) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (service_date, boat_id) DO UPDATE SET route_id = EXCLUDED.route_id, capacity = EXCLUDED.capacity, license_pax = EXCLUDED.license_pax, total_capacity = EXCLUDED.total_capacity`, [input.boat_id, input.route_id, input.service_date, input.capacity, input.license_pax ?? null, input.total_capacity ?? input.capacity]);
    return input;
  }
  async deleteDeployment(date: string, boat: string): Promise<boolean> { return (await this.client().query('DELETE FROM deployments WHERE service_date = $1 AND boat_id = $2', [date, boat])).rowCount === 1; }
  async listDeployments(from?: string, to?: string, routeId?: string): Promise<Deployment[]> {
    const { rows } = await this.client().query('SELECT boat_id, route_id, service_date::text, capacity, license_pax, total_capacity FROM deployments WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) AND ($3::text IS NULL OR route_id = $3) ORDER BY service_date, boat_id', [from ?? null, to ?? null, routeId ?? null]);
    return rows.map((row) => ({ ...row, capacity: Number(row.capacity), license_pax: row.license_pax === null ? undefined : Number(row.license_pax), total_capacity: Number(row.total_capacity) }));
  }

  private async writeTrips(bookingId: string, trips: readonly BookingTripInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_trips WHERE booking_id = $1', [bookingId]);
    for (const [seq, trip] of trips.entries()) {
      const id = `trip_${bookingId}_${seq}`;
      await this.client().query('INSERT INTO booking_trips (id, booking_id, seq, route_id, service_date, booking_mode) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, bookingId, seq, trip.route_id, trip.service_date, trip.booking_mode === 'charter' ? 'charter' : 'seat']);
      for (const cell of trip.pax) {
        await this.client().query('INSERT INTO booking_trip_pax (booking_trip_id, category, residency, count) VALUES ($1,$2,$3,$4)', [id, cell.category, cell.residency, cell.count]);
      }
    }
  }

  /** Answers 400 before `booking_trips_route_fk` can answer 500. */
  private async assertRoutes(trips: readonly BookingTripInput[]): Promise<void> {
    const ids = [...new Set(trips.map((trip) => trip.route_id))];
    const { rows } = await this.client().query('SELECT id FROM routes WHERE id = ANY($1::text[])', [ids]);
    assertKnownRoutes(new Set(rows.map((row) => String(row.id))), trips);
  }

  async createBooking(input: BookingInput): Promise<Booking> {
    await this.assertRoutes(input.trips);
    await this.assertTrips(input.trips);
    const id = `booking_${randomUUID()}`;
    await this.client().query(`INSERT INTO bookings (id, status, external_id, agent_id, voucher_ref, rate_type_ref, booking_mode, booking_data)
      VALUES ($1,'confirmed',$2,$3,$4,$5,$6,$7::jsonb)`,
      [id, input.external_id ?? null, input.agent_id ?? null, input.voucher_ref ?? null, input.rate_type_ref ?? null, input.trips[0]?.booking_mode ?? null, JSON.stringify(input.booking_data ?? {})]);
    await this.writeTrips(id, input.trips);
    return (await this.booking(id))!;
  }

  async listBookings(routeId?: string, date?: string): Promise<Booking[]> {
    const { rows } = await this.client().query(`${BOOKING_SELECT}
      WHERE EXISTS (SELECT 1 FROM booking_trips t WHERE t.booking_id = b.id AND ($1::text IS NULL OR t.route_id = $1) AND ($2::date IS NULL OR t.service_date = $2))
      ORDER BY b.created_at`, [routeId ?? null, date ?? null]);
    return rows.map(booking);
  }
  async booking(id: string): Promise<Booking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && booking(row); }
  private async storedBooking(id: string): Promise<StoredBooking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && stored(row); }

  async amendBooking(id: string, changes: BookingChanges): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    const replacement = nextTrips(current.trips, changes);
    await this.assertRoutes(replacement);
    if (holdsSeats(current.status) && tripsChanged(current.trips, replacement)) await this.assertTrips(replacement, { bookingId: id }, current.trips);
    await this.writeTrips(id, replacement);
    await this.client().query('UPDATE bookings SET booking_mode = $2, updated_at = now() WHERE id = $1', [id, replacement[0]?.booking_mode ?? null]);
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

  async createLock(input: LockInput): Promise<SeatLock> { await this.assertCapacity(input.route_id, input.service_date, input.pax); const { rows: [row] } = await this.client().query("INSERT INTO seat_locks (id,route_id,service_date,pax,agent_id,status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING *", [`lock_${randomUUID()}`, input.route_id, input.service_date, input.pax, input.agent_id ?? null]); return lock(row); }
  async listLocks(routeId?: string, date?: string): Promise<SeatLock[]> { const { rows } = await this.client().query('SELECT * FROM seat_locks WHERE ($1::text IS NULL OR route_id=$1) AND ($2::date IS NULL OR service_date=$2) ORDER BY created_at', [routeId ?? null, date ?? null]); return rows.map(lock); }
  async amendLock(id: string, changes: Partial<Pick<SeatLock, 'pax' | 'agent_id'>>): Promise<SeatLock | undefined> { const { rows: [existing] } = await this.client().query('SELECT * FROM seat_locks WHERE id = $1', [id]); if (!existing) return undefined; const current = lock(existing); const seats = changes.pax ?? current.pax; if (current.status === 'active' && seats !== current.pax) { await this.lockPool(current.route_id, current.service_date); if ((await this.capacity(current.route_id, current.service_date, { lockId: id })).available_seats < seats) unavailable(); } const { rows: [row] } = await this.client().query('UPDATE seat_locks SET pax=$2, agent_id=$3, updated_at=now() WHERE id=$1 RETURNING *', [id,seats,changes.agent_id ?? current.agent_id ?? null]); return lock(row); }
  async releaseLock(id: string): Promise<SeatLock | undefined> { const { rows: [row] } = await this.client().query("UPDATE seat_locks SET status='released', released_at=COALESCE(released_at, now()), updated_at=now() WHERE id=$1 RETURNING *", [id]); return row && lock(row); }
  async allotment(routeId: string, date: string, exclude: Exclusion = {}): Promise<Capacity & { route_id: string; service_date: string; deployments: Deployment[] }> { return { route_id: routeId, service_date: date, ...(await this.capacity(routeId,date,exclude)), deployments: await this.listDeployments(date,date,routeId) }; }

  /** Reference data. Dates are cast in SQL so the driver never hands back a Date to re-render. */
  async listRoutes(): Promise<Route[]> {
    const { rows } = await this.client().query(`SELECT r.id, r.name, r.pier, r.family_id, r.color, r.islands, r.sort,
      COALESCE((SELECT array_agg(t.departs_at ORDER BY t.idx) FROM route_times t WHERE t.route_id = r.id), '{}') AS times
      FROM routes r ORDER BY r.sort NULLS LAST, r.id`);
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), pier: row.pier ?? undefined, family_id: row.family_id ?? undefined, color: row.color ?? undefined, islands: row.islands ?? undefined, sort: row.sort === null ? undefined : Number(row.sort), times: row.times ?? [] }));
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
