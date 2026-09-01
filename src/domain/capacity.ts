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
