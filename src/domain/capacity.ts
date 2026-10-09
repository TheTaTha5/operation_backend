import type { RouteKind } from './calendar.js';

/**
 * How many seats a deployed boat may actually sell.
 *
 * Three numbers describe a boat and only two of them are ceilings:
 *
 * - `capacity` — what the company sells. A commercial decision, set per deployment.
 * - `license_pax` — the registered maximum **passengers**. The legal ceiling.
 * - the legacy `totalcap` — `license_pax + crew`, the total persons the vessel may carry.
 *
 * The third is not a selling limit and never was. Using it as one is how a charter came to be
 * offered 48 seats on a boat registered for 45 passengers and 3 crew: the three extra were the
 * crew's. It is kept as `deployments.registered_persons` for the record and read by nothing.
 *
 * Legacy clamps at the source and never consults `totalcap` for selling
 * (`020_v_seat_availability_trips_boat.sql`), and the frontend repeats the clamp on read, commented
 * "เพดานแข็ง · ห้ามเกินที่นั่งจดทะเบียน" — hard ceiling, must not exceed registered seats.
 */
export type DeploymentLimits = {
  /** Seats this deployment offers. */
  capacity: number;
  /** Registered passenger maximum. Absent for a boat with no licence on file, and three Ranong
      boats have none — so a missing licence must fall back to capacity, never to zero. */
  license_pax?: number;
  /** A per-day replacement for the deployment's capacity, from `boat_capacity_overrides`. */
  override_capacity?: number;
};

/**
 * The passenger ceiling a charter may fill a boat to.
 *
 * A boat with no licence on file falls back to its capacity — three Ranong boats have none, and a
 * missing licence is not a licence of zero. This is the only place that fallback is written, so the
 * seat pool and the boat catalogue cannot answer it differently.
 */
export function charterCeiling(limits: { capacity: number; license_pax?: number }): number {
  return limits.license_pax ?? limits.capacity;
}

/**
 * `sellable` is what the seat pool offers; `licensed` is the passenger ceiling a charter may fill
 * the boat to, which is higher than the selling cap by design — a charter buys the whole boat.
 *
 * A day override may lower the operational capacity, but the licence still caps the result: an
 * override must never be able to raise a boat above what it is registered to carry.
 */
export function deploymentSeats(limits: DeploymentLimits): { sellable: number; licensed: number } {
  const operational = limits.override_capacity ?? limits.capacity;
  const licensed = charterCeiling({ capacity: operational, license_pax: limits.license_pax });
  return { sellable: Math.min(operational, licensed), licensed };
}

/**
 * `deployed_capacity` is what may be sold as seats; `licensed_capacity` is the registered passenger
 * ceiling a charter may fill the boat to. The old `total_capacity` was `license_pax + crew` and is
 * gone from this shape deliberately — it was never a limit anyone could sell against.
 *
 * `unlimited` is a land route, which has no seat pool: `available_seats` is then `null`.
 * `unplaced_pax` is what a marine day with no boat deployed holds (bookings, charters and undrawn
 * locks), sold ungated as legacy sells it, waiting for a boat.
 * `licensed_free` is the registered passenger seats left on the unchartered boats, locks not
 * subtracted (legacy `licenseAvailable`, the approval card's "Real seats left"): how far an
 * over-allotment approval may still go. Never negative; `null` on a land route, like `available_seats`.
 */
export type Capacity = {
  deployed_capacity: number; licensed_capacity: number; booked_pax: number; charter_pax: number; locked_pax: number;
  available_seats: number | null; unlimited: boolean; unplaced_pax: number; licensed_free: number | null;
};

/** A boat deployed on the route that day, with its per-day override if it has one. */
export type DayDeployment = DeploymentLimits & { boat_id: string };
/** A trip on the route that day, from a booking that holds seats. The caller applies any exclusion. */
export type HeldTrip = { booking_mode: string; pax: number; charter_boat_id?: string };
/** An active lock on the route that day, and how many of its seats holding bookings have drawn. */
/** `boat_id`: a whole-boat hold (todo/boat-holds-model.md), which takes its boat as a charter does. */
export type HeldLock = { id: string; pax: number; drawn: number; boat_id?: string };

export type BoatDay = { boat_id: string; sellable: number; licensed: number; license_pax?: number; chartered: boolean };
export type LockDay = HeldLock & { remaining: number };
/**
 * A day's numbers plus the per-boat and per-lock detail a sale is checked against.
 * `licensed_free` is the registered passenger seats still unsold on the day's open boats, locks not
 * subtracted: the ceiling legacy's over-allotment approval may reach, and no further.
 */
export type DayState = Omit<Capacity, 'available_seats' | 'licensed_free'> & { available_seats: number; boats: BoatDay[]; locks: LockDay[]; licensed_free: number };

/**
 * Whether a sale on this day goes unchecked against seats, as legacy's `hasAllotment` false lets it:
 * a land route has no seat pool (legacy's `dailyCap` is empty on every route), and a marine day with
 * no boat deployed yet is sold before the boats are assigned. Lock draws and charters are still
 * checked: a lock has its own seats, and a charter needs its boat.
 */
export const sellsUngated = (day: DayState): boolean => day.unlimited || day.boats.length === 0;

/**
 * One route's seat pool on one day.
 *
 * Both stores gather the rows their own way and hand them here, so a single date, a range sweep and
 * the check before a sale cannot come to different answers.
 *
 * - A charter takes its whole boat: a chartered boat's sellable seats leave the pool, however few
 *   passengers the charter carries. A charter whose boat is unknown (recorded before
 *   `charter_boat_id` existed, on a day with more than one boat) or no longer deployed cannot take a
 *   boat, so its passengers come out of the pool instead — an undercount, but never an overcount.
 * - A lock holds only what bookings have not yet drawn from it. The drawn seats are already in
 *   `booked_pax`; counting the whole lock as well would hold them twice.
 * - A whole-boat hold (a lock with `boat_id`) takes its boat exactly as a charter does, and holds
 *   nothing more (legacy §bkLock). If its boat is not deployed that day it takes no boat, and holds
 *   its promised seats as a plain lock.
 * - A land route has no pool (`unlimited`), and a marine day with no boat has nothing to sell from
 *   yet: what it holds is `unplaced_pax`, and neither answers a negative `available_seats`.
 */
export function dayCapacity(deployments: readonly DayDeployment[], trips: readonly HeldTrip[], locks: readonly HeldLock[], kind: RouteKind = 'marine'): DayState {
  const deployedIds = new Set(deployments.map((d) => d.boat_id));
  const holding = new Set(locks.filter((l) => l.boat_id && deployedIds.has(l.boat_id)).map((l) => l.id));
  const chartered = new Set([
    ...trips.filter((trip) => trip.booking_mode === 'charter' && trip.charter_boat_id).map((trip) => trip.charter_boat_id),
    ...locks.filter((l) => holding.has(l.id)).map((l) => l.boat_id),
  ]);
  // Sorted here so both stores list a day's boats in the same order; SQL alone would promise none.
  const boats = deployments
    .map((d): BoatDay => ({ boat_id: d.boat_id, ...deploymentSeats(d), license_pax: d.license_pax, chartered: chartered.has(d.boat_id) }))
    .sort((a, b) => a.boat_id.localeCompare(b.boat_id));
  const deployed = new Set(boats.map((boat) => boat.boat_id));

  let booked_pax = 0, charter_pax = 0, unplaced = 0;
  for (const trip of trips) {
    if (trip.booking_mode !== 'charter') { booked_pax += trip.pax; continue; }
    charter_pax += trip.pax;
    if (!trip.charter_boat_id || !deployed.has(trip.charter_boat_id)) unplaced += trip.pax;
  }
  const lockDays = locks.map((l) => ({ ...l, remaining: holding.has(l.id) ? 0 : Math.max(l.pax - l.drawn, 0) }));
  const locked_pax = lockDays.reduce((sum, l) => sum + l.remaining, 0);
  const open = boats.filter((boat) => !boat.chartered).reduce((sum, boat) => sum + boat.sellable, 0);
  const openLicensed = boats.filter((boat) => !boat.chartered).reduce((sum, boat) => sum + boat.licensed, 0);
  const unlimited = kind === 'land';
  const pooled = !unlimited && boats.length > 0;
  return {
    deployed_capacity: boats.reduce((sum, boat) => sum + boat.sellable, 0),
    licensed_capacity: boats.reduce((sum, boat) => sum + boat.licensed, 0),
    booked_pax, charter_pax, locked_pax,
    available_seats: pooled ? open - unplaced - booked_pax - locked_pax : 0,
    unlimited,
    unplaced_pax: unlimited || pooled ? 0 : booked_pax + charter_pax + locked_pax,
    boats, locks: lockDays,
    licensed_free: pooled ? openLicensed - unplaced - booked_pax : 0,
  };
}

/** The numbers alone, for responses that predate the per-boat detail. A land route has no seat count to give. */
export const capacityNumbers = (day: DayState): Capacity => ({
  deployed_capacity: day.deployed_capacity, licensed_capacity: day.licensed_capacity, booked_pax: day.booked_pax,
  charter_pax: day.charter_pax, locked_pax: day.locked_pax, available_seats: day.unlimited ? null : day.available_seats,
  unlimited: day.unlimited, unplaced_pax: day.unplaced_pax, licensed_free: day.unlimited ? null : Math.max(day.licensed_free, 0),
});

/** What one booking asks of one route and day, all its trips on that day weighed together. */
export type DayDemand = {
  route_id: string; service_date: string;
  /** Seat-mode passengers, including those drawn from locks. */
  seat: number;
  /** Seats drawn from each lock, by lock id. */
  draws: Map<string, number>;
  charters: { boat_id?: string; pax: number }[];
};

const refuse = (message: string, statusCode: 400 | 409): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };

/**
 * Throws unless `demand` fits `day`. `day` must be read with the booking being amended excluded, or
 * it competes with its own seats.
 *
 * A seat drawn from a lock is already held, so only the undrawn part of a seat trip needs the pool.
 * A charter needs its boat to be deployed and free, its passengers to fit that boat's licence, and
 * the pool to survive losing the boat: taking a boat must not strand seats already sold on the day.
 */
export function assertDayFits(day: DayState, demand: DayDemand): void {
  const where = `on ${demand.route_id} ${demand.service_date}`;
  let drawn = 0;
  for (const [lockId, qty] of demand.draws) {
    const lock = day.locks.find((l) => l.id === lockId) ?? refuse(`Seat lock ${lockId} is not active ${where}`, 400);
    if (qty > lock.remaining) refuse(`Seat lock ${lockId} has ${lock.remaining} seats left`, 409);
    drawn += qty;
  }

  let need = Math.max(demand.seat - drawn, 0);
  const taking = new Set<string>();
  for (const charter of demand.charters) {
    // Only an amendment carrying a charter recorded before `charter_boat_id` existed gets here.
    if (!charter.boat_id) { need += charter.pax; continue; }
    const boat = day.boats.find((b) => b.boat_id === charter.boat_id) ?? refuse(`Boat ${charter.boat_id} is not deployed ${where}`, 400);
    if (boat.chartered || taking.has(boat.boat_id)) refuse(`Boat ${boat.boat_id} is already chartered or held whole ${where}`, 409);
    if (charter.pax > boat.licensed) refuse(`A charter of ${charter.pax} exceeds boat ${boat.boat_id}'s licensed ${boat.licensed} passengers`, 409);
    taking.add(boat.boat_id);
    need += boat.sellable;
  }
  if (sellsUngated(day)) return;
  if (need > 0 && day.available_seats < need) refuse('Insufficient available seats', 409);
}

/**
 * Weighs a demand the way legacy's save does ("Anti-overbook guard (tiered)", `bkV2CommitBooking`),
 * and answers how far over the allotment it is, if at all. `day` must be read with the booking
 * being amended excluded.
 *
 * Lock draws and charters are checked exactly as `assertDayFits` checks them. A seat trip's general
 * need (its pax less its lock draw) then falls in one of four tiers:
 *
 * - it fits the seats available → `undefined`;
 * - it would fit only by taking seats other agents' locks hold → refused (`409`);
 * - it is over the allotment but within the boats' licensed seats → answered as an over-allotment,
 *   for an approval to decide;
 * - it is over the licensed seats too → refused (`409`): there is no registered seat left.
 */
export function weighDay(day: DayState, demand: DayDemand): { need: number; over_by: number; licensed_free: number } | undefined {
  const where = `on ${demand.route_id} ${demand.service_date}`;
  let drawn = 0;
  for (const [lockId, qty] of demand.draws) {
    const lock = day.locks.find((l) => l.id === lockId) ?? refuse(`Seat lock ${lockId} is not active ${where}`, 400);
    if (qty > lock.remaining) refuse(`Seat lock ${lockId} has ${lock.remaining} seats left`, 409);
    drawn += qty;
  }
  // Charters take whole boats, out of the sellable seats and out of the licensed ones alike.
  let charterSeats = 0, charterLicensed = 0;
  const taking = new Set<string>();
  for (const charter of demand.charters) {
    if (!charter.boat_id) { charterSeats += charter.pax; charterLicensed += charter.pax; continue; }
    const boat = day.boats.find((b) => b.boat_id === charter.boat_id) ?? refuse(`Boat ${charter.boat_id} is not deployed ${where}`, 400);
    if (boat.chartered || taking.has(boat.boat_id)) refuse(`Boat ${boat.boat_id} is already chartered or held whole ${where}`, 409);
    if (charter.pax > boat.licensed) refuse(`A charter of ${charter.pax} exceeds boat ${boat.boat_id}'s licensed ${boat.licensed} passengers`, 409);
    taking.add(boat.boat_id);
    charterSeats += boat.sellable;
    charterLicensed += boat.licensed;
  }
  if (sellsUngated(day)) return undefined;
  if (charterSeats > 0 && day.available_seats < charterSeats) refuse('Insufficient available seats', 409);

  const available = day.available_seats - charterSeats;
  const need = Math.max(demand.seat - drawn, 0);
  if (need === 0 || need <= available) return undefined;
  const physical = available + day.locked_pax;
  if (need <= physical) refuse(`Insufficient available seats ${where}: the rest are held by seat locks`, 409);
  const licensed = day.licensed_free - charterLicensed;
  if (need > licensed) refuse(`Insufficient available seats ${where}: the boats' registered seats are full (${Math.max(licensed, 0)} left)`, 409);
  // `licensed` is legacy's `licFree`, the approval card's "Real seats left".
  return { need, over_by: need - physical, licensed_free: licensed };
}

/**
 * How many of a demand's general seats have no registered seat left on the day: the warning an
 * approval over the licence carries. Legacy lets a manager approve it anyway ("add a boat before the
 * travel date", `bkV2ApproveBooking`), so this never refuses.
 */
export function licenceShortfall(day: DayState, demand: DayDemand): number {
  if (sellsUngated(day)) return 0;
  const drawn = [...demand.draws.values()].reduce((sum, qty) => sum + qty, 0);
  return Math.max(0, Math.max(demand.seat - drawn, 0) - Math.max(day.licensed_free, 0));
}

/**
 * Throws unless a lock of `pax` seats fits `day`, which must be read with that lock excluded. A lock
 * cannot shrink below what bookings have already drawn from it: those passengers are sold.
 */
export function assertLockFits(day: DayState, pax: number, drawn: number): void {
  if (pax < drawn) refuse(`Bookings have drawn ${drawn} seats from this lock; it cannot hold fewer`, 409);
  if (sellsUngated(day)) return;
  const need = pax - drawn;
  if (need > 0 && day.available_seats < need) refuse('Insufficient available seats', 409);
}
