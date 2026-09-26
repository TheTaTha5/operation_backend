/**
 * A booking's passenger list.
 *
 * `passengers[]` is unbounded, so it is a table, not a fixed-size struct — see the rule in
 * `todo/booking-model.md`. The list replaces outright on an amendment, the way `trips` does: a
 * passenger list is one fact, not fifty-seven, so there is no per-field merge to define.
 */

export type BookingPassengerInput = { name: string; nationality?: string; type?: string; foc?: boolean };
export type BookingPassenger = BookingPassengerInput & { seq: number };

const invalid = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Parses the frontend's `passengers` array. Absent is an empty list — most bookings never send
 * one — but a value that is present and malformed is refused rather than silently dropped, the
 * same choice `parsePaxGrid` makes for the pax grid.
 */

export function parseBookingPassengers(input: unknown, label = 'passengers'): BookingPassengerInput[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) invalid(`${label} must be an array`);
  return (input as unknown[]).map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) invalid(`${label}[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    const name = text(row.name);
    if (name === undefined) invalid(`${label}[${index}].name is required`);
    return { name: name as string, nationality: text(row.nationality), type: text(row.type), foc: row.foc == null ? undefined : Boolean(row.foc) };
  });
}

/** Assigns each passenger its position, the way `booking_trips.seq` orders trips. */
export const withSeq = (rows: readonly BookingPassengerInput[]): BookingPassenger[] => rows.map((row, seq) => ({ ...row, seq }));
