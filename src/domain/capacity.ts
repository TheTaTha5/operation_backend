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
 */
export type Capacity = { deployed_capacity: number; licensed_capacity: number; booked_pax: number; charter_pax: number; locked_pax: number; available_seats: number };

/** A boat deployed on the route that day, with its per-day override if it has one. */
export type DayDeployment = DeploymentLimits & { boat_id: string };
/** A trip on the route that day, from a booking that holds seats. The caller applies any exclusion. */
export type HeldTrip = { booking_mode: string; pax: number; charter_boat_id?: string };
/** An active lock on the route that day, and how many of its seats holding bookings have drawn. */
export type HeldLock = { id: string; pax: number; drawn: number };

export type BoatDay = { boat_id: string; sellable: number; licensed: number; license_pax?: number; chartered: boolean };
export type LockDay = HeldLock & { remaining: number };
/** A day's numbers plus the per-boat and per-lock detail a sale is checked against. */
export type DayState = Capacity & { boats: BoatDay[]; locks: LockDay[] };

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
 */
export function dayCapacity(deployments: readonly DayDeployment[], trips: readonly HeldTrip[], locks: readonly HeldLock[]): DayState {
  const chartered = new Set(trips.filter((trip) => trip.booking_mode === 'charter' && trip.charter_boat_id).map((trip) => trip.charter_boat_id));
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
  const lockDays = locks.map((l) => ({ ...l, remaining: Math.max(l.pax - l.drawn, 0) }));
  const locked_pax = lockDays.reduce((sum, l) => sum + l.remaining, 0);
  const open = boats.filter((boat) => !boat.chartered).reduce((sum, boat) => sum + boat.sellable, 0);
  return {
    deployed_capacity: boats.reduce((sum, boat) => sum + boat.sellable, 0),
    licensed_capacity: boats.reduce((sum, boat) => sum + boat.licensed, 0),
    booked_pax, charter_pax, locked_pax,
    available_seats: open - unplaced - booked_pax - locked_pax,
    boats, locks: lockDays,
  };
}

/** The six numbers alone, for responses that predate the per-boat detail. */
export const capacityNumbers = (day: DayState): Capacity => ({
  deployed_capacity: day.deployed_capacity, licensed_capacity: day.licensed_capacity, booked_pax: day.booked_pax,
  charter_pax: day.charter_pax, locked_pax: day.locked_pax, available_seats: day.available_seats,
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
    if (boat.chartered || taking.has(boat.boat_id)) refuse(`Boat ${boat.boat_id} is already chartered ${where}`, 409);
    if (charter.pax > boat.licensed) refuse(`A charter of ${charter.pax} exceeds boat ${boat.boat_id}'s licensed ${boat.licensed} passengers`, 409);
    taking.add(boat.boat_id);
    need += boat.sellable;
  }
  if (need > 0 && day.available_seats < need) refuse('Insufficient available seats', 409);
}

/**
 * Throws unless a lock of `pax` seats fits `day`, which must be read with that lock excluded. A lock
 * cannot shrink below what bookings have already drawn from it: those passengers are sold.
 */
export function assertLockFits(day: DayState, pax: number, drawn: number): void {
  if (pax < drawn) refuse(`Bookings have drawn ${drawn} seats from this lock; it cannot hold fewer`, 409);
  const need = pax - drawn;
  if (need > 0 && day.available_seats < need) refuse('Insufficient available seats', 409);
}
