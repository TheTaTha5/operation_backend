/**
 * A booking's lifecycle status, and the rule for whether it occupies a seat.
 *
 * The ten values are what the frontend writes (`allotment_v2.html`); six of them appear in the
 * legacy production data. A status the API refuses is a booking the frontend cannot save, so the
 * set is defined from the writer's side rather than from what happens to exist today.
 */
export const BOOKING_STATUSES = [
  'draft', 'quote', 'pending', 'pending_approval', 'pending_foc',
  'confirmed', 'completed', 'rejected', 'cancelled', 'cancelled_weather',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

const KNOWN = new Set<string>(BOOKING_STATUSES);
export const isBookingStatus = (value: unknown): value is BookingStatus => typeof value === 'string' && KNOWN.has(value);

/**
 * Statuses that give their seats back. Everything else holds them.
 *
 * This is a denylist on purpose, and it is the shape legacy uses (`getSeatsConsumed`). The
 * direction matters more than the membership: a status nobody has classified yet — a new one, a
 * value from an older client — holds its seats rather than releasing them. Over-holding shows up
 * as a day that looks fuller than it is and someone asks; under-holding shows up as two parties
 * sold the same seat, at the pier, on the day.
 *
 * Exported as an array too, because the SQL store passes it as a query parameter rather than
 * repeating the list in a `WHERE` clause.
 */
export const SEAT_RELEASING_STATUSES = ['cancelled', 'rejected', 'cancelled_weather'] as const;
const RELEASES = new Set<string>(SEAT_RELEASING_STATUSES);
export const holdsSeats = (status: string): boolean => !RELEASES.has(status);

/**
 * A booking saved *because* it exceeded capacity has not been granted those seats yet, so counting
 * them would let it consume the very capacity it is waiting on. Legacy expresses this as
 * `bkPendHoldsSeat`, keyed on the approval record's `over`/`totOver`.
 *
 * The approval record arrives with `booking_approvals` in stage 3. Until then this is the identity
 * for every row: all seven `pending_approval` bookings in production carry an empty approval, which
 * legacy already reads as holding seats.
 */
export const pendingApprovalHoldsSeats = (approval?: { over_total?: number }): boolean => (approval?.over_total ?? 0) <= 0;
