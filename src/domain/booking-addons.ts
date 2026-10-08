/**
 * A booking's add-ons — longtail join/charter, private transfers, B2C extras.
 *
 * `addOns[]` is unbounded, so it is a table (`booking_addons`), not columns — see
 * `README.md`, "Add-ons". The list replaces outright on an amendment, the way `passengers` does.
 *
 * Nothing is filled in. A missing `qty` stays missing rather than becoming 1, and a missing join
 * count stays missing rather than becoming 0: for a longtail join, "not narrowed down" means
 * operations counts every passenger, and 0 would mean nobody goes.
 */

export type BookingAddOnInput = {
  type: string;
  label?: string;
  /** Line total at save time, not a unit price. */
  amount?: number;
  qty?: number;
  note?: string;
  join_adults?: number;
  join_children?: number;
};
export type BookingAddOn = BookingAddOnInput & { seq: number };

const invalid = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };

const text = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  const trimmed = (value as string).trim();
  return trimmed === '' ? undefined : trimmed;
};

const integer = (value: unknown, label: string, min: number, rule: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) invalid(`${label} must be ${rule}`);
  return value as number;
};

/**
 * Parses the frontend's `addOns` array. Absent is an empty list; a value that is present and
 * malformed is refused with the field and its position, never silently dropped.
 *
 * Accepts the frontend's `jAd`/`jChd` as well as `join_adults`/`join_children`.
 */
export function parseBookingAddOns(input: unknown, label = 'addOns'): BookingAddOnInput[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) invalid(`${label} must be an array`);
  return (input as unknown[]).map((entry, index) => {
    const at = `${label}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) invalid(`${at} must be an object`);
    const row = entry as Record<string, unknown>;
    const type = typeof row.type === 'string' ? row.type.trim() : '';
    if (type === '') invalid(`${at}.type is required`);
    let amount: number | undefined;
    if (row.amount !== undefined && row.amount !== null) {
      if (typeof row.amount !== 'number' || !Number.isFinite(row.amount)) invalid(`${at}.amount must be a number`);
      if ((row.amount as number) < 0) invalid(`${at}.amount must not be negative`);
      amount = row.amount as number;
    }
    const adults = row.jAd !== undefined ? 'jAd' : 'join_adults';
    const children = row.jChd !== undefined ? 'jChd' : 'join_children';
    return {
      type,
      label: text(row.label, `${at}.label`),
      amount,
      qty: integer(row.qty, `${at}.qty`, 1, 'a positive integer'),
      note: text(row.note, `${at}.note`),
      join_adults: integer(row[adults], `${at}.${adults}`, 0, 'a non-negative integer'),
      join_children: integer(row[children], `${at}.${children}`, 0, 'a non-negative integer'),
    };
  });
}
