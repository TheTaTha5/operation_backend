/**
 * A booking's adjustments: the discounts and extra charges staff add on the review step
 * (todo/adjustments-model.md, migration 031). Unbounded, so a table, `booking_adjustments`; the list
 * replaces outright on an amendment, the way `passengers` and `add_ons` do.
 *
 * Client facts, checked for shape. What they add up to (the discount and the extras) is the quote's
 * to compute; until then `price_discount`/`price_extra` are still sent by the client.
 */

export type BookingAdjustmentInput = {
  kind: 'discount' | 'extra';
  /** Legacy prices a `percent` discount off seats + add-ons; an extra is always an amount. */
  mode: 'amount' | 'percent';
  value: number;
  label?: string;
  note?: string;
};
export type BookingAdjustment = BookingAdjustmentInput & { seq: number };

const invalid = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const text = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  const trimmed = (value as string).trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Absent is an empty list; a row that is present and malformed is refused with its position. */
export function parseBookingAdjustments(input: unknown, label = 'adjustments'): BookingAdjustmentInput[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) invalid(`${label} must be an array`);
  return (input as unknown[]).map((entry, index) => {
    const at = `${label}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) invalid(`${at} must be an object`);
    const row = entry as Record<string, unknown>;
    if (row.kind !== 'discount' && row.kind !== 'extra') invalid(`${at}.kind must be discount or extra`);
    const mode = row.mode === undefined || row.mode === null ? 'amount' : row.mode;
    if (mode !== 'amount' && mode !== 'percent') invalid(`${at}.mode must be amount or percent`);
    if (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value <= 0) invalid(`${at}.value must be a number above 0`);
    return {
      kind: row.kind as BookingAdjustmentInput['kind'], mode: mode as BookingAdjustmentInput['mode'], value: row.value as number,
      label: text(row.label, `${at}.label`), note: text(row.note, `${at}.note`),
    };
  });
}
