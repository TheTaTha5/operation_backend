import { applyCalendarChange, assertCloseAllowed, assertRoutesOpen, eachDate, isLegacyB2C, routeCalendar, type CalendarChange, type CalendarHold, type Route, type RouteDate, type RouteDayOverride, type RouteSeason } from './calendar.js';
import { formatPaxGrid, paxKey, paxTotal, retargetPax, type PaxGrid, type PaxRow } from './pax.js';
import { holdsSeats, type BookingStatus } from './booking-status.js';
import { assertDayFits, assertLockFits, capacityNumbers, dayCapacity, licenceShortfall, weighDay, type Capacity, type DayDemand, type DayState, type HeldTrip } from './capacity.js';
import { applyBookingHeader, type BookingHeader, type BookingHeaderPatch } from './booking-header.js';
import { withSeq, type BookingPassenger, type BookingPassengerInput } from './booking-passengers.js';
import type { BookingAddOn, BookingAddOnInput } from './booking-addons.js';
import type { BookingAdjustment, BookingAdjustmentInput } from './booking-adjustments.js';
import {
  assertEditable, assertOpen, assertRestorable, createdLine, editedLine, movedLine, partialCancelLine, partialCancelRecord, partialCountLine, planCancel, planRescheduleRecord,
  confirmationStamp, externalIdTaken, planStatusCommand, refuse, restoredLine, stripServerOwned, totalAfterRefund, type StatusCommand, type StatusCommandRequest,
  type BookingCancellation, type BookingFeeItem, type BookingPartialCancel, type BookingReschedule, type CancelRequest, type HistoryEntry, type HistoryLine,
  type LockShortWarning, type PartialCancelRequest, type RescheduleRequest,
} from './booking-actions.js';
import {
  agentSummary, agentView, latestActivity, selectAgents, sortMarkets, sortSalesPeople,
  type Agent, type AgentActivity, type AgentListQuery, type AgentSummary, type Market, type SalesPerson, type StoredActivity, type StoredAgent,
} from './agents.js';
import {
  addRouteRows, assertOwner, assertRateTypeUnused, assertRouteBlock, generateRateTypeCode, newRateTypeRow, nextRouteSeq, patchedRateTypeRow, rateTypeExists, rateTypeView,
  removeRouteRows, routeRows, selectRateTypes,
  type CatalogueRoute, type RateType, type RateTypeCreate, type RateTypeListQuery, type RateTypePatch, type RateTypeRows, type RateTypeSummary, type RouteBlock,
} from './rate-types.js';
import {
  bookingHoldsSeats, decidedRecord, decideStatus, discountOf, focCountOf, pendingApproval, reweigh, sortApprovalDays,
  type ApprovalDay, type ApprovalKind, type ApprovalWarning, type BookingApproval, type Intent, type NewApproval,
} from './booking-approvals.js';
import { pickupFields, type PickupWindow } from './pickup.js';
import { usernameTaken, type NewUser, type StoredUser, type UserPatch } from './users.js';
import { clearedOnMove, dispatchView, type StoredDispatch, type TripDispatch } from './dispatch.js';
import { applyVanPatch, isEmptyVanDay, nextVanId, sortRanges, sortVans, type StoredVanDay, type Van, type VanInput, type VanPatch, type VanStatusRange, type VanStatusRangeInput } from './vans.js';
import { contractView, selectContracts, type Contract, type ContractListQuery } from './contracts.js';
import type { RateSeason } from './rate-seasons.js';

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
 * The overnight fields are described in migration 015 and checked by `assertItinerary`; the pickup
 * window is `src/domain/pickup.ts`'s.
 */
/** What `priceBooking` priced a booking's trips (by position) and add-ons at (src/domain/pricing.ts). */
export type BookingPrices = { trips: { subtotal: number; rate_type_id: string | null; promo_id: string | null }[]; add_ons: number[] };
export type TripDetails = PickupWindow & { zone?: string; ovn?: OvnMode; ovn_return_date?: string; ovn_leg?: boolean;
  /** Client facts the price reads (migration 032). */
  ovn_charge?: number; charter_price_mode?: 'rate' | 'manual'; charter_price_manual?: number; charter_price_note?: string;
  /** What the trip was priced at (computed by `priceBooking`, migration 032). */
  subtotal?: number; rate_type_id?: string; promo_id?: string;
};
export type OvnMode = 'return' | 'self';
/** `ovn_of` is an index into the same trip list, on input and on the wire. */
export type BookingTripInput = TripDetails & { id?: string; route_id: string; service_date: string; booking_mode?: string; pax: PaxRow[]; charter_boat_id?: string; lock_draws?: LockDraw[]; ovn_of?: number };
export type BookingTrip = TripDetails & { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxGrid; pax_total: number; charter_boat_id?: string; lock_draws: Record<string, number>; ovn_leg: boolean; ovn_of?: number;
  /** Day-of-operations dispatch (src/domain/dispatch.ts): always present, empty when nothing is set. */
  operations: TripDispatch;
};

export type BookingInput = {
  trips: BookingTripInput[];
  /**
   * Which save button: "Save as quote" or "Confirm" (default). The server decides the status from it
   * and the facts (`decideStatus`); a client no longer sends a status.
   */
  intent?: Intent;
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
  /** The add-on list, already parsed by `parseBookingAddOns()`. Defaults to none. */
  add_ons?: BookingAddOnInput[];
  /** Discounts and extras, already parsed by `parseBookingAdjustments()`. Defaults to none. */
  adjustments?: BookingAdjustmentInput[];
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
  /** 1 on create, +1 on every write. Send it back as `If-Match` to refuse a stale save. */
  version: number;
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
  add_ons: BookingAddOn[];
  adjustments: BookingAdjustment[];
  /** Every approval the booking waited for, oldest first. The last `pending` one of a kind is the one waiting. */
  approvals: BookingApproval[];
  /** The current cancellation's category and charge. Absent unless the booking was cancelled with one. */
  cancellation?: BookingCancellation;
  /** Every reschedule, partial cancel and fee item, oldest first. See `booking-actions.ts`. */
  reschedules: BookingReschedule[];
  partial_cancels: BookingPartialCancel[];
  fee_items: BookingFeeItem[];
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
  /** Same rule as `passengers`: present replaces outright, `[]` clears, absent leaves it alone. */
  add_ons?: BookingAddOnInput[];
  /** Same rule again. */
  adjustments?: BookingAdjustmentInput[];
};

export type SeatLock = {
  id: string;
  /** As a booking's: 1 on create, +1 on every change. */
  version: number;
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
  /** Any of these statuses. Absent means every status. */
  statuses?: BookingStatus[];
  /** Already lower-cased: a substring of the id, `voucher_ref` or `lead_pax`, compared lower-cased. */
  q?: string;
  /** Already lower-cased: the whole `voucher_ref`, compared lower-cased. */
  voucherRef?: string;
};

/** `total` counts every booking the filters match, regardless of `cursor` and `limit`. */
export type BookingPage = { bookings: Booking[]; next_cursor?: string; total: number };

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

/** `dispatch` gives each trip's dispatch as a read shows it; without it, every trip's is empty. */
export function bookingView(stored: StoredBooking, dispatch: (trip: StoredTrip) => TripDispatch = () => dispatchView(undefined, new Set())): Booking {
  const trips = stored.trips.map(({ ovn_of, ...trip }): BookingTrip => ({
    ...trip, pax: formatPaxGrid(trip.pax), pax_total: paxTotal(trip.pax), lock_draws: Object.fromEntries(trip.lock_draws.map((draw) => [draw.lock_id, draw.qty])),
    ...ovnOfIndex(stored.trips, ovn_of), operations: dispatch({ ovn_of, ...trip }),
  }));
  const pax = trips.reduce((sum, trip) => sum + trip.pax_total, 0);
  const first = stored.trips[0];
  const seats = stored.trips.filter((trip) => trip.booking_mode !== 'charter').reduce((sum, trip) => sum + paxTotal(trip.pax), 0);
  // Approvals are copied: the store decides them in place, and a view already handed out must not change.
  const approvals = (stored.approvals ?? []).map((approval) => ({ ...approval, days: approval.days.map((day) => ({ ...day })) }));
  return { ...stored, approvals, trips, route_id: first?.route_id ?? '', service_date: first?.service_date ?? '', booking_mode: first?.booking_mode, pax, allocated_pax: bookingHoldsSeats(stored) ? seats : 0 };
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
 *   `ovn: 'return'` names the day it comes back, and its return leg is a trip on that route and that
 *   day, pointing back at it with `ovn_of`. The leg is booked as its outbound is: a seat outbound
 *   comes back on a seat trip; a charter outbound on a charter, of any boat deployed that day
 *   (decided 2026-10-09; legacy builds it on the same boat). The boat is not held on the nights
 *   between.
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
    if (trip.ovn_of === undefined) fail(`${label}.ovn_of is required on a return leg`, 400);
    const outbound = trip.ovn_of === index ? undefined : trips[trip.ovn_of as number];
    if (!outbound) fail(`${label}.ovn_of must be the index of another trip in this list`, 400);
    if (outbound!.ovn !== 'return') fail(`${label}.ovn_of must point at a trip with ovn return`, 400);
    const legMode = trip.booking_mode === 'charter' ? 'charter' : 'seat', outboundMode = outbound!.booking_mode === 'charter' ? 'charter' : 'seat';
    if (legMode !== outboundMode) fail(`${label} is a return leg and must be a ${outboundMode} trip, as its outbound is`, 400);
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
    if (booking.id === exclude.bookingId || !bookingHoldsSeats(booking)) continue;
    for (const trip of booking.trips) for (const draw of trip.lock_draws) drawn.set(draw.lock_id, (drawn.get(draw.lock_id) ?? 0) + draw.qty);
  }
  return drawn;
}

/** A small serialized in-memory unit of work. Replace this adapter with a DB transaction in production. */
export class OperationsStore {
  private deployments: Deployment[] = [];
  private bookings = new Map<string, StoredBooking>();
  private histories = new Map<string, HistoryEntry[]>();
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
  agent(id: string): Agent | undefined { const found = this.directory.agents.find((agent) => agent.id === id); return found && agentView(found, this.seasons.get(id)); }
  /** An agent's rate seasons by `from` (migration 030); undefined for an unknown agent. */
  private seasons = new Map<string, RateSeason[]>();
  rateSeasons(agentId: string): RateSeason[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === agentId)) return undefined;
    return (this.seasons.get(agentId) ?? []).map((season) => ({ ...season }));
  }
  /** Replaces the table and appends `activity` to the agent's log, as legacy's `rtmSave` does. */
  setRateSeasons(agentId: string, seasons: readonly RateSeason[], activity: AgentActivity): RateSeason[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === agentId)) return undefined;
    this.seasons.set(agentId, seasons.map((season) => ({ ...season })));
    const log = this.directory.activity.get(agentId) ?? [];
    log.push({ ...activity, seq: log.reduce((max, entry) => Math.max(max, entry.seq), -1) + 1 });
    this.directory.activity.set(agentId, log);
    return this.rateSeasons(agentId);
  }
  /** Undefined for an unknown agent, so the route can answer 404 rather than an empty log. */
  agentActivity(id: string, limit: number): AgentActivity[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === id)) return undefined;
    return latestActivity(this.directory.activity.get(id) ?? [], limit);
  }

  /**
   * Rate types, held as the same rows PostgreSQL holds (`RateTypeRows`) so both stores hand
   * `rate-types.ts` identical input. Route and owner checks need the catalogue and the salespeople;
   * unseeded, there is nothing to check against and they are skipped, as bookings' routes are.
   */
  private rateTypes = new Map<string, RateTypeRows>();
  private routeCatalogue(): Map<string, CatalogueRoute> | undefined {
    return this.catalogue.routes.length === 0 ? undefined : new Map(this.catalogue.routes.map((route) => [route.id, { id: route.id, pier: route.pier }]));
  }
  private salesIds(): Set<string> | undefined {
    return this.directory.sales.length === 0 ? undefined : new Set(this.directory.sales.map((person) => person.id));
  }
  /** Agents' contracts (migration 029). Empty unless seeded: PostgreSQL gets them from `import:contracts`. */
  private contracts: Contract[] = [];
  seedContracts(contracts: readonly Contract[]): void { this.contracts = contracts.map(contractView); }
  listContracts(query: ContractListQuery): Contract[] { return selectContracts(this.contracts, query).map(contractView); }
  contract(id: string): Contract | undefined { const found = this.contracts.find((c) => c.id === id); return found && contractView(found); }

  /** Staff logins (migration 027), held as the rows PostgreSQL holds. Usernames are unique ignoring case. */
  private users: StoredUser[] = [];
  listUsers(): StoredUser[] { return this.users.map((user) => ({ ...user })).sort((a, b) => a.id - b.id); }
  user(id: number): StoredUser | undefined { const found = this.users.find((user) => user.id === id); return found && { ...found }; }
  userByUsername(username: string): StoredUser | undefined {
    const found = this.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
    return found && { ...found };
  }
  createUser(input: NewUser): StoredUser {
    if (this.userByUsername(input.username)) usernameTaken(input.username);
    const now = this.now();
    const user: StoredUser = { ...input, id: this.users.reduce((max, u) => Math.max(max, u.id), 0) + 1, created_at: now, updated_at: now };
    this.users.push(user);
    return { ...user };
  }
  updateUser(id: number, patch: UserPatch): StoredUser | undefined {
    const index = this.users.findIndex((user) => user.id === id);
    if (index < 0) return undefined;
    this.users[index] = { ...this.users[index], ...patch, updated_at: this.now() };
    return { ...this.users[index] };
  }

  listRateTypes(query: RateTypeListQuery): RateTypeSummary[] { return selectRateTypes([...this.rateTypes.values()], query); }
  rateType(id: string): RateType | undefined { const rows = this.rateTypes.get(id); return rows && rateTypeView(rows); }

  createRateType(input: RateTypeCreate): RateType {
    const catalogue = this.routeCatalogue();
    input.routes.forEach(({ route_id, block }, index) => assertRouteBlock(block, route_id, catalogue, `routes[${index}]`));
    assertOwner(input.header.owner, this.salesIds());
    const codes = new Set([...this.rateTypes.values()].map(({ rate }) => rate.code));
    if (input.header.id !== undefined && this.rateTypes.has(input.header.id)) rateTypeExists('id', input.header.id);
    if (input.header.code !== undefined && codes.has(input.header.code)) rateTypeExists('code', input.header.code);
    const id = input.header.id ?? this.id('rt');
    const rows: RateTypeRows = { rate: newRateTypeRow(input.header, id, input.header.code ?? generateRateTypeCode(input.header.name, codes), this.now()), routes: [], seat: [], charter: [], longtail: [], transfer: [] };
    input.routes.forEach(({ route_id, block }, seq) => addRouteRows(rows, routeRows(id, route_id, seq, block)));
    this.rateTypes.set(id, rows);
    return rateTypeView(rows);
  }

  patchRateType(id: string, patch: RateTypePatch): RateType | undefined {
    const rows = this.rateTypes.get(id);
    if (!rows) return undefined;
    assertOwner(patch.owner, this.salesIds());
    rows.rate = patchedRateTypeRow(rows.rate, patch, this.now());
    return rateTypeView(rows);
  }

  /** Replaces one route's block; a route new to the rate goes after the ones it has. */
  putRateTypeRoute(id: string, routeId: string, block: RouteBlock): RateType | undefined {
    const rows = this.rateTypes.get(id);
    if (!rows) return undefined;
    assertRouteBlock(block, routeId, this.routeCatalogue(), '');
    const seq = rows.routes.find((route) => route.route_id === routeId)?.seq ?? nextRouteSeq(rows.routes);
    removeRouteRows(rows, routeId);
    addRouteRows(rows, routeRows(id, routeId, seq, block));
    rows.rate = { ...rows.rate, updated_at: this.now() };
    return rateTypeView(rows);
  }

  /** Undefined for an unknown rate type, false for a route the rate does not cover. */
  deleteRateTypeRoute(id: string, routeId: string): boolean | undefined {
    const rows = this.rateTypes.get(id);
    if (!rows) return undefined;
    if (!rows.routes.some((route) => route.route_id === routeId)) return false;
    removeRouteRows(rows, routeId);
    rows.rate = { ...rows.rate, updated_at: this.now() };
    return true;
  }

  deleteRateType(id: string): boolean {
    if (!this.rateTypes.has(id)) return false;
    assertRateTypeUnused(id, {
      agents: this.directory.agents.filter((agent) => agent.rate_type_id === id || (this.seasons.get(agent.id) ?? []).some((season) => season.rate_type_id === id)).length,
      bookings: [...this.bookings.values()].filter((booking) => booking.rate_type_ref === id).length,
    });
    this.rateTypes.delete(id);
    return true;
  }

  /** Loads reference data that a PostgreSQL deployment gets from migrations instead. */
  seedCatalogue(catalogue: Partial<{ routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[]; boats: Boat[]; boatOverrides: BoatCapacityOverride[] }>): void {
    // `kind` defaults the way the column does, so both stores list the same route the same way.
    if (catalogue.routes) this.catalogue.routes = catalogue.routes.map((route) => ({ ...route, kind: route.kind ?? 'marine' }));
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

  /**
   * One edit to a route's calendar (`applyCalendarChange`), refused when it would close a day that
   * holds bookings or a boat from `today` on, unless `closeAnyway` (`assertCloseAllowed`). Unseeded,
   * any route id is accepted, as bookings accept any.
   */
  changeCalendar(routeId: string, change: CalendarChange, closeAnyway: boolean, today: string): void {
    if (this.catalogue.routes.length > 0 && !this.catalogue.routes.some((route) => route.id === routeId)) refuse('Route not found', 404);
    const seasons = this.catalogue.seasons.filter((s) => s.route_id === routeId);
    const overrides = this.catalogue.overrides.filter((o) => o.route_id === routeId);
    const next = applyCalendarChange(seasons, overrides, change);
    const holds: CalendarHold[] = [];
    for (const booking of this.bookings.values()) {
      if (!holdsSeats(booking.status)) continue;
      for (const trip of booking.trips) if (trip.route_id === routeId && trip.service_date >= today) holds.push({ service_date: trip.service_date, booking_ref: booking.voucher_ref ?? booking.id });
    }
    for (const d of this.deployments) if (d.route_id === routeId && d.service_date >= today) holds.push({ service_date: d.service_date, boat_id: d.boat_id });
    assertCloseAllowed(routeId, routeCalendar(seasons, overrides), routeCalendar(next.seasons, next.overrides), holds, closeAnyway);
    this.catalogue.seasons = [...this.catalogue.seasons.filter((s) => s.route_id !== routeId), ...next.seasons];
    this.catalogue.overrides = [...this.catalogue.overrides.filter((o) => o.route_id !== routeId), ...next.overrides];
  }
  newSeasonId(): string { return this.id('season'); }

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }

  private now(): string { return new Date().toISOString(); }
  private id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }

  private view(stored: StoredBooking): Booking {
    return bookingView(stored, (trip) => dispatchView(this.dispatch.get(trip.id), this.deployedBoats(trip.route_id, trip.service_date)));
  }
  private deployedBoats(routeId: string, date: string): Set<string> {
    return new Set(this.deployments.filter((d) => d.route_id === routeId && d.service_date === date).map((d) => d.boat_id));
  }

  /** Each trip's dispatch (migration 033), by trip id. */
  private dispatch = new Map<string, StoredDispatch>();
  /**
   * Replaces a booking's trips. As PostgreSQL's `writeTrips`: a removed trip's dispatch goes, a trip
   * moved to another route or day keeps only its pier note (legacy `bkOpsClear`), and a trip whose
   * passengers changed loses its boat split, which no longer adds up.
   */
  private retrip(booking: StoredBooking, planned: StoredTrip[]): void {
    const keep = new Set(planned.map((trip) => trip.id));
    for (const trip of booking.trips) if (!keep.has(trip.id)) this.dispatch.delete(trip.id);
    for (const id of movedTripIds(booking.trips, planned)) { const d = this.dispatch.get(id); if (d) this.dispatch.set(id, clearedOnMove(d)); }
    for (const id of paxChangedTripIds(booking.trips, planned)) { const d = this.dispatch.get(id); if (d) d.boat_splits = []; }
    booking.trips = planned;
  }
  /** The trip, its booking and its dispatch as stored, for a dispatch write; undefined for an unknown trip. */
  tripForDispatch(tripId: string): { booking: Booking; trip: BookingTrip; dispatch: StoredDispatch | undefined; deployedBoats: Set<string> } | undefined {
    for (const stored of this.bookings.values()) {
      const trip = stored.trips.find((t) => t.id === tripId);
      if (trip) {
        const booking = this.view(stored);
        return { booking, trip: booking.trips.find((t) => t.id === tripId)!, dispatch: this.dispatch.get(tripId), deployedBoats: this.deployedBoats(trip.route_id, trip.service_date) };
      }
    }
    return undefined;
  }
  setDispatch(tripId: string, dispatch: StoredDispatch): void { this.dispatch.set(tripId, { ...dispatch, boat_splits: dispatch.boat_splits.map((s) => ({ ...s })) }); }

  // ── Vans and the month matrix (migration 016, slice A3) ──
  private vans = new Map<string, Van>();
  private vanRanges: VanStatusRange[] = [];
  private vanRangeSeq = 0;
  private vanDayRows = new Map<string, StoredVanDay>();
  private copyDay = (d: StoredVanDay): StoredVanDay => ({ ...d, route_ids: [...d.route_ids] });

  listVans(): Van[] { return sortVans([...this.vans.values()]).map((v) => ({ ...v })); }
  van(id: string): Van | undefined { const v = this.vans.get(id); return v && { ...v }; }
  createVan(input: VanInput): Van {
    const van = { id: nextVanId([...this.vans.keys()]), ...input };
    this.vans.set(van.id, van);
    return { ...van };
  }
  updateVan(id: string, patch: VanPatch): Van | undefined {
    const van = this.vans.get(id);
    if (!van) return undefined;
    const next = applyVanPatch(van, patch);
    this.vans.set(id, next);
    return { ...next };
  }
  vanStatusRanges(vanId?: string): VanStatusRange[] { return sortRanges(this.vanRanges.filter((r) => vanId === undefined || r.van_id === vanId)).map((r) => ({ ...r })); }
  addStatusRange(vanId: string, input: VanStatusRangeInput): VanStatusRange {
    const range = { id: ++this.vanRangeSeq, van_id: vanId, ...input };
    this.vanRanges.push(range);
    return { ...range };
  }
  /** Rewrites a range in place, keeping its id and so its place in the order. */
  putStatusRange(range: VanStatusRange): void { this.vanRanges = this.vanRanges.map((r) => (r.id === range.id ? { ...range } : r)); }
  deleteStatusRange(vanId: string, id: number): boolean {
    const before = this.vanRanges.length;
    this.vanRanges = this.vanRanges.filter((r) => !(r.van_id === vanId && r.id === id));
    return this.vanRanges.length < before;
  }
  /** Stored cells between two dates, inclusive. */
  vanDays(from: string, to: string): StoredVanDay[] { return [...this.vanDayRows.values()].filter((d) => d.service_date >= from && d.service_date <= to).map(this.copyDay); }
  vanDay(vanId: string, date: string): StoredVanDay | undefined { const d = this.vanDayRows.get(`${vanId}|${date}`); return d && this.copyDay(d); }
  /** A cell with nothing set is no row at all. */
  setVanDay(day: StoredVanDay): void {
    const key = `${day.van_id}|${day.service_date}`;
    if (isEmptyVanDay(day)) this.vanDayRows.delete(key); else this.vanDayRows.set(key, this.copyDay(day));
  }

  /** One route's day, with per-boat and per-lock detail. The rules are `dayCapacity`'s; this only gathers rows. */
  day(routeId: string, serviceDate: string, exclude: Exclusion = {}): DayState {
    const deployments = this.deployments
      .filter((d) => d.route_id === routeId && d.service_date === serviceDate)
      .map((d) => ({ boat_id: d.boat_id, capacity: d.capacity, license_pax: d.license_pax, override_capacity: this.boatOverride(d.boat_id, serviceDate) }));
    const trips: HeldTrip[] = [];
    for (const booking of this.bookings.values()) {
      if (booking.id === exclude.bookingId || !bookingHoldsSeats(booking)) continue;
      for (const trip of booking.trips) {
        if (trip.route_id !== routeId || trip.service_date !== serviceDate) continue;
        trips.push({ booking_mode: trip.booking_mode, pax: paxTotal(trip.pax), charter_boat_id: trip.charter_boat_id });
      }
    }
    const drawn = drawnByLock(this.bookings.values(), exclude);
    const locks = [...this.locks.values()]
      .filter((l) => l.route_id === routeId && l.service_date === serviceDate && l.status === 'active' && l.id !== exclude.lockId)
      .map((l) => ({ id: l.id, pax: l.pax, drawn: drawn.get(l.id) ?? 0 }));
    return dayCapacity(deployments, trips, locks, this.catalogue.routes.find((route) => route.id === routeId)?.kind);
  }

  /** `assertRoutesOpen` against the seeded calendar. Unseeded, every route runs every day. */
  private assertOpen(trips: readonly RouteDate[]): void {
    if (trips.length === 0) return;
    const names = new Map(this.catalogue.routes.map((route) => [route.id, route.name]));
    assertRoutesOpen(routeCalendar(this.catalogue.seasons, this.catalogue.overrides), trips, names);
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

  createBooking(input: BookingInput, actor?: string): Booking {
    if (input.external_id !== undefined) {
      const taken = [...this.bookings.values()].find((booking) => booking.external_id === input.external_id);
      if (taken) externalIdTaken(input.external_id, taken.id);
    }
    const planned = planTrips([], input.trips, () => this.id('trip'));
    this.assertRoutes(input.trips);
    this.assertOpen(tripsToCheckOpen(input.external_id, [], planned));
    // Weighed first, then decided: the days over the allotment are a fact the status depends on.
    const decision = decideStatus(input.intent ?? 'confirm', {
      focCount: focCountOf(input.trips), focReason: input.header?.foc_reason, discount: discountOf(input.header ?? {}),
      overDays: this.weighTrips(input.trips),
    }, actor);
    const status = decision.status;
    const now = this.now();
    const id = this.id('booking');
    // The header is flattened onto the booking, not nested under a `header` key: these are columns
    // in PostgreSQL, and a store that held them one level down would answer a different shape.
    const { trips, header, passengers, add_ons, adjustments, intent: _intent, ...rest } = input;
    // `booking_data` is what PostgreSQL's create writes: the input's blob if it carries one, otherwise
    // the column's `{}`. Nothing sends one since the blob stopped being written (2026-09-22), so both
    // stores answer `{}` for a new booking rather than one answering `{}` and the other nothing.
    const booking: StoredBooking = {
      ...rest, ...header, ...(status === 'confirmed' ? confirmationStamp(actor, now) : {}),
      booking_data: rest.booking_data ?? {}, id, status, version: 1, created_at: now, updated_at: now, trips: planned,
      passengers: withSeq(passengers ?? []), add_ons: withSeq(add_ons ?? []), adjustments: withSeq(adjustments ?? []), reschedules: [], partial_cancels: [], fee_items: [], approvals: [],
    };
    this.bookings.set(id, booking);
    this.requestApprovals(booking, decision.approvals);
    this.log(id, createdLine(actor));
    for (const line of decision.history) this.log(id, line);
    return this.view(booking);
  }

  /** The days the trips put over the allotment (`weighDay`), after refusing what legacy refuses. */
  private weighTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}): ApprovalDay[] {
    const over: ApprovalDay[] = [];
    for (const demand of demandByDay(trips)) {
      const weight = weighDay(this.day(demand.route_id, demand.service_date, exclude), demand);
      if (weight) over.push({ route_id: demand.route_id, service_date: demand.service_date, ...weight });
    }
    return over;
  }

  /** One approval waits per kind: a new request replaces a pending one of its kind. */
  private requestApprovals(booking: StoredBooking, requests: readonly NewApproval[]): void {
    for (const request of requests) {
      this.replacePending(booking, request.kind);
      booking.approvals.push({
        ...request, days: sortApprovalDays(request.days), status: 'pending', requested_at: this.now(), decided_by: null, decided_at: null, note: null,
      });
    }
  }
  private replacePending(booking: StoredBooking, kind: ApprovalKind): void {
    for (const approval of booking.approvals) if (approval.kind === kind && approval.status === 'pending') approval.status = 'replaced';
  }

  /** Appends one history line. Called after the write it describes, so a refused write leaves none. */
  private log(bookingId: string, entry: HistoryLine): void {
    const lines = this.histories.get(bookingId) ?? [];
    lines.push({ at: this.now(), ...entry });
    this.histories.set(bookingId, lines);
  }
  /** Oldest first. Undefined for an unknown booking, so the route can answer 404 rather than `[]`. */
  bookingHistory(id: string): HistoryEntry[] | undefined {
    if (!this.bookings.has(id)) return undefined;
    return (this.histories.get(id) ?? []).map((entry) => ({ ...entry }));
  }
  /**
   * What `priceBooking` priced each trip and add-on at, written beside them by position, in the
   * create's or amendment's own transaction. The trips themselves are left alone: re-writing them
   * would weigh the seats again.
   */
  setPrices(id: string, prices: BookingPrices): void {
    const booking = this.bookings.get(id);
    if (!booking) return;
    booking.trips.forEach((trip, i) => {
      const p = prices.trips[i];
      if (!p) return;
      trip.subtotal = p.subtotal;
      if (p.rate_type_id) trip.rate_type_id = p.rate_type_id; else delete trip.rate_type_id;
      if (p.promo_id) trip.promo_id = p.promo_id; else delete trip.promo_id;
    });
    booking.add_ons.forEach((addOn, i) => { if (prices.add_ons[i] !== undefined) addOn.amount = prices.add_ons[i]; });
  }

  /** The actor signs every action's write, the way the route stamps it on create and amend. */
  private touch(booking: StoredBooking, actor: string | undefined): void {
    booking.updated_at = this.now();
    booking.version += 1;
    if (actor !== undefined) booking.updated_by = actor;
  }

  listBookings(query: BookingListQuery): BookingPage {
    const cursor = query.cursor ? decodeBookingCursor(query.cursor) : undefined;
    // The page order, and "comes after the cursor" read in that same order, whichever direction.
    const direction = query.order === 'desc' ? -1 : 1;
    const compare = (a: { created_at: string; id: string }, b: { created_at: string; id: string }): number =>
      direction * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const lower = (value: unknown): string => (typeof value === 'string' ? value : '').toLowerCase();
    const filtered = [...this.bookings.values()]
      .filter((b) => !query.agentId || b.agent_id === query.agentId)
      .filter((b) => !query.statuses || query.statuses.includes(b.status))
      .filter((b) => query.voucherRef === undefined || lower(b.voucher_ref) === query.voucherRef)
      .filter((b) => query.q === undefined || [b.id, b.voucher_ref, b.lead_pax].some((field) => lower(field).includes(query.q!)))
      .filter((b) => b.trips.some((t) => (!query.routeId || t.route_id === query.routeId)
        && (!query.serviceDate || t.service_date === query.serviceDate)
        && (!query.from || t.service_date >= query.from)
        && (!query.to || t.service_date <= query.to)));
    const matches = filtered.sort(compare).filter((b) => !cursor || compare(b, cursor) > 0);
    const page = matches.slice(0, query.limit);
    const hasMore = matches.length > query.limit;
    return { bookings: page.map((booking) => this.view(booking)), ...(hasMore ? { next_cursor: encodeBookingCursor(page[page.length - 1]) } : {}), total: filtered.length };
  }
  booking(id: string): Booking | undefined { const value = this.bookings.get(id); return value && this.view(value); }

  /** `entry` replaces the default `Edited · …` line, for the older reschedule body that comes through here. */
  amendBooking(id: string, requested: BookingChanges, actor?: string, entry?: HistoryLine): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    assertEditable(booking.status);
    const changes = stripServerOwned(requested, booking as unknown as Record<string, unknown> & { status: BookingStatus });
    const replacement = nextTrips(booking.trips, changes);
    const planned = planTrips(booking.trips, replacement, () => this.id('trip'));
    this.assertRoutes(replacement);
    this.assertOpen(tripsToCheckOpen(booking.external_id, booking.trips, planned));
    const reweighed = reweighs(booking, changes, claimsMoreSeats(booking.trips, planned))
      ? reweigh(booking, this.weighTrips(replacement, { bookingId: id }), actor) : undefined;
    const line = entry ?? editedLine(actor, changes, booking.status);
    this.retrip(booking, planned);
    if (reweighed) {
      if (reweighed.request) this.requestApprovals(booking, [reweighed.request]);
      else this.replacePending(booking, 'approval');
      if (reweighed.status === 'confirmed' && !booking.confirmed_at) Object.assign(booking, confirmationStamp(actor, this.now()));
      booking.status = reweighed.status;
    }
    // Applied after the capacity check, so a refused amendment leaves the header as it was too.
    if (changes.header) applyBookingHeader(booking as Record<string, unknown>, changes.header);
    if (changes.passengers) booking.passengers = withSeq(changes.passengers);
    if (changes.add_ons) booking.add_ons = withSeq(changes.add_ons);
    if (changes.adjustments) booking.adjustments = withSeq(changes.adjustments);
    booking.updated_at = this.now();
    booking.version += 1;
    this.log(id, line);
    for (const extra of reweighed?.history ?? []) this.log(id, extra);
    return this.view(booking);
  }

  cancelBooking(id: string, request: CancelRequest, actor?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const plan = planCancel(booking, request, actor);
    booking.status = 'cancelled';
    booking.cancellation_reason = plan.cancellation_reason ?? undefined;
    if (plan.record) booking.cancellation = { ...plan.record, at: this.now() };
    else delete booking.cancellation;
    this.touch(booking, actor);
    this.log(id, plan.history);
    return this.view(booking);
  }

  /**
   * `/confirm`, `/approve`, `/reject`, `/cancel-weather`: the rules are `planStatusCommand`'s. Only
   * approving a booking that waited over the allotment gives it seats (`plan.claims`), and legacy
   * grants those even past the boats' registered seats, with a warning to add a boat: so does this.
   */
  changeBookingStatus(
    id: string, command: StatusCommand, request: StatusCommandRequest, actor?: string,
  ): { booking: Booking; warnings: ApprovalWarning[] } | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const plan = planStatusCommand(command, booking, request, actor);
    const warnings = plan.claims ? licenceWarnings(booking.trips, (routeId, date) => this.day(routeId, date, { bookingId: id })) : [];
    const now = this.now();
    if (plan.decide) {
      const pending = pendingApproval(booking.approvals, plan.decide.kind);
      if (pending) Object.assign(pending, { status: plan.decide.status, decided_by: actor ?? null, decided_at: now, note: plan.decide.note });
      else booking.approvals.push(decidedRecord(plan.decide.kind, plan.decide.status, plan.status, focCountOf(booking.trips), actor, now, plan.decide.note));
    }
    this.requestApprovals(booking, plan.request);
    booking.status = plan.status;
    if (plan.confirms) {
      booking.confirmed_at = now;
      if (actor === undefined) delete booking.confirmed_by; else booking.confirmed_by = actor;
    }
    if (plan.cancellation_reason !== undefined) booking.cancellation_reason = plan.cancellation_reason;
    this.touch(booking, actor);
    for (const line of plan.history) this.log(id, line);
    return { booking: this.view(booking), warnings };
  }

  /** Back to `confirmed`, lock seats redrawn as far as the locks allow. See `restoreTrips`. */
  restoreBooking(id: string, actor?: string): { booking: Booking; warnings: LockShortWarning[] } | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    assertRestorable(booking.status);
    const days = new Map(booking.trips.map((trip) => [dayKey(trip.route_id, trip.service_date), this.day(trip.route_id, trip.service_date, { bookingId: id })]));
    const { trips, warnings } = restoreTrips(booking.trips, days);
    this.assertOpen(booking.trips);
    this.assertTrips(trips, { bookingId: id });
    this.retrip(booking, planTrips(booking.trips, trips, () => this.id('trip')));
    booking.status = 'confirmed';
    delete booking.cancellation;
    delete booking.cancellation_reason;
    this.touch(booking, actor);
    this.log(id, restoredLine(actor, warnings));
    return { booking: this.view(booking), warnings };
  }

  partialCancel(id: string, request: PartialCancelRequest, actor?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (request.kind === 'count') {
      this.retrip(booking, planTrips(booking.trips, partialCancelTrips(booking.trips, booking.status, request.count), () => this.id('trip')));
      this.touch(booking, actor);
      this.log(id, partialCountLine(actor, request.count));
      return this.view(booking);
    }
    assertOpen(booking.status, 'partial cancel');
    // Seats only go down here, so there is no capacity check — see `claimsMoreSeats`.
    const { trips, trip, count } = partialCancelByKey(booking.trips, request);
    const record = { ...partialCancelRecord(trip, request, count, actor), at: this.now() };
    this.retrip(booking, planTrips(booking.trips, trips, () => this.id('trip')));
    booking.total = totalAfterRefund(booking.total, request.waived);
    booking.partial_cancels.push(record);
    this.touch(booking, actor);
    this.log(id, partialCancelLine(actor, record));
    return this.view(booking);
  }

  rescheduleBooking(id: string, request: RescheduleRequest, actor?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (request.kind === 'move') {
      const from = booking.trips[0]?.service_date ?? '';
      return this.amendBooking(id, { route_id: request.route_id, service_date: request.service_date, ...(request.pax === undefined ? {} : { pax: request.pax }) }, actor, movedLine(actor, from, request.service_date));
    }
    assertOpen(booking.status, 'reschedule');
    const { trips, locksReturned } = rescheduleTrips(booking.trips, request.from_date, request.to_date);
    const planned = planTrips(booking.trips, trips, () => this.id('trip'));
    this.assertRoutes(trips);
    this.assertOpen(tripsToCheckOpen(undefined, booking.trips, planned));
    if (claimsMoreSeats(booking.trips, planned)) this.assertTrips(trips, { bookingId: id });
    const plan = planRescheduleRecord(booking, request, actor, locksReturned);
    const now = this.now();
    this.retrip(booking, planned);
    booking.reschedules.push({ ...plan.record, at: now });
    if (plan.fee_item) booking.fee_items.push({ ...plan.fee_item, at: now });
    this.touch(booking, actor);
    this.log(id, plan.history);
    return this.view(booking);
  }

  createLock(input: Omit<SeatLock, 'id' | 'status' | 'version' | 'created_at' | 'updated_at'>): SeatLock {
    this.assertOpen([input]);
    assertLockFits(this.day(input.route_id, input.service_date), input.pax, 0);
    const now = this.now();
    const lock: SeatLock = { ...input, id: this.id('lock'), status: 'active', version: 1, created_at: now, updated_at: now };
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
    Object.assign(lock, changes, { pax, version: lock.version + 1, updated_at: this.now() });
    return this.lockView(lock);
  }
  lock(id: string): SeatLock | undefined { const found = this.locks.get(id); return found && this.lockView(found); }
  releaseLock(id: string): SeatLock | undefined {
    const lock = this.locks.get(id);
    if (!lock) return undefined;
    if (lock.status === 'active') Object.assign(lock, { status: 'released', version: lock.version + 1, released_at: this.now(), updated_at: this.now() });
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
  const { id, route_id, service_date, booking_mode, charter_boat_id, lock_draws: _draws, pax: _pax, seq: _seq, ovn_of, ...details } = trip;
  return {
    id, route_id, service_date, booking_mode, pax: trip.pax.map((row) => ({ ...row })),
    ...(charter_boat_id ? { charter_boat_id } : {}),
    lock_draws: trip.lock_draws.map((draw) => ({ ...draw })),
    ...tripDetails(details),
    ...ovnOfIndex(all, ovn_of),
  };
};

/** The pickup and overnight fields with the unset ones left out, so both stores return the same keys. */
const tripDetails = (trip: TripDetails): TripDetails => ({
  ...(trip.zone ? { zone: trip.zone } : {}),
  ...pickupFields(trip),
  ...(trip.ovn ?{ ovn: trip.ovn } : {}),
  ...(trip.ovn_return_date ? { ovn_return_date: trip.ovn_return_date } : {}),
  ...(trip.ovn_leg ? { ovn_leg: true } : {}),
  ...(trip.ovn_charge === undefined ? {} : { ovn_charge: trip.ovn_charge }),
  ...(trip.charter_price_mode ? { charter_price_mode: trip.charter_price_mode } : {}),
  ...(trip.charter_price_manual === undefined ? {} : { charter_price_manual: trip.charter_price_manual }),
  ...(trip.charter_price_note ? { charter_price_note: trip.charter_price_note } : {}),
  ...(trip.subtotal === undefined ? {} : { subtotal: trip.subtotal }),
  ...(trip.rate_type_id ? { rate_type_id: trip.rate_type_id } : {}),
  ...(trip.promo_id ? { promo_id: trip.promo_id } : {}),
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
/** Kept trips whose passengers changed: a boat split no longer adds up, so it is cleared (decided 2026-10-06). */
export function paxChangedTripIds(current: readonly StoredTrip[], planned: readonly StoredTrip[]): string[] {
  const key = (pax: readonly PaxRow[]) => [...pax].map((r) => `${r.category}${r.residency}${r.count}`).sort().join(',');
  const before = new Map(current.map((trip) => [trip.id, key(trip.pax)]));
  return planned.filter((trip) => before.has(trip.id) && before.get(trip.id) !== key(trip.pax)).map((trip) => trip.id);
}

export function movedTripIds(current: readonly StoredTrip[], planned: readonly StoredTrip[]): string[] {
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.filter((trip) => {
    const old = before.get(trip.id);
    return old !== undefined && (old.route_id !== trip.route_id || old.service_date !== trip.service_date);
  }).map((trip) => trip.id);
}

/**
 * The trips a write must find running on their day (`assertRoutesOpen`): those it adds or moves to
 * another route or day. A trip the write leaves where it is was sold already, and a day that closed
 * after the sale must not stop a notes edit — legacy's save blocks it, which is the hole this
 * closes. A booking from legacy's B2C sync (`isLegacyB2C`) is saved anyway, as legacy saves it.
 * Pass no `externalId` where legacy has no such exception (reschedule).
 */
export function tripsToCheckOpen(externalId: string | null | undefined, current: readonly StoredTrip[], planned: readonly StoredTrip[]): StoredTrip[] {
  if (isLegacyB2C(externalId)) return [];
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.filter((trip) => {
    const old = before.get(trip.id);
    return old === undefined || old.route_id !== trip.route_id || old.service_date !== trip.service_date;
  });
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

const drawnTotal = (draws: readonly LockDraw[]): number => draws.reduce((sum, draw) => sum + draw.qty, 0);

/**
 * Whether an amendment asks the pool for anything it is not already holding.
 *
 * Trips are matched by id (after `planTrips`), so a reorder is not a change. Only growth counts: a
 * new trip, a trip moved to another route, day, mode or charter boat, more passengers, more general
 * seats, or more seats from any one lock. General seats are checked on their own because a trip that
 * keeps its pax but gives up lock seats takes the same number from the general pool instead.
 *
 * Shrinking never needs room. The import brings oversold days over as they are, and checking an
 * amendment that only frees seats would refuse taking a passenger off a day that is already over.
 */
/**
 * Whether an amendment is weighed against the allotment again: a booking holding its seats that asks
 * for more, or one waiting over the allotment (holding nothing) whose itinerary changes at all.
 */
export function reweighs(
  booking: { status: BookingStatus; approvals?: readonly BookingApproval[] }, changes: BookingChanges, moreSeats: boolean,
): boolean {
  if (bookingHoldsSeats(booking)) return moreSeats;
  const itinerary = changes.trips !== undefined || changes.route_id !== undefined || changes.service_date !== undefined || changes.pax !== undefined;
  return booking.status === 'pending_approval' && itinerary;
}

/** The days an approval puts past the boats' registered seats. `dayOf` reads the day without this booking. */
export function licenceWarnings(trips: readonly StoredTrip[], dayOf: (routeId: string, date: string) => DayState): ApprovalWarning[] {
  const warnings: ApprovalWarning[] = [];
  for (const demand of demandByDay(trips.map((trip) => asInput(trip, trips)))) {
    const over = licenceShortfall(dayOf(demand.route_id, demand.service_date), demand);
    if (over > 0) warnings.push({ code: 'over_licence', route_id: demand.route_id, service_date: demand.service_date, over_by: over });
  }
  return warnings;
}

export function claimsMoreSeats(current: readonly StoredTrip[], planned: readonly StoredTrip[]): boolean {
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.some((trip) => {
    const old = before.get(trip.id);
    if (!old) return true;
    if (old.route_id !== trip.route_id || old.service_date !== trip.service_date || old.booking_mode !== trip.booking_mode
      || (old.charter_boat_id ?? '') !== (trip.charter_boat_id ?? '')) return true;
    const pax = paxTotal(trip.pax), oldPax = paxTotal(old.pax);
    if (pax > oldPax || pax - drawnTotal(trip.lock_draws) > oldPax - drawnTotal(old.lock_draws)) return true;
    const oldDraws = new Map(old.lock_draws.map((draw) => [draw.lock_id, draw.qty]));
    return trip.lock_draws.some((draw) => draw.qty > (oldDraws.get(draw.lock_id) ?? 0));
  });
}

/**
 * Draws cut by `count`, lock seats first, lowest lock id first — the opposite of `clampDraws`.
 *
 * A partial cancel names who is leaving, and legacy gives their reserved seats back to the agent's
 * lock (`booking.js:13904-13919`): the customer dropped out, so the agent may resell the seat. Only
 * what is left over comes off the general seats.
 */
export function returnDrawsFirst(draws: readonly LockDraw[], count: number): LockDraw[] {
  let left = count;
  const kept: LockDraw[] = [];
  for (const draw of sortedDraws(draws)) {
    const back = Math.min(draw.qty, left);
    left -= back;
    if (draw.qty - back > 0) kept.push({ lock_id: draw.lock_id, qty: draw.qty - back });
  }
  return kept;
}

/**
 * The full partial cancel: named passengers off one trip, their lock seats back first.
 *
 * A trip is never emptied this way (decided 2026-10-05). Removing a whole departure is a different
 * act — cancel the booking, or edit its trips — and one that legacy let happen here by accident.
 */
export function partialCancelByKey(trips: readonly StoredTrip[], request: Extract<PartialCancelRequest, { kind: 'record' }>): { trips: BookingTripInput[]; trip: StoredTrip; count: number } {
  const index = trips.findIndex((trip) => trip.id === request.trip_id);
  if (index < 0) refuse(`Trip ${request.trip_id} is not on this booking`, 404);
  const trip = trips[index];
  const label = `trips[${index}]`;
  const remaining = trip.pax.map((row) => ({ ...row }));
  for (const cut of request.pax) {
    const key = paxKey(cut.category, cut.residency);
    const cell = remaining.find((row) => row.category === cut.category && row.residency === cut.residency) ?? refuse(`${label} has no ${key} passengers`, 400);
    if (cut.count > cell.count) refuse(`${label} has ${cell.count} ${key}; cannot remove ${cut.count}`, 400);
    cell.count -= cut.count;
  }
  const left = remaining.filter((row) => row.count > 0);
  if (left.length === 0) refuse(`${label} would have no passengers; cancel the booking instead`, 400);
  const count = paxTotal(request.pax);
  return {
    trip, count,
    trips: trips.map((stored) => stored === trip ? { ...asInput(stored, trips), pax: left, lock_draws: returnDrawsFirst(stored.lock_draws, count) } : asInput(stored, trips)),
  };
}

/**
 * Every trip on `from` moved to `to`, on the same route (legacy `bkV2RescheduleBooking`). Their lock
 * draws are returned: a lock belongs to one departure, so the moved trip takes general seats on the
 * new day, as the single-trip move in `nextTrips` already does. A charter keeps its boat and must get
 * it whole on the new day, which the ordinary capacity check decides.
 */
export function rescheduleTrips(trips: readonly StoredTrip[], from: string, to: string): { trips: BookingTripInput[]; locksReturned: number } {
  if (!trips.some((trip) => trip.service_date === from)) refuse(`No trip on ${from} to reschedule`, 400);
  let locksReturned = 0;
  const next = trips.map((trip) => {
    const input = asInput(trip, trips);
    if (trip.service_date !== from) return input;
    locksReturned += drawnTotal(trip.lock_draws);
    return { ...input, service_date: to, lock_draws: [] };
  });
  // An overnight outbound cannot move past its return leg, and a route keeps one trip per day.
  assertItinerary(next);
  return { trips: next, locksReturned };
}

export const dayKey = (routeId: string, serviceDate: string): string => `${routeId} ${serviceDate}`;

/**
 * The trips a restored booking asks for, from each day's state read with the booking excluded.
 *
 * Lock seats are redrawn best-effort, as legacy does (`booking.js:12376-12385`): a lock that has
 * since been used by others gives back what it still has, and the rest of the trip falls to general
 * seats — the caller's capacity check then decides whether those exist. A charter wants its boat
 * whole again; if another charter took it meanwhile, the restore is refused rather than leaving two
 * charters on one boat, which legacy allowed and asked staff to sort out by hand.
 */
export function restoreTrips(trips: readonly StoredTrip[], days: ReadonlyMap<string, DayState>): { trips: BookingTripInput[]; warnings: LockShortWarning[] } {
  const warnings: LockShortWarning[] = [];
  const left = new Map<string, number>();
  const next = trips.map((trip) => {
    const day = days.get(dayKey(trip.route_id, trip.service_date));
    if (trip.booking_mode === 'charter' && trip.charter_boat_id && day?.boats.find((boat) => boat.boat_id === trip.charter_boat_id)?.chartered) {
      refuse(`Boat ${trip.charter_boat_id} is chartered by another booking on ${trip.service_date}`, 409, 'charter_boat_taken');
    }
    const draws = trip.lock_draws.map((draw) => {
      const remaining = left.get(draw.lock_id) ?? day?.locks.find((lock) => lock.id === draw.lock_id)?.remaining ?? 0;
      const got = Math.min(draw.qty, remaining);
      left.set(draw.lock_id, remaining - got);
      if (got < draw.qty) warnings.push({ code: 'lock_short', trip_id: trip.id, lock_id: draw.lock_id, wanted: draw.qty, got });
      return { lock_id: draw.lock_id, qty: got };
    }).filter((draw) => draw.qty > 0);
    return { ...asInput(trip, trips), lock_draws: draws };
  });
  return { trips: next, warnings };
}

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

