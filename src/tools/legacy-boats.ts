/**
 * A legacy `boats` row, with its `boats__docs` and `boats__log` rows, as this service's boat (the
 * whole form, migration 070). Pure, so `test/legacy-boats.test.ts` checks the mapping on fixture
 * rows without a legacy database; `seed-boats.ts` reads the source and writes what this returns.
 *
 * `capacity` is the seats sold and `license_pax` the registered passenger maximum. A capacity above
 * the licence is accepted, as legacy accepts it (decided 2026-10-09): sales are capped at the licence
 * by `deploymentSeats`. Legacy's `totalcap` (licence + crew) is persons aboard: it becomes
 * `registered_persons`, a registration fact, and is never read as a selling limit. A row with no
 * id, no name or no usable capacity is skipped with the reason, never guessed.
 */
import { BOAT_MEASURES, type BoatDocument, type BoatRecord, type BoatStatus, type StatusEntry } from '../domain/catalogue.js';
import { isIsoDate } from '../domain/calendar.js';
import { plannedOverFromNote } from '../domain/fleet-availability.js';

type Row = Record<string, unknown>;

const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const text = (value: unknown): string | null => str(value) || null;
/** A non-negative whole number, null when blank, NaN when it is neither. Legacy keeps these as text. */
const whole = (value: unknown): number | null => {
  const s = str(value);
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
};
const measure = (value: unknown): number | null => {
  const s = str(value);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const realDate = (value: unknown): string | null => {
  const s = str(value);
  if (!isIsoDate(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : null;
};
const STATUSES: readonly string[] = ['available', 'fixing', 'unavailable', 'retired'];

export type LegacyBoat = { boat: BoatRecord; notes: string[] };

export function boatFromLegacy(row: Row, docRows: readonly Row[] = [], logRows: readonly Row[] = []): LegacyBoat | { skip: string } {
  const id = str(row.id), name = str(row.name);
  if (!id) return { skip: 'no id' };
  if (!name) return { skip: 'no name' };

  const capacity = whole(row.cap), license = whole(row.licensepax), crew = whole(row.crew);
  if (capacity === null || Number.isNaN(capacity) || capacity === 0) return { skip: `capacity "${str(row.cap)}" is not a positive whole number` };
  if (Number.isNaN(license)) return { skip: `licence "${str(row.licensepax)}" is not a whole number` };
  if (Number.isNaN(crew)) return { skip: `crew "${str(row.crew)}" is not a whole number` };
  const notes: string[] = [];
  const zeroIsNone = (n: number | null, what: string): number | null => {
    if (n !== null && Number.isNaN(n)) { notes.push(`${what} dropped: not a whole number`); return null; }
    return n === 0 ? null : n;
  };
  const engines = whole(row.enginecount);
  const engineCount = engines !== null && engines >= 1 && engines <= 5 ? engines : null;
  if (engines !== null && engineCount === null) notes.push(`engine count ${str(row.enginecount)} dropped: not 1 to 5`);
  const color = text(row.color);

  const documents: BoatDocument[] = [];
  for (const d of [...docRows].sort((a, b) => Number(a.idx) - Number(b.idx))) {
    const docName = str(d.name);
    if (!docName) { notes.push('a document with no name dropped'); continue; }
    const renew = str(d.renewstatus);
    documents.push({ name: docName, expires_on: realDate(d.exp), renew_status: renew === 'processing' || renew === 'done' ? renew : null });
    if (str(d.exp) && !realDate(d.exp)) notes.push(`document "${docName}": expiry "${str(d.exp)}" dropped`);
  }

  // Legacy's entry ids repeat (two rows saved in the same millisecond, or copied): made unique here.
  const log: StatusEntry[] = [];
  const seen = new Set<string>();
  for (const l of [...logRows].sort((a, b) => Number(a.idx) - Number(b.idx))) {
    const status = str(l.s), from = realDate(l.from), to = str(l.to) ? realDate(l.to) : null;
    if (!STATUSES.includes(status)) { notes.push(`status entry ${str(l.id)} dropped: status "${status}"`); continue; }
    if (!from) { notes.push(`status entry ${str(l.id)} dropped: from "${str(l.from)}"`); continue; }
    if (str(l.to) && !to) { notes.push(`status entry ${str(l.id)} dropped: to "${str(l.to)}"`); continue; }
    if (to !== null && to < from) { notes.push(`status entry ${str(l.id)} dropped: ends before it starts`); continue; }
    const base = str(l.id) || 'sl';
    let entryId = base, n = 2;
    while (seen.has(entryId)) entryId = `${base}-${n++}`;
    if (entryId !== base) notes.push(`status entry id ${base} repeats: kept as ${entryId}`);
    seen.add(entryId);
    log.push({
      id: entryId, status: status as BoatStatus, from_date: from, to_date: to, loc: text(l.loc), province: text(l.province), loc_type: text(l.loctype),
      detail: text(l.detail), note: text(l.note), reason: text(l.reason), project_id: text(l.projectid),
      // Legacy keeps "planned ahead" in the note, since its sync drops a new field (`LA_PLAN_MARK`).
      planned_over: status === 'available' ? plannedOverFromNote(text(l.note)) : null,
    });
  }

  return {
    notes,
    boat: {
      id, name, name_th: text(row.nameth), type: text(row.type), pier: text(row.pier), ownership: str(row.ownership) === 'charter' ? 'charter' : 'own',
      color: color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null, engine_count: engineCount,
      // A licence of 0 is no licence on file, not a ceiling of zero (`charterCeiling` then falls back to capacity).
      capacity, license_pax: license === 0 ? null : license, crew, fish_crew: zeroIsNone(whole(row.fishcrew), 'fishing crew'),
      registered_persons: zeroIsNone(whole(row.totalcap), 'total persons'),
      brand: null, model: null, vessel_use: text(row.use), material: text(row.material), reg: text(row.reg), callsign: text(row.callsign), imo: text(row.imo),
      build_year: text(row.year), homeport_city: text(row.homeportcity), homeport: text(row.homeport), owner: text(row.owner), owner_addr: text(row.owneraddr),
      note: text(row.note),
      ...Object.fromEntries(BOAT_MEASURES.map((k) => [k, measure(row[k])])) as Pick<BoatRecord, typeof BOAT_MEASURES[number]>,
      retired: row.retired === true || str(row.retired) === 'true', retired_on: null, retired_reason: null, unretired_on: null,
      documents, status_log: log, updated_at: null,
    },
  };
}
