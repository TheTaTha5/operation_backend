/**
 * Passenger counts, and the rule for which bookings hold seats.
 *
 * The frontend writes a passenger grid as flat keys — `ad`, `ad_fr`, `ad_th`, `chd`, `chd_fr`, … —
 * which is an age category crossed with a pricing residency, flattened into a string. Stored, that
 * cross is one row per cell; on the wire it stays the frontend's flat shape. Both stores need the
 * same parsing, the same totals, and the same seat-holding predicate, so all of it lives here and
 * neither store writes its own copy. See `calendar.ts` for the same pattern applied to routes.
 */

export const PAX_CATEGORIES = ['ad', 'chd', 'inf', 'foc'] as const;
export type PaxCategory = (typeof PAX_CATEGORIES)[number];

export const PAX_RESIDENCIES = ['unknown', 'foreign', 'thai'] as const;
export type PaxResidency = (typeof PAX_RESIDENCIES)[number];

export type PaxRow = { category: PaxCategory; residency: PaxResidency; count: number };
/** The frontend's flat form: `{ ad: 2, chd_fr: 1 }`. */
export type PaxGrid = Record<string, number>;

/** `_fr`/`_th` are pricing tiers (foreign/Thai); a bare category is a count nobody has tiered yet. */
const SUFFIX: Record<PaxResidency, string> = { unknown: '', foreign: '_fr', thai: '_th' };
const RESIDENCY_BY_SUFFIX = new Map<string, PaxResidency>(PAX_RESIDENCIES.map((r) => [SUFFIX[r], r]));

export const paxKey = (category: PaxCategory, residency: PaxResidency): string => `${category}${SUFFIX[residency]}`;

const invalid = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };

/** Parses the frontend's flat grid into rows, rejecting keys we cannot store rather than dropping them. */
export function parsePaxGrid(input: unknown, label = 'pax'): PaxRow[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid(`${label} must be an object of passenger counts`);
  const rows: PaxRow[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const category = PAX_CATEGORIES.find((c) => key === c || key.startsWith(`${c}_`));
    const residency = category === undefined ? undefined : RESIDENCY_BY_SUFFIX.get(key.slice(category.length));
    if (category === undefined || residency === undefined) invalid(`${label}.${key} is not a passenger category`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalid(`${label}.${key} must be a non-negative integer`);
    // A zero is the absence of those passengers, so it is simply not a row.
    if ((value as number) > 0) rows.push({ category: category as PaxCategory, residency: residency as PaxResidency, count: value as number });
  }
  return sortPax(rows);
}

/** A single untiered count, for callers that send `pax: 6` and no grid. */
export const paxRowsFromTotal = (total: number): PaxRow[] => (total > 0 ? [{ category: 'ad', residency: 'unknown', count: total }] : []);

export const formatPaxGrid = (rows: readonly PaxRow[]): PaxGrid => Object.fromEntries(sortPax(rows).map((r) => [paxKey(r.category, r.residency), r.count]));
export const paxTotal = (rows: readonly PaxRow[]): number => rows.reduce((sum, r) => sum + r.count, 0);

const order = (row: PaxRow): number => PAX_CATEGORIES.indexOf(row.category) * PAX_RESIDENCIES.length + PAX_RESIDENCIES.indexOf(row.residency);
const sortPax = (rows: readonly PaxRow[]): PaxRow[] => [...rows].sort((a, b) => order(a) - order(b));

/**
 * Moves a passenger count to a new total when the caller named a number but not who.
 *
 * Only an untiered booking can do this. Once passengers are split across categories, a bare number
 * does not say which of them left, and every rule for choosing — largest cell first, proportional,
 * cheapest first — is an invention that would quietly cancel the wrong people. Taking two off
 * `{ad: 4, chd: 2, inf: 1}` has no defensible answer, so it is refused and the caller sends a grid.
 */
export function retargetPax(rows: readonly PaxRow[], total: number): PaxRow[] {
  if (!Number.isInteger(total) || total < 0) invalid('pax must be a non-negative integer');
  if (total === paxTotal(rows)) return sortPax(rows);
  if (rows.length > 1) invalid('This booking counts passengers by category; send the pax grid to change it');
  if (rows.length === 0) return paxRowsFromTotal(total);
  return total === 0 ? [] : [{ ...rows[0], count: total }];
}
