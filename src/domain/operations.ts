import { eachDate, type Route, type RouteDayOverride, type RouteSeason } from './calendar.js';
import { formatPaxGrid, paxTotal, retargetPax, type PaxGrid, type PaxRow } from './pax.js';
import { holdsSeats, type BookingStatus } from './booking-status.js';
import { assertDayFits, assertLockFits, capacityNumbers, dayCapacity, type Capacity, type DayDemand, type DayState, type HeldTrip } from './capacity.js';
import { applyBookingHeader, type BookingHeader, type BookingHeaderPatch } from './booking-header.js';
import { withSeq, type BookingPassenger, type BookingPassengerInput } from './booking-passengers.js';
import {
  agentSummary, agentView, latestActivity, selectAgents, sortMarkets, sortSalesPeople,
  type Agent, type AgentActivity, type AgentListQuery, type AgentSummary, type Market, type SalesPerson, type StoredActivity, type StoredAgent,
} from './agents.js';

export type Deployment = {
  boat_id: string;
  route_id: string;
  service_date: string;
  /** Normal-seat booking capacity — the commercial decision, clamped by `license_pax` when selling. */
  capacity: number;
  /** Registered passenger maximum. Filled from the boat catalogue when the caller omits it. */
  license_pax?: number;
  /** Registered total persons aboard (passengers + crew). A vessel fact, never a selling ceiling. */
  registered_persons?: number;
};

/** A per-day capacity change for one boat, from `boat_capacity_overrides`. */
export type BoatCapacityOverride = { boat_id: string; service_date: string; capacity: number; reason?: string };
/**
 * The boat catalogue entry a deployment's licence is resolved from.
 *
 * `name` and `capacity` are required because the `boats` table declares them NOT NULL. Leaving them
 * optional let the in-process store hold a boat PostgreSQL would reject, which is the divergence
 * shape that kept the seat-lock `service_date` bug alive: only one store was ever exercised.
 */
export type Boat = { id: string; name: string; type?: string; pier?: string; capacity: number; license_pax?: number; crew?: number };



/** Seats a trip takes from an agent's lock rather than from the general pool. */
export type LockDraw = { lock_id: string; qty: number };

/**
 * One departure. Seats are consumed here, so this is what every capacity query reads.
 *
 * `charter_boat_id` is the boat a charter takes whole, and only a charter carries one.
 * `lock_draws` are the seats a seat trip takes from locks; they never exceed the trip's pax.
 * `id` names the stored trip an amendment is editing; a trip without one is new. See `planTrips`.
 * The pickup and overnight fields are described in migration 015 and checked by `assertItinerary`.
 */
export type TripDetails = { zone?: string; pickup_time?: string; ovn?: OvnMode; ovn_return_date?: string; ovn_leg?: boolean };
export type OvnMode = 'return' | 'self';
/** `ovn_of` is an index into the same trip list, on input and on the wire. */
export type BookingTripInput = TripDetails & { id?: string; route_id: string; service_date: string; booking_mode?: string; pax: PaxRow[]; charter_boat_id?: string; lock_draws?: LockDraw[]; ovn_of?: number };
export type BookingTrip = TripDetails & { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxGrid; pax_total: number; charter_boat_id?: string; lock_draws: Record<string, number>; ovn_leg: boolean; ovn_of?: number };

export type BookingInput = {
  trips: BookingTripInput[];
  /** Defaults to `confirmed`. A status that releases seats is created without reserving any. */
  status?: BookingStatus;
  external_id?: string;
  agent_id?: string;
  voucher_ref?: string;
  rate_type_ref?: string;
  /**
   * The header scalars, already read out of the caller's document by `bookingHeader()`. Both stores
   * persist these as columns; neither parses the document itself.
   */
  header?: BookingHeader;
  /** The passenger list, already parsed by `parseBookingPassengers()`. Defaults to none. */
  passengers?: BookingPassengerInput[];
  /**
   * Original booking payload retained for operations, reconciliation, and audit import.
   *
   * Written beside the header columns during the dual-write step, and on its way out — a field that
   * is not modelled is dropped rather than kept here. See `todo/booking-model.md`.
   */
  booking_data?: Record<string, unknown>;
};

export type Booking = BookingHeader & {
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
  passengers: BookingPassenger[];
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

/**
 * An amendment. `header` merges: a column it does not mention keeps the value it had, and one it
 * mentions with no value is cleared — see `BookingHeaderPatch`. The itinerary fields are the
 * exception and replace outright, because a trip list is one fact rather than fifty-seven.
 */
export type BookingChanges = {
  trips?: BookingTripInput[]; route_id?: string; service_date?: string; pax?: number; status?: BookingStatus;
  header?: BookingHeaderPatch;
  /** Present replaces the whole list outright, the same way `trips` does. Absent leaves it alone. */
  passengers?: BookingPassengerInput[];
};

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
  /** Seats drawn from this lock by bookings that hold seats. The lock itself still holds `pax - drawn_pax`. */
  drawn_pax?: number;
};

/**
 * Seats already held by the reservation being edited. Excluding them stops a booking from competing
 * with itself: without this, raising a 6-pax booking to 8 on a full day is refused even though the
 * six seats it is about to release would cover it, and a no-op edit on a sold-out day cannot save.
 */
export type Exclusion = { bookingId?: string; lockId?: string };

export type BookingListQuery = {
  routeId?: string;
  agentId?: string;
  serviceDate?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
  /** By `created_at`, then id. `desc` is newest first, which an agent's recent bookings want. Defaults to `asc`. */
  order?: 'asc' | 'desc';
};

export type BookingPage = { bookings: Booking[]; next_cursor?: string };

/** One route on one date, as the availability range returns it. */
export type RouteDay = DayState & { route_id: string; service_date: string };

/** A booking exactly as it is stored: trips as rows, nothing derived. Both stores hydrate into this. */
/** Stored, `ovn_of` is the outbound trip's id rather than its index, so it survives a reorder. */
export type StoredTrip = TripDetails & { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxRow[]; charter_boat_id?: string; lock_draws: LockDraw[]; ovn_leg: boolean; ovn_of?: string };
export type StoredBooking = Omit<Booking, 'trips' | 'route_id' | 'service_date' | 'booking_mode' | 'pax' | 'allocated_pax'> & { trips: StoredTrip[] };

/**
 * The wire shape of a stored booking.
 *
 * Every derived field is computed here and nowhere else — pax totals, the first trip's route and
 * date, and the seats the booking is holding. Deriving them in SQL for one store and in JavaScript
 * for the other is how the two drift, so the SQL side returns rows and calls this.
 */
type BookingCursor = { created_at: string; id: string };
export const encodeBookingCursor = (booking: { created_at: string; id: string }): string => Buffer.from(JSON.stringify({ created_at: booking.created_at, id: booking.id }), 'utf8').toString('base64url');
export const decodeBookingCursor = (value: string): BookingCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<BookingCursor>;
    if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { created_at: parsed.created_at, id: parsed.id };
  } catch { return fail('Invalid cursor', 400); }
};

export function bookingView(stored: StoredBooking): Booking {
  const trips = stored.trips.map(({ ovn_of, ...trip }): BookingTrip => ({
    ...trip, pax: formatPaxGrid(trip.pax), pax_total: paxTotal(trip.pax), lock_draws: Object.fromEntries(trip.lock_draws.map((draw) => [draw.lock_id, draw.qty])),
    ...ovnOfIndex(stored.trips, ovn_of),
  }));
  const pax = trips.reduce((sum, trip) => sum + trip.pax_total, 0);
  const first = stored.trips[0];
  const seats = stored.trips.filter((trip) => trip.booking_mode !== 'charter').reduce((sum, trip) => sum + paxTotal(trip.pax), 0);
  return { ...stored, trips, route_id: first?.route_id ?? '', service_date: first?.service_date ?? '', booking_mode: first?.booking_mode, pax, allocated_pax: holdsSeats(stored.status) ? seats : 0 };
}

const fail = (message: string, statusCode: number): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };

/** A stored `ovn_of` id as the index the API speaks, or nothing when the trip has none. */
const ovnOfIndex = (trips: readonly StoredTrip[], id: string | undefined): { ovn_of?: number } => {
  const index = id === undefined ? -1 : trips.findIndex((trip) => trip.id === id);
  return index < 0 ? {} : { ovn_of: index };
};

/**
 * The rules an itinerary must meet as a whole, checked whenever a client sends `trips`.
 *
 * - One trip per route per day. The van board, the manifest and every day-of-operations screen
 *   address a booking's passengers by route and day; a second trip on the same departure would be
 *   a second row nobody can tell apart from the first. Send one trip with the combined pax.
 * - Overnight trips follow legacy's booking screen (`bkV2CreateOvnReturnLeg`): an outbound
 *   `ovn: 'return'` names the day it comes back, and its return leg is a seat trip on that route and
 *   that day, pointing back at it with `ovn_of`.
 *
 * Not applied to an amendment that leaves the trips alone, so a booking imported before these rules
 * existed can still have its header edited.
 */
export function assertItinerary(trips: readonly BookingTripInput[]): void {
  const seen = new Map<string, number>();
  trips.forEach((trip, index) => {
    const label = `trips[${index}]`;
    const key = `${trip.route_id} ${trip.service_date}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) fail(`${label} repeats trips[${earlier}]: one trip per route per day (${trip.route_id} on ${trip.service_date})`, 400);
    seen.set(key, index);

    if (trip.ovn === 'return' && trip.ovn_return_date === undefined) fail(`${label}.ovn_return_date is required when ovn is return`, 400);
    if (trip.ovn !== 'return' && trip.ovn_return_date !== undefined) fail(`${label}.ovn_return_date applies only when ovn is return`, 400);
    if (trip.ovn_return_date !== undefined && trip.ovn_return_date <= trip.service_date) fail(`${label}.ovn_return_date must be after the trip's date`, 400);

    if (!trip.ovn_leg) {
      if (trip.ovn_of !== undefined) fail(`${label}.ovn_of applies only to a return leg (ovn_leg)`, 400);
      return;
    }
    if (trip.ovn !== undefined) fail(`${label} is a return leg and cannot itself be an overnight outbound`, 400);
    if (trip.booking_mode === 'charter') fail(`${label} is a return leg and must be a seat trip`, 400);
    if (trip.ovn_of === undefined) fail(`${label}.ovn_of is required on a return leg`, 400);
    const outbound = trip.ovn_of === index ? undefined : trips[trip.ovn_of as number];
    if (!outbound) fail(`${label}.ovn_of must be the index of another trip in this list`, 400);
    if (outbound!.ovn !== 'return') fail(`${label}.ovn_of must point at a trip with ovn return`, 400);
    if (outbound!.route_id !== trip.route_id || outbound!.ovn_return_date !== trip.service_date) {
      fail(`${label} must be on its outbound's route (${outbound!.route_id}) and return date (${outbound!.ovn_return_date})`, 400);
    }
  });
}

/** What a set of trips asks of each route/day, so two trips on one day are weighed together. */
export function demandByDay(trips: readonly BookingTripInput[]): DayDemand[] {
  const days = new Map<string, DayDemand>();
  for (const trip of trips) {
    const key = `${trip.route_id}\u0000${trip.service_date}`;
    const day: DayDemand = days.get(key) ?? { route_id: trip.route_id, service_date: trip.service_date, seat: 0, draws: new Map(), charters: [] };
    if (trip.booking_mode === 'charter') day.charters.push({ boat_id: trip.charter_boat_id, pax: paxTotal(trip.pax) });
    else day.seat += paxTotal(trip.pax);
    for (const draw of trip.lock_draws ?? []) day.draws.set(draw.lock_id, (day.draws.get(draw.lock_id) ?? 0) + draw.qty);
    days.set(key, day);
  }
  return [...days.values()];
}

/** Seats each lock has given to bookings that hold seats, the booking being edited aside. */
export function drawnByLock(bookings: Iterable<StoredBooking>, exclude: Exclusion = {}): Map<string, number> {
  const drawn = new Map<string, number>();
  for (const booking of bookings) {
    if (booking.id === exclude.bookingId || !holdsSeats(booking.status)) continue;
    for (const trip of booking.trips) for (const draw of trip.lock_draws) drawn.set(draw.lock_id, (drawn.get(draw.lock_id) ?? 0) + draw.qty);
  }
  return drawn;
}

/** A small serialized in-memory unit of work. Replace this adapter with a DB transaction in production. */
export class OperationsStore {
  private deployments: Deployment[] = [];
  private bookings = new Map<string, StoredBooking>();
  private locks = new Map<string, SeatLock>();
  private tail: Promise<void> = Promise.resolve();
  /** Reference data. Empty unless seeded: with no database there is no catalogue to read. */
  private catalogue: { routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[]; boats: Boat[]; boatOverrides: BoatCapacityOverride[] } =
    { routes: [], seasons: [], overrides: [], boats: [], boatOverrides: [] };

  /** Agents and what they point at. Empty unless seeded: a PostgreSQL deployment gets these from the import. */
  private directory: { markets: Market[]; sales: SalesPerson[]; agents: StoredAgent[]; activity: Map<string, StoredActivity[]> } =
    { markets: [], sales: [], agents: [], activity: new Map() };

  /**
   * Loads agents, markets, salespeople and activity, as `import-legacy.ts` does for PostgreSQL.
   * Activity is given oldest first; its position is what orders two entries at the same instant.
   */
  seedAgents(data: Partial<{ markets: Market[]; sales: SalesPerson[]; agents: StoredAgent[]; activity: Record<string, AgentActivity[]> }>): void {
    if (data.markets) this.directory.markets = data.markets.map((market) => ({ ...market, subs: [...market.subs] }));
    if (data.sales) this.directory.sales = data.sales.map((person) => ({ ...person }));
    if (data.agents) this.directory.agents = data.agents.map((agent) => ({ ...agent, programs: agent.programs.map((program) => ({ ...program })) }));
    if (data.activity) {
      this.directory.activity = new Map(Object.entries(data.activity).map(([agentId, entries]) =>
        [agentId, entries.map((entry, seq) => ({ ...entry, at: new Date(entry.at).toISOString(), seq }))]));
    }
  }
  listMarkets(): Market[] { return sortMarkets(this.directory.markets).map((market) => ({ ...market, subs: [...market.subs] })); }
  listSalesPeople(): SalesPerson[] { return sortSalesPeople(this.directory.sales).map((person) => ({ ...person })); }
  listAgents(query: AgentListQuery): AgentSummary[] {
    return selectAgents(this.directory.agents, this.directory.markets, this.directory.sales, query).map(agentSummary);
  }
  agent(id: string): Agent | undefined { const found = this.directory.agents.find((agent) => agent.id === id); return found && agentView(found); }
  /** Undefined for an unknown agent, so the route can answer 404 rather than an empty log. */
  agentActivity(id: string, limit: number): AgentActivity[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === id)) return undefined;
    return latestActivity(this.directory.activity.get(id) ?? [], limit);
  }

  /** Loads reference data that a PostgreSQL deployment gets from migrations instead. */
  seedCatalogue(catalogue: Partial<{ routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[]; boats: Boat[]; boatOverrides: BoatCapacityOverride[] }>): void {
    if (catalogue.routes) this.catalogue.routes = catalogue.routes.map((route) => ({ ...route }));
    if (catalogue.seasons) this.catalogue.seasons = catalogue.seasons.map((season) => ({ ...season }));
    if (catalogue.overrides) this.catalogue.overrides = catalogue.overrides.map((override) => ({ ...override }));
    if (catalogue.boats) this.catalogue.boats = catalogue.boats.map((boat) => ({ ...boat }));
    if (catalogue.boatOverrides) this.catalogue.boatOverrides = catalogue.boatOverrides.map((override) => ({ ...override }));
  }
  private boatOverride(boatId: string, serviceDate: string): number | undefined {
    return this.catalogue.boatOverrides.find((o) => o.boat_id === boatId && o.service_date === serviceDate)?.capacity;
  }
  listRoutes(): Route[] { return this.catalogue.routes.map((route) => ({ ...route })); }
  /** Empty unless seeded, like the rest of the catalogue: with no database there is nothing to read. */
  listBoats(): Boat[] { return this.catalogue.boats.map((boat) => ({ ...boat })); }
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

  /** One route's day, with per-boat and per-lock detail. The rules are `dayCapacity`'s; this only gathers rows. */
  day(routeId: string, serviceDate: string, exclude: Exclusion = {}): DayState {
    const deployments = this.deployments
      .filter((d) => d.route_id === routeId && d.service_date === serviceDate)
      .map((d) => ({ boat_id: d.boat_id, capacity: d.capacity, license_pax: d.license_pax, override_capacity: this.boatOverride(d.boat_id, serviceDate) }));
    const trips: HeldTrip[] = [];
    for (const booking of this.bookings.values()) {
      if (booking.id === exclude.bookingId || !holdsSeats(booking.status)) continue;
      for (const trip of booking.trips) {
        if (trip.route_id !== routeId || trip.service_date !== serviceDate) continue;
        trips.push({ booking_mode: trip.booking_mode, pax: paxTotal(trip.pax), charter_boat_id: trip.charter_boat_id });
      }
    }
    const drawn = drawnByLock(this.bookings.values(), exclude);
    const locks = [...this.locks.values()]
      .filter((l) => l.route_id === routeId && l.service_date === serviceDate && l.status === 'active' && l.id !== exclude.lockId)
      .map((l) => ({ id: l.id, pax: l.pax, drawn: drawn.get(l.id) ?? 0 }));
    return dayCapacity(deployments, trips, locks);
  }

  capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Capacity {
    return capacityNumbers(this.day(routeId, serviceDate, exclude));
  }

  /** `day` for every route in `routeIds` on every date in `from..to`: date first, then routes in the order given. */
  dayRange(routeIds: readonly string[], from: string, to: string, exclude: Exclusion = {}): RouteDay[] {
    const days: RouteDay[] = [];
    for (const date of eachDate(from, to)) for (const routeId of routeIds) days.push({ route_id: routeId, service_date: date, ...this.day(routeId, date, exclude) });
    return days;
  }

  /** Weighs every day a booking touches, so a multi-day booking is refused as a whole or not at all. */
  private assertTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}): void {
    for (const demand of demandByDay(trips)) assertDayFits(this.day(demand.route_id, demand.service_date, exclude), demand);
  }

  private lockView(lock: SeatLock): SeatLock {
    return { ...lock, drawn_pax: drawnByLock(this.bookings.values()).get(lock.id) ?? 0 };
  }

  /**
   * The licence is resolved once, here, from the boat catalogue when the caller does not supply it.
   * Reading it at capacity time instead would mean the seat pool answered differently depending on
   * whether a catalogue happened to be loaded; resolved on write, a deployment carries its own
   * ceiling and both stores compute from the same row.
   */
  createDeployment(input: Deployment): Deployment {
    const boat = this.catalogue.boats.find((b) => b.id === input.boat_id);
    const deployment: Deployment = { ...input, license_pax: input.license_pax ?? boat?.license_pax };
    const existing = this.deployments.findIndex((d) => d.boat_id === input.boat_id && d.service_date === input.service_date);
    if (existing >= 0) this.deployments[existing] = deployment;
    else this.deployments.push(deployment);
    return { ...deployment };
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

  /**
   * With no catalogue seeded there is nothing to validate against, so an unseeded in-process store
   * accepts any route. A PostgreSQL deployment always has a catalogue and always enforces this.
   */
  private assertRoutes(trips: readonly BookingTripInput[]): void {
    if (this.catalogue.routes.length > 0) assertKnownRoutes(new Set(this.catalogue.routes.map((route) => route.id)), trips);
    assertKnownLocks(new Set(this.locks.keys()), trips);
  }

  createBooking(input: BookingInput): Booking {
    const status = input.status ?? 'confirmed';
    const planned = planTrips([], input.trips, () => this.id('trip'));
    this.assertRoutes(input.trips);
    // A booking created in a status that releases seats — a rejection being recorded, a cancelled
    // import — reserves nothing, so a full day must not stop it being written down.
    if (holdsSeats(status)) this.assertTrips(input.trips);
    const now = this.now();
    const id = this.id('booking');
    // The header is flattened onto the booking, not nested under a `header` key: these are columns
    // in PostgreSQL, and a store that held them one level down would answer a different shape.
    const { trips, header, passengers, ...rest } = input;
    const booking: StoredBooking = { ...rest, ...header, id, status, created_at: now, updated_at: now, trips: planned, passengers: withSeq(passengers ?? []) };
    this.bookings.set(id, booking);
    return this.view(booking);
  }

  listBookings(query: BookingListQuery): BookingPage {
    const cursor = query.cursor ? decodeBookingCursor(query.cursor) : undefined;
    // The page order, and "comes after the cursor" read in that same order, whichever direction.
    const direction = query.order === 'desc' ? -1 : 1;
    const compare = (a: { created_at: string; id: string }, b: { created_at: string; id: string }): number =>
      direction * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const matches = [...this.bookings.values()]
      .filter((b) => !query.agentId || b.agent_id === query.agentId)
      .filter((b) => b.trips.some((t) => (!query.routeId || t.route_id === query.routeId)
        && (!query.serviceDate || t.service_date === query.serviceDate)
        && (!query.from || t.service_date >= query.from)
        && (!query.to || t.service_date <= query.to)))
      .sort(compare)
      .filter((b) => !cursor || compare(b, cursor) > 0);
    const page = matches.slice(0, query.limit);
    const hasMore = matches.length > query.limit;
    return { bookings: page.map((booking) => this.view(booking)), ...(hasMore ? { next_cursor: encodeBookingCursor(page[page.length - 1]) } : {}) };
  }
  booking(id: string): Booking | undefined { const value = this.bookings.get(id); return value && this.view(value); }

  amendBooking(id: string, changes: BookingChanges): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const replacement = nextTrips(booking.trips, changes);
    const planned = planTrips(booking.trips, replacement, () => this.id('trip'));
    const status = changes.status ?? booking.status;
    this.assertRoutes(replacement);
    if (claimsSeats(booking.status, status, tripsChanged(booking.trips, replacement))) this.assertTrips(replacement, { bookingId: id });
    booking.trips = planned;
    booking.status = status;
    // Applied after the capacity check, so a refused amendment leaves the header as it was too.
    if (changes.header) applyBookingHeader(booking as Record<string, unknown>, changes.header);
    if (changes.passengers) booking.passengers = withSeq(changes.passengers);
    booking.updated_at = this.now();
    return this.view(booking);
  }

  cancelBooking(id: string, reason?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (booking.status !== 'cancelled') Object.assign(booking, { status: 'cancelled', cancellation_reason: reason, updated_at: this.now() });
    return this.view(booking);
  }

  partialCancel(id: string, paxToCancel: number): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    booking.trips = planTrips(booking.trips, partialCancelTrips(booking.trips, booking.status, paxToCancel), () => this.id('trip'));
    booking.updated_at = this.now();
    return this.view(booking);
  }

  createLock(input: Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'>): SeatLock {
    assertLockFits(this.day(input.route_id, input.service_date), input.pax, 0);
    const now = this.now();
    const lock: SeatLock = { ...input, id: this.id('lock'), status: 'active', created_at: now, updated_at: now };
    this.locks.set(lock.id, lock);
    return this.lockView(lock);
  }
  listLocks(routeId?: string, serviceDate?: string): SeatLock[] {
    return [...this.locks.values()].filter((l) => (!routeId || l.route_id === routeId) && (!serviceDate || l.service_date === serviceDate)).map((l) => this.lockView(l));
  }
  amendLock(id: string, changes: Partial<Pick<SeatLock, 'pax' | 'agent_id'>>): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    const pax = typeof changes.pax === 'number' ? changes.pax : lock.pax;
    if (lock.status === 'active' && pax !== lock.pax) {
      assertLockFits(this.day(lock.route_id, lock.service_date, { lockId: id }), pax, drawnByLock(this.bookings.values()).get(id) ?? 0);
      lock.pax = pax;
    }
    Object.assign(lock, changes, { pax, updated_at: this.now() });
    return this.lockView(lock);
  }
  releaseLock(id: string): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    if (lock.status === 'active') Object.assign(lock, { status: 'released', released_at: this.now(), updated_at: this.now() });
    return this.lockView(lock);
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
  if (changes.route_id === undefined && changes.service_date === undefined && changes.pax === undefined) return current.map((trip) => asInput(trip, current));
  const trip = onlyTrip(current, 'confirmed', 'Amend a multi-trip booking by sending trips');
  const route_id = changes.route_id ?? trip.route_id;
  const service_date = changes.service_date ?? trip.service_date;
  const pax = changes.pax === undefined ? trip.pax.map((row) => ({ ...row })) : retargetPax(trip.pax, changes.pax);
  // A lock belongs to one departure, so moving the trip leaves its draws behind and the moved trip
  // takes general seats. A caller drawing on a lock on the new day sends `trips`.
  const moved = route_id !== trip.route_id || service_date !== trip.service_date;
  const next = [{ ...asInput(trip, current), route_id, service_date, pax, lock_draws: moved ? [] : clampDraws(trip.lock_draws, paxTotal(pax)) }];
  // Moving an overnight outbound past its return date is refused here rather than by the database.
  if (moved) assertItinerary(next);
  return next;
}

/** The input a stored trip would have come from, id included, so an edit derived from it stays that trip. */
const asInput = (trip: StoredTrip, all: readonly StoredTrip[]): BookingTripInput => {
  const { id, route_id, service_date, booking_mode, charter_boat_id, zone, pickup_time, ovn, ovn_return_date, ovn_leg, ovn_of } = trip;
  return {
    id, route_id, service_date, booking_mode, pax: trip.pax.map((row) => ({ ...row })),
    ...(charter_boat_id ? { charter_boat_id } : {}),
    lock_draws: trip.lock_draws.map((draw) => ({ ...draw })),
    ...tripDetails({ zone, pickup_time, ovn, ovn_return_date, ovn_leg }),
    ...ovnOfIndex(all, ovn_of),
  };
};

/** The pickup and overnight fields with the unset ones left out, so both stores return the same keys. */
const tripDetails = (trip: TripDetails): TripDetails => ({
  ...(trip.zone ? { zone: trip.zone } : {}),
  ...(trip.pickup_time ? { pickup_time: trip.pickup_time } : {}),
  ...(trip.ovn ? { ovn: trip.ovn } : {}),
  ...(trip.ovn_return_date ? { ovn_return_date: trip.ovn_return_date } : {}),
  ...(trip.ovn_leg ? { ovn_leg: true } : {}),
});

/**
 * The itinerary as it will be stored: each trip with its id and its position.
 *
 * A trip naming an `id` is that stored trip, edited in place; one without is new and gets
 * `newId()`. A stored trip the list does not mention is removed. Ids are what day-of-operations
 * rows hang off, so they must survive every edit that keeps the trip — a position-derived id would
 * renumber the second trip when the first is removed. New ids are never positional for the same
 * reason: a fresh trip must not inherit an id a removed one had.
 *
 * An id this booking does not hold, or one named twice, is refused rather than treated as new:
 * either is a client working from a stale or mangled copy, and guessing would move the wrong trip.
 *
 * A trip without an id is matched on route and day to a stored trip no other trip claimed by id,
 * so a client that never echoes ids still keeps them on every edit that does not move a trip. That
 * match is unambiguous only because `assertItinerary` allows one trip per route per day. With an id
 * the id wins, which is how a trip is moved to another day and stays the same trip.
 */
export function planTrips(current: readonly StoredTrip[], next: readonly BookingTripInput[], newId: () => string): StoredTrip[] {
  const held = new Set(current.map((trip) => trip.id));
  const claimed = new Set<string>();
  next.forEach((trip, index) => {
    if (trip.id === undefined) return;
    if (!held.has(trip.id)) fail(`trips[${index}].id ${trip.id} is not a trip of this booking`, 400);
    if (claimed.has(trip.id)) fail(`trips[${index}].id ${trip.id} appears more than once`, 400);
    claimed.add(trip.id);
  });
  const byDay = (trip: BookingTripInput): string | undefined => {
    const match = current.find((stored) => !claimed.has(stored.id) && stored.route_id === trip.route_id && stored.service_date === trip.service_date);
    if (match) claimed.add(match.id);
    return match?.id;
  };
  // Ids first, so a leg's `ovn_of` index can become its outbound's id whichever comes first.
  const ids = next.map((trip) => trip.id ?? byDay(trip) ?? newId());
  return next.map((trip, seq) => {
    const charter = trip.booking_mode === 'charter';
    return {
      id: ids[seq], seq, route_id: trip.route_id, service_date: trip.service_date, booking_mode: charter ? 'charter' : 'seat', pax: trip.pax.map((row) => ({ ...row })),
      ...(charter && trip.charter_boat_id ? { charter_boat_id: trip.charter_boat_id } : {}),
      lock_draws: charter ? [] : sortedDraws(trip.lock_draws ?? []),
      ...tripDetails(trip), ovn_leg: trip.ovn_leg === true,
      ...(trip.ovn_of === undefined || ids[trip.ovn_of] === undefined ? {} : { ovn_of: ids[trip.ovn_of] }),
    };
  });
}

/**
 * Kept trips whose route or day changed. Their day-of-operations data belonged to the old
 * departure — the van that was booked to collect them then — so it is cleared, as legacy's
 * `bkOpsClear` does when a trip's date moves. The trip itself, and its id, stay.
 */
export function movedTripIds(current: readonly StoredTrip[], planned: readonly StoredTrip[]): string[] {
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.filter((trip) => {
    const old = before.get(trip.id);
    return old !== undefined && (old.route_id !== trip.route_id || old.service_date !== trip.service_date);
  }).map((trip) => trip.id);
}

const sortedDraws = (draws: readonly LockDraw[]): LockDraw[] => draws.map((draw) => ({ ...draw })).sort((a, b) => a.lock_id.localeCompare(b.lock_id));

/**
 * Draws cut down to fit a smaller head count. General seats go first, lock seats only once those
 * are gone: which passengers were dropped is not recorded, and keeping the lock seats used is the
 * reading that never hands an agent back seats they had already sold.
 */
export function clampDraws(draws: readonly LockDraw[], pax: number): LockDraw[] {
  let left = pax;
  const kept: LockDraw[] = [];
  for (const draw of sortedDraws(draws)) {
    const qty = Math.min(draw.qty, left);
    if (qty > 0) kept.push({ lock_id: draw.lock_id, qty });
    left -= qty;
  }
  return kept;
}

/**
 * Cancelling a count rather than named passengers. Only a single-departure booking can do this: on a
 * multi-trip booking a bare number does not say which day loses the seats, and `reducePax` decides
 * which cells shrink. A caller that knows both should amend the trips instead.
 */
export function partialCancelTrips(trips: readonly StoredTrip[], status: BookingStatus, count: number): BookingTripInput[] {
  const trip = onlyTrip(trips, status, 'Partial-cancel a multi-trip booking by sending trips');
  const total = paxTotal(trip.pax);
  if (count > total) fail('Cannot cancel more passengers than the active booking', 400);
  return [{ ...asInput(trip, trips), pax: retargetPax(trip.pax, total - count), lock_draws: clampDraws(trip.lock_draws, total - count) }];
}

function onlyTrip(trips: readonly StoredTrip[], status: BookingStatus, message: string): StoredTrip {
  if (!holdsSeats(status)) fail('Cannot cancel more passengers than the active booking', 400);
  if (trips.length !== 1) fail(message, 400);
  return trips[0];
}

const drawsKey = (draws: readonly LockDraw[] = []): string => sortedDraws(draws).map((draw) => `${draw.lock_id}:${draw.qty}`).join(',');

/** Whether an amendment moves seats at all; an unchanged itinerary must not be re-checked against the pool. */
export const tripsChanged = (current: readonly StoredTrip[], next: readonly BookingTripInput[]): boolean =>
  current.length !== next.length || current.some((trip, index) => trip.route_id !== next[index].route_id || trip.service_date !== next[index].service_date
    || paxTotal(trip.pax) !== paxTotal(next[index].pax) || trip.booking_mode !== (next[index].booking_mode === 'charter' ? 'charter' : 'seat')
    || (trip.charter_boat_id ?? '') !== (next[index].charter_boat_id ?? '') || drawsKey(trip.lock_draws) !== drawsKey(next[index].lock_draws));

/**
 * Trip routes that are not in the catalogue.
 *
 * The database has a foreign key for this, but a constraint violation reaches the caller as a 500
 * naming a constraint. Checking up front is what turns it into a 400 naming the route, and putting
 * the check here is what stops the two stores from wording it differently.
 */
export function unknownRoutes(known: ReadonlySet<string>, trips: readonly BookingTripInput[]): string[] {
  return [...new Set(trips.map((trip) => trip.route_id).filter((id) => !known.has(id)))];
}

export function assertKnownRoutes(known: ReadonlySet<string>, trips: readonly BookingTripInput[]): void {
  const missing = unknownRoutes(known, trips);
  if (missing.length > 0) fail(`Unknown route: ${missing.join(', ')}`, 400);
}

/** Every lock a draw names. Checked even when no seats are claimed, so a quote cannot name a lock that does not exist. */
export const drawnLockIds = (trips: readonly BookingTripInput[]): string[] => [...new Set(trips.flatMap((trip) => (trip.lock_draws ?? []).map((draw) => draw.lock_id)))];

export function assertKnownLocks(known: ReadonlySet<string>, trips: readonly BookingTripInput[]): void {
  const missing = drawnLockIds(trips).filter((id) => !known.has(id));
  if (missing.length > 0) fail(`Unknown seat lock: ${missing.join(', ')}`, 400);
}

/**
 * Whether an amendment asks the pool for seats it is not already holding.
 *
 * Two ways that happens: the itinerary moved while the booking was holding, or the status crossed
 * from releasing to holding — a quote being confirmed asks for its seats for the first time, and a
 * day that filled up in the meantime must be allowed to refuse it. An amendment that only shrinks
 * the booking, or leaves a released booking released, is never checked.
 */
export const claimsSeats = (from: BookingStatus, to: BookingStatus, tripsMoved: boolean): boolean =>
  holdsSeats(to) && (tripsMoved || !holdsSeats(from));
