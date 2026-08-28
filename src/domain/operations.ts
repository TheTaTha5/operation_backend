import type { Route, RouteDayOverride, RouteSeason } from './calendar.js';
import { formatPaxGrid, holdsSeats, paxTotal, retargetPax, type PaxGrid, type PaxRow } from './pax.js';

export type Deployment = {
  boat_id: string;
  route_id: string;
  service_date: string;
  /** Normal-seat booking capacity. */
  capacity: number;
  license_pax?: number;
  total_capacity?: number;
};

export type BookingStatus = 'confirmed' | 'cancelled';

/** One departure. Seats are consumed here, so this is what every capacity query reads. */
export type BookingTripInput = { route_id: string; service_date: string; booking_mode?: string; pax: PaxRow[] };
export type BookingTrip = { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxGrid; pax_total: number };

export type BookingInput = {
  trips: BookingTripInput[];
  external_id?: string;
  agent_id?: string;
  voucher_ref?: string;
  rate_type_ref?: string;
  /** Original booking payload retained for operations, reconciliation, and audit import. */
  booking_data?: Record<string, unknown>;
};

export type Booking = {
  id: string;
  status: BookingStatus;
  created_at: string;
  updated_at: string;
  cancellation_reason?: string;
  /** Source-system identifiers and commercial context. */
  external_id?: string;
  agent_id?: string;
  voucher_ref?: string;
  rate_type_ref?: string;
  booking_data?: Record<string, unknown>;
  trips: BookingTrip[];
  /**
   * The first trip's route and date, the total pax across every trip, and the seats that total is
   * currently holding. All four are derived from `trips` and the status — they are not stored, and
   * they exist so a single-departure client needs to know nothing about trips.
   */
  route_id: string;
  service_date: string;
  booking_mode?: string;
  pax: number;
  allocated_pax: number;
};

export type BookingChanges = { trips?: BookingTripInput[]; route_id?: string; service_date?: string; pax?: number };

export type SeatLock = {
  id: string;
  route_id: string;
  service_date: string;
  pax: number;
  agent_id?: string;
  status: 'active' | 'released';
  created_at: string;
  updated_at: string;
  released_at?: string;
};

type Capacity = { deployed_capacity: number; total_capacity: number; booked_pax: number; charter_pax: number; locked_pax: number; available_seats: number };

/**
 * Seats already held by the reservation being edited. Excluding them stops a booking from competing
 * with itself: without this, raising a 6-pax booking to 8 on a full day is refused even though the
 * six seats it is about to release would cover it, and a no-op edit on a sold-out day cannot save.
 */
export type Exclusion = { bookingId?: string; lockId?: string };

/** A booking exactly as it is stored: trips as rows, nothing derived. Both stores hydrate into this. */
export type StoredTrip = { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxRow[] };
export type StoredBooking = Omit<Booking, 'trips' | 'route_id' | 'service_date' | 'booking_mode' | 'pax' | 'allocated_pax'> & { trips: StoredTrip[] };

/**
 * The wire shape of a stored booking.
 *
 * Every derived field is computed here and nowhere else — pax totals, the first trip's route and
 * date, and the seats the booking is holding. Deriving them in SQL for one store and in JavaScript
 * for the other is how the two drift, so the SQL side returns rows and calls this.
 */
export function bookingView(stored: StoredBooking): Booking {
  const trips = stored.trips.map((trip) => ({ ...trip, pax: formatPaxGrid(trip.pax), pax_total: paxTotal(trip.pax) }));
  const pax = trips.reduce((sum, trip) => sum + trip.pax_total, 0);
  const first = stored.trips[0];
  const seats = stored.trips.filter((trip) => trip.booking_mode !== 'charter').reduce((sum, trip) => sum + paxTotal(trip.pax), 0);
  return { ...stored, trips, route_id: first?.route_id ?? '', service_date: first?.service_date ?? '', booking_mode: first?.booking_mode, pax, allocated_pax: holdsSeats(stored.status) ? seats : 0 };
}

const fail = (message: string, statusCode: number): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };
const unavailable = (): never => fail('Insufficient available seats', 409);

/** Seat demand a set of trips places on each route/day, so two trips on one day are weighed together. */
export function demandByDay(trips: readonly BookingTripInput[]): { route_id: string; service_date: string; seat: number; charter: number }[] {
  const days = new Map<string, { route_id: string; service_date: string; seat: number; charter: number }>();
  for (const trip of trips) {
    const key = `${trip.route_id}\u0000${trip.service_date}`;
    const day = days.get(key) ?? { route_id: trip.route_id, service_date: trip.service_date, seat: 0, charter: 0 };
    day[trip.booking_mode === 'charter' ? 'charter' : 'seat'] += paxTotal(trip.pax);
    days.set(key, day);
  }
  return [...days.values()];
}

/** A small serialized in-memory unit of work. Replace this adapter with a DB transaction in production. */
export class OperationsStore {
  private deployments: Deployment[] = [];
  private bookings = new Map<string, StoredBooking>();
  private locks = new Map<string, SeatLock>();
  private tail: Promise<void> = Promise.resolve();
  /** Reference data. Empty unless seeded: with no database there is no catalogue to read. */
  private catalogue: { routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[] } = { routes: [], seasons: [], overrides: [] };

  /** Loads reference data that a PostgreSQL deployment gets from migrations instead. */
  seedCatalogue(catalogue: Partial<{ routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[] }>): void {
    if (catalogue.routes) this.catalogue.routes = catalogue.routes.map((route) => ({ ...route }));
    if (catalogue.seasons) this.catalogue.seasons = catalogue.seasons.map((season) => ({ ...season }));
    if (catalogue.overrides) this.catalogue.overrides = catalogue.overrides.map((override) => ({ ...override }));
  }
  listRoutes(): Route[] { return this.catalogue.routes.map((route) => ({ ...route })); }
  listSeasons(): RouteSeason[] { return this.catalogue.seasons.map((season) => ({ ...season })); }
  listDayOverrides(from?: string, to?: string): RouteDayOverride[] {
    return this.catalogue.overrides.filter((o) => (!from || o.service_date >= from) && (!to || o.service_date <= to)).map((o) => ({ ...o }));
  }

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }

  private now(): string { return new Date().toISOString(); }
  private id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }

  private view(stored: StoredBooking): Booking { return bookingView(stored); }

  capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Capacity {
    const onDay = this.deployments.filter((d) => d.route_id === routeId && d.service_date === serviceDate);
    const deployed_capacity = onDay.reduce((sum, d) => sum + d.capacity, 0);
    const total_capacity = onDay.reduce((sum, d) => sum + (d.total_capacity ?? d.capacity), 0);
    let booked_pax = 0, charter_pax = 0;
    for (const booking of this.bookings.values()) {
      if (booking.id === exclude.bookingId || !holdsSeats(booking.status)) continue;
      for (const trip of booking.trips) {
        if (trip.route_id !== routeId || trip.service_date !== serviceDate) continue;
        if (trip.booking_mode === 'charter') charter_pax += paxTotal(trip.pax); else booked_pax += paxTotal(trip.pax);
      }
    }
    const locked_pax = [...this.locks.values()]
      .filter((l) => l.route_id === routeId && l.service_date === serviceDate && l.status === 'active' && l.id !== exclude.lockId)
      .reduce((sum, l) => sum + l.pax, 0);
    return { deployed_capacity, total_capacity, booked_pax, charter_pax, locked_pax, available_seats: deployed_capacity - booked_pax - locked_pax };
  }

  private assertCapacity(routeId: string, serviceDate: string, pax: number, charter = false, exclude: Exclusion = {}): void {
    const capacity = this.capacity(routeId, serviceDate, exclude);
    const available = charter ? capacity.total_capacity - capacity.booked_pax - capacity.charter_pax - capacity.locked_pax : capacity.available_seats;
    if (available < pax) unavailable();
  }

  /** Weighs every day a booking touches, so a multi-day booking is refused as a whole or not at all. */
  private assertTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}): void {
    for (const day of demandByDay(trips)) {
      if (day.seat > 0) this.assertCapacity(day.route_id, day.service_date, day.seat, false, exclude);
      if (day.charter > 0) this.assertCapacity(day.route_id, day.service_date, day.charter, true, exclude);
    }
  }

  createDeployment(input: Deployment): Deployment {
    const existing = this.deployments.findIndex((d) => d.boat_id === input.boat_id && d.service_date === input.service_date);
    if (existing >= 0) this.deployments[existing] = { ...input };
    else this.deployments.push({ ...input });
    return { ...input };
  }

  deleteDeployment(serviceDate: string, boatId: string): boolean {
    const index = this.deployments.findIndex((d) => d.service_date === serviceDate && d.boat_id === boatId);
    if (index < 0) return false;
    this.deployments.splice(index, 1);
    return true;
  }

  listDeployments(from?: string, to?: string, routeId?: string): Deployment[] {
    return this.deployments.filter((d) => (!from || d.service_date >= from) && (!to || d.service_date <= to) && (!routeId || d.route_id === routeId));
  }

  private storedTrips(bookingId: string, trips: readonly BookingTripInput[]): StoredTrip[] {
    return trips.map((trip, seq) => ({ id: `trip_${bookingId}_${seq}`, seq, route_id: trip.route_id, service_date: trip.service_date, booking_mode: trip.booking_mode === 'charter' ? 'charter' : 'seat', pax: trip.pax.map((row) => ({ ...row })) }));
  }

  createBooking(input: BookingInput): Booking {
    this.assertTrips(input.trips);
    const now = this.now();
    const id = this.id('booking');
    const { trips, ...rest } = input;
    const booking: StoredBooking = { ...rest, id, status: 'confirmed', created_at: now, updated_at: now, trips: this.storedTrips(id, trips) };
    this.bookings.set(id, booking);
    return this.view(booking);
  }

  listBookings(routeId?: string, serviceDate?: string): Booking[] {
    return [...this.bookings.values()]
      .filter((b) => b.trips.some((t) => (!routeId || t.route_id === routeId) && (!serviceDate || t.service_date === serviceDate)))
      .map((b) => this.view(b));
  }
  booking(id: string): Booking | undefined { const value = this.bookings.get(id); return value && this.view(value); }

  amendBooking(id: string, changes: BookingChanges): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const replacement = nextTrips(booking.trips, changes);
    if (holdsSeats(booking.status) && tripsChanged(booking.trips, replacement)) this.assertTrips(replacement, { bookingId: id });
    booking.trips = this.storedTrips(id, replacement);
    booking.updated_at = this.now();
    return this.view(booking);
  }

  cancelBooking(id: string, reason?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (booking.status === 'confirmed') Object.assign(booking, { status: 'cancelled', cancellation_reason: reason, updated_at: this.now() });
    return this.view(booking);
  }

  partialCancel(id: string, paxToCancel: number): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    booking.trips = this.storedTrips(id, partialCancelTrips(booking.trips, booking.status, paxToCancel));
    booking.updated_at = this.now();
    return this.view(booking);
  }

  createLock(input: Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>): SeatLock {
    this.assertCapacity(input.route_id, input.service_date, input.pax);
    const now = this.now();
    const lock: SeatLock = { ...input, id: this.id('lock'), status: 'active', created_at: now, updated_at: now };
    this.locks.set(lock.id, lock);
    return { ...lock };
  }
  listLocks(routeId?: string, serviceDate?: string): SeatLock[] {
    return [...this.locks.values()].filter((l) => (!routeId || l.route_id === routeId) && (!serviceDate || l.service_date === serviceDate)).map((l) => ({ ...l }));
  }
  amendLock(id: string, changes: Partial<Pick<SeatLock, 'pax' | 'agent_id'>>): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    const pax = typeof changes.pax === 'number' ? changes.pax : lock.pax;
    if (lock.status === 'active' && pax !== lock.pax) {
      this.assertCapacity(lock.route_id, lock.service_date, pax, false, { lockId: id });
      lock.pax = pax;
    }
    Object.assign(lock, changes, { pax, updated_at: this.now() });
    return { ...lock };
  }
  releaseLock(id: string): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    if (lock.status === 'active') Object.assign(lock, { status: 'released', released_at: this.now(), updated_at: this.now() });
    return { ...lock };
  }

  allotment(routeId: string, serviceDate: string, exclude: Exclusion = {}): Capacity & { route_id: string; service_date: string; deployments: Deployment[] } {
    return { route_id: routeId, service_date: serviceDate, ...this.capacity(routeId, serviceDate, exclude), deployments: this.listDeployments(serviceDate, serviceDate, routeId) };
  }
}

/**
 * The trips an amendment leaves behind.
 *
 * `trips` replaces the itinerary outright. The older single-departure fields still work, but only on
 * a booking that has one departure — on a multi-trip booking "the route" is ambiguous, and guessing
 * would move seats the caller never mentioned.
 */
export function nextTrips(current: readonly StoredTrip[], changes: BookingChanges): BookingTripInput[] {
  if (changes.trips) return changes.trips.map((trip) => ({ ...trip, pax: trip.pax.map((row) => ({ ...row })) }));
  if (changes.route_id === undefined && changes.service_date === undefined && changes.pax === undefined) return current.map(asInput);
  const trip = onlyTrip(current, 'confirmed', 'Amend a multi-trip booking by sending trips');
  return [{
    route_id: changes.route_id ?? trip.route_id,
    service_date: changes.service_date ?? trip.service_date,
    booking_mode: trip.booking_mode,
    pax: changes.pax === undefined ? trip.pax.map((row) => ({ ...row })) : retargetPax(trip.pax, changes.pax),
  }];
}

const asInput = (trip: StoredTrip): BookingTripInput => ({ route_id: trip.route_id, service_date: trip.service_date, booking_mode: trip.booking_mode, pax: trip.pax.map((row) => ({ ...row })) });

/**
 * Cancelling a count rather than named passengers. Only a single-departure booking can do this: on a
 * multi-trip booking a bare number does not say which day loses the seats, and `reducePax` decides
 * which cells shrink. A caller that knows both should amend the trips instead.
 */
export function partialCancelTrips(trips: readonly StoredTrip[], status: BookingStatus, count: number): BookingTripInput[] {
  const trip = onlyTrip(trips, status, 'Partial-cancel a multi-trip booking by sending trips');
  const total = paxTotal(trip.pax);
  if (count > total) fail('Cannot cancel more passengers than the active booking', 400);
  return [{ ...asInput(trip), pax: retargetPax(trip.pax, total - count) }];
}

function onlyTrip(trips: readonly StoredTrip[], status: BookingStatus, message: string): StoredTrip {
  if (status !== 'confirmed') fail('Cannot cancel more passengers than the active booking', 400);
  if (trips.length !== 1) fail(message, 400);
  return trips[0];
}

/** Whether an amendment moves seats at all; an unchanged itinerary must not be re-checked against the pool. */
export const tripsChanged = (current: readonly StoredTrip[], next: readonly BookingTripInput[]): boolean =>
  current.length !== next.length || current.some((trip, index) => trip.route_id !== next[index].route_id || trip.service_date !== next[index].service_date || paxTotal(trip.pax) !== paxTotal(next[index].pax) || trip.booking_mode !== (next[index].booking_mode === 'charter' ? 'charter' : 'seat'));
