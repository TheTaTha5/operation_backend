import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Booking, Deployment, Exclusion, SeatLock } from './operations.js';

type Capacity = { deployed_capacity: number; total_capacity: number; booked_pax: number; charter_pax: number; locked_pax: number; available_seats: number };
type BookingInput = Omit<Booking, 'id' | 'allocated_pax' | 'status' | 'created_at' | 'updated_at'>;
type LockInput = Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>;
const unavailable = (): never => { const error = new Error('Insufficient available seats'); (error as Error & { statusCode: number }).statusCode = 409; throw error; };
const invalidPartialCancel = (): never => { const error = new Error('Cannot cancel more passengers than the active booking'); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const asIso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const dateOnly = (value: unknown): string => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value);
const booking = (row: QueryResultRow): Booking => ({ id: String(row.id), route_id: String(row.route_id), service_date: dateOnly(row.service_date), pax: Number(row.pax), allocated_pax: Number(row.allocated_pax), status: row.status as Booking['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at), cancellation_reason: row.cancellation_reason ?? undefined, external_id: row.external_id ?? undefined, agent_id: row.agent_id ?? undefined, voucher_ref: row.voucher_ref ?? undefined, rate_type_ref: row.rate_type_ref ?? undefined, booking_mode: row.booking_mode ?? undefined, pax_breakdown: row.pax_breakdown ?? undefined, booking_data: row.booking_data ?? undefined });
const lock = (row: QueryResultRow): SeatLock => ({ id: String(row.id), route_id: String(row.route_id), service_date: dateOnly(row.service_date), pax: Number(row.pax), status: row.status as SeatLock['status'], created_at: asIso(row.created_at), updated_at: asIso(row.updated_at), released_at: row.released_at ? asIso(row.released_at) : undefined, agent_id: row.agent_id ?? undefined });

/** PostgreSQL repository. Advisory transaction locks serialize one route/day capacity pool across all API instances. */
export class PostgresOperationsStore {
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<PoolClient>();
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }
  private client(): Pool | PoolClient { return this.context.getStore() ?? this.pool; }
  async close(): Promise<void> { await this.pool.end(); }

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return await work();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await this.context.run(client, work);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async lockPool(routeId: string, date: string): Promise<void> { await this.client().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${routeId}:${date}`]); }
  async capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Promise<Capacity> {
    // `id IS DISTINCT FROM NULL` is true for every row, so an absent exclusion needs no query variant.
    const { rows: [row] } = await this.client().query(`SELECT
      COALESCE((SELECT SUM(capacity) FROM deployments WHERE route_id = $1 AND service_date = $2), 0)::int AS deployed_capacity,
      COALESCE((SELECT SUM(total_capacity) FROM deployments WHERE route_id = $1 AND service_date = $2), 0)::int AS total_capacity,
      COALESCE((SELECT SUM(allocated_pax) FROM bookings WHERE route_id = $1 AND service_date = $2 AND status = 'confirmed' AND booking_mode IS DISTINCT FROM 'charter' AND id IS DISTINCT FROM $3), 0)::int AS booked_pax,
      COALESCE((SELECT SUM(pax) FROM bookings WHERE route_id = $1 AND service_date = $2 AND status = 'confirmed' AND booking_mode = 'charter' AND id IS DISTINCT FROM $3), 0)::int AS charter_pax,
      COALESCE((SELECT SUM(pax) FROM seat_locks WHERE route_id = $1 AND service_date = $2 AND status = 'active' AND id IS DISTINCT FROM $4), 0)::int AS locked_pax`,
      [routeId, serviceDate, exclude.bookingId ?? null, exclude.lockId ?? null]);
    const deployed_capacity = Number(row.deployed_capacity); const total_capacity = Number(row.total_capacity); const booked_pax = Number(row.booked_pax); const charter_pax = Number(row.charter_pax); const locked_pax = Number(row.locked_pax);
    return { deployed_capacity, total_capacity, booked_pax, charter_pax, locked_pax, available_seats: deployed_capacity - booked_pax - locked_pax };
  }
  private async assertCapacity(routeId: string, date: string, seats: number, charter = false, exclude: Exclusion = {}): Promise<void> { await this.lockPool(routeId, date); const capacity = await this.capacity(routeId, date, exclude); const available = charter ? capacity.total_capacity - capacity.booked_pax - capacity.charter_pax - capacity.locked_pax : capacity.available_seats; if (available < seats) unavailable(); }

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
  async createBooking(input: BookingInput): Promise<Booking> {
    const charter = input.booking_mode === 'charter';
    await this.assertCapacity(input.route_id, input.service_date, input.pax, charter);
    const { rows: [row] } = await this.client().query(`INSERT INTO bookings (id, route_id, service_date, pax, allocated_pax, status, external_id, agent_id, voucher_ref, rate_type_ref, booking_mode, pax_breakdown, booking_data) VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) RETURNING *`, [`booking_${randomUUID()}`, input.route_id, input.service_date, input.pax, charter ? 0 : input.pax, input.external_id ?? null, input.agent_id ?? null, input.voucher_ref ?? null, input.rate_type_ref ?? null, input.booking_mode ?? null, JSON.stringify(input.pax_breakdown ?? {}), JSON.stringify(input.booking_data ?? {})]);
    return booking(row);
  }
  async listBookings(routeId?: string, date?: string): Promise<Booking[]> { const { rows } = await this.client().query('SELECT * FROM bookings WHERE ($1::text IS NULL OR route_id = $1) AND ($2::date IS NULL OR service_date = $2) ORDER BY created_at', [routeId ?? null, date ?? null]); return rows.map(booking); }
  async booking(id: string): Promise<Booking | undefined> { const { rows: [row] } = await this.client().query('SELECT * FROM bookings WHERE id = $1', [id]); return row && booking(row); }
  async amendBooking(id: string, changes: Partial<Pick<Booking, 'route_id' | 'service_date' | 'pax'>>): Promise<Booking | undefined> {
    const current = await this.booking(id); if (!current) return undefined;
    const route = changes.route_id ?? current.route_id, date = changes.service_date ?? current.service_date, seats = changes.pax ?? current.pax;
    if (current.status === 'confirmed' && (route !== current.route_id || date !== current.service_date || seats !== current.pax)) {
      await this.lockPool(current.route_id, current.service_date); await this.lockPool(route, date);
      if ((await this.capacity(route, date, { bookingId: id })).available_seats < seats) unavailable();
    }
    const { rows: [row] } = await this.client().query('UPDATE bookings SET route_id=$2, service_date=$3, pax=$4, allocated_pax=CASE WHEN status = \'confirmed\' THEN $4 ELSE allocated_pax END, updated_at=now() WHERE id=$1 RETURNING *', [id, route, date, seats]); return booking(row);
  }
  async cancelBooking(id: string, reason?: string): Promise<Booking | undefined> { const { rows: [row] } = await this.client().query("UPDATE bookings SET status='cancelled', allocated_pax=0, cancellation_reason=$2, updated_at=now() WHERE id=$1 RETURNING *", [id, reason ?? null]); return row && booking(row); }
  async partialCancel(id: string, count: number): Promise<Booking | undefined> { const current = await this.booking(id); if (!current) return undefined; if (current.status !== 'confirmed' || count > current.pax) invalidPartialCancel(); const { rows: [row] } = await this.client().query('UPDATE bookings SET pax=pax-$2, allocated_pax=allocated_pax-$2, updated_at=now() WHERE id=$1 RETURNING *', [id, count]); return booking(row); }
  async createLock(input: LockInput): Promise<SeatLock> { await this.assertCapacity(input.route_id, input.service_date, input.pax); const { rows: [row] } = await this.client().query("INSERT INTO seat_locks (id,route_id,service_date,pax,agent_id,status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING *", [`lock_${randomUUID()}`, input.route_id, input.service_date, input.pax, input.agent_id ?? null]); return lock(row); }
  async listLocks(routeId?: string, date?: string): Promise<SeatLock[]> { const { rows } = await this.client().query('SELECT * FROM seat_locks WHERE ($1::text IS NULL OR route_id=$1) AND ($2::date IS NULL OR service_date=$2) ORDER BY created_at', [routeId ?? null, date ?? null]); return rows.map(lock); }
  async amendLock(id: string, changes: Partial<Pick<SeatLock, 'pax' | 'agent_id'>>): Promise<SeatLock | undefined> { const { rows: [existing] } = await this.client().query('SELECT * FROM seat_locks WHERE id = $1', [id]); if (!existing) return undefined; const current = lock(existing); const seats = changes.pax ?? current.pax; if (current.status === 'active' && seats !== current.pax) { await this.lockPool(current.route_id, current.service_date); if ((await this.capacity(current.route_id, current.service_date, { lockId: id })).available_seats < seats) unavailable(); } const { rows: [row] } = await this.client().query('UPDATE seat_locks SET pax=$2, agent_id=$3, updated_at=now() WHERE id=$1 RETURNING *', [id,seats,changes.agent_id ?? current.agent_id ?? null]); return lock(row); }
  async releaseLock(id: string): Promise<SeatLock | undefined> { const { rows: [row] } = await this.client().query("UPDATE seat_locks SET status='released', released_at=COALESCE(released_at, now()), updated_at=now() WHERE id=$1 RETURNING *", [id]); return row && lock(row); }
  async allotment(routeId: string, date: string, exclude: Exclusion = {}): Promise<Capacity & { route_id: string; service_date: string; deployments: Deployment[] }> { return { route_id: routeId, service_date: date, ...(await this.capacity(routeId,date,exclude)), deployments: await this.listDeployments(date,date,routeId) }; }
}
