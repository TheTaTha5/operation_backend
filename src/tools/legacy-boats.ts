/**
 * A legacy `boats` row as a row for this service's `boats` table. Pure, so
 * `test/legacy-boats.test.ts` checks the capacity rules on fixture rows without a legacy database;
 * `sync-boats.ts` reads the source and writes what this returns.
 *
 * The rules are the schema's (migration 005): `capacity` is the seats sold, `license_pax` the
 * registered passenger maximum, and a boat may never sell more than its licence. Legacy's `totalcap`
 * is `license_pax + crew` — persons aboard, not passengers — so it is never read here. A row that
 * breaks a rule is skipped with the reason, never clamped: which of the two numbers is wrong is an
 * ops question.
 */
type Row = Record<string, unknown>;
export type BoatRow = { id: string; name: string; type: string | null; pier: string | null; capacity: number; license_pax: number | null; crew: number | null };

const str = (value: unknown): string => (value == null ? '' : String(value).trim());
/** A non-negative whole number, null when blank, NaN when it is neither. Legacy keeps these as text. */
const whole = (value: unknown): number | null => {
  const s = str(value);
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
};

export function boatFromLegacy(row: Row): BoatRow | { skip: string } {
  const id = str(row.id), name = str(row.name);
  if (!id) return { skip: 'no id' };
  if (!name) return { skip: 'no name' };

  const capacity = whole(row.cap), license = whole(row.licensepax), crew = whole(row.crew);
  if (capacity === null || Number.isNaN(capacity) || capacity === 0) return { skip: `capacity "${str(row.cap)}" is not a positive whole number` };
  if (Number.isNaN(license)) return { skip: `licence "${str(row.licensepax)}" is not a whole number` };
  if (Number.isNaN(crew)) return { skip: `crew "${str(row.crew)}" is not a whole number` };
  // A licence of 0 is no licence on file, not a ceiling of zero: the charter ceiling then falls back
  // to capacity (`charterCeiling`), the same as a blank.
  const license_pax = license === 0 ? null : license;
  if (license_pax !== null && capacity > license_pax) return { skip: `capacity ${capacity} exceeds licence ${license_pax}` };

  return { id, name, type: str(row.type) || null, pier: str(row.pier) || null, capacity, license_pax, crew };
}
