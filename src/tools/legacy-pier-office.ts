/**
 * Legacy's pier office as rows for migrations 170–171 (todo/pier-office-model.md). Pure, so
 * `test/legacy-pier-office.test.ts` checks the mapping on fixture rows; `import-pier-office.ts` reads
 * the source and writes what this returns.
 *
 * - `po_cash_rows` → ledger rows: legacy's ids kept, `txt` → `description`, `at` → `time` (a one-digit
 *   hour padded), `src` lt/pk/dock → `source`, `ts` → `created_at`. A row with no usable pier, date,
 *   kind or amount above 0 is listed and skipped, never guessed.
 * - `po_cash_lt`, `po_cash_pk` → sheet cells, keyed pier + date + boat; a boat not in the catalogue is
 *   listed and skipped; a cell with nothing in it is dropped.
 * - `app_meta.po_cash_co` → the company name.
 * - The seven lists as they are; a staff member with no order goes after the ordered ones of the
 *   pier, in legacy's row order; a reference to a missing kind, group or licence type is listed.
 */
import type { Report } from './legacy-records.js';
import { CASH_PIERS, PARK_HEADS, type CashRow, type CashSource, type LongtailCell, type ParkCell } from '../domain/pier-cash.js';
import { CODE_KINDS, type AllLists, type AttendanceCode, type CodeKind, type Item, type ItemKind, type LicenseClass, type LicenseType, type Section, type Staff } from '../domain/pier-office.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const num = (value: unknown): number | null => (str(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const count = (value: unknown): number | null => { const n = num(value); return n === null ? null : Math.max(0, Math.round(n)); };
const money = (value: unknown): number | null => { const n = num(value); return n === null ? null : Math.round(Math.max(0, n) * 100) / 100; };
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SOURCES: Record<string, CashSource> = { lt: 'longtail', pk: 'park', dock: 'dock' };
/** `7:48` → `07:48`; anything else not a time → null. */
const timeOf = (value: unknown): string | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(value));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
};

export type LegacyPierOffice = {
  cashRows: Row[]; longtail: Row[]; park: Row[]; company: unknown;
  kinds: Row[]; items: Row[]; codes: Row[]; sections: Row[]; staff: Row[]; licenseTypes: Row[]; licenseClasses: Row[];
};
export type PierOfficeImport = { rows: CashRow[]; longtail: LongtailCell[]; park: ParkCell[]; companyName: string | null; lists: AllLists };

export function mapLegacyPierOffice(src: LegacyPierOffice, ctx: { boats: ReadonlySet<string>; now: string }, report: Report): PierOfficeImport {
  // ── Petty cash ──
  const rows: CashRow[] = [];
  const seen = new Set<string>();
  for (const r of src.cashRows) {
    const id = str(r.id), pier = str(r.pier), date = str(r.date), kind = str(r.kind), amount = money(r.amt);
    if (!id || seen.has(id)) { report.skip('petty cash row', id || '(none)', id ? 'id repeated' : 'no id'); continue; }
    if (!CASH_PIERS.includes(pier)) { report.skip('petty cash row', id, `pier "${pier}"`); continue; }
    if (!isDay(date)) { report.skip('petty cash row', id, `date "${date}"`); continue; }
    if (kind !== 'in' && kind !== 'out') { report.skip('petty cash row', id, `kind "${kind}"`); continue; }
    if (!amount) { report.skip('petty cash row', id, `amount ${str(r.amt) || '(none)'}`); continue; }
    seen.add(id);
    const time = timeOf(r.at);
    if (str(r.at) && !time) report.note(`petty cash rows with a time that is not HH:MM, kept without one`);
    const source = SOURCES[str(r.src)] ?? null;
    if (str(r.src) && !source) report.note(`petty cash rows with an unknown src, kept as typed rows`);
    const created = instant(r.ts);
    if (!created) report.note('petty cash rows with no time stamp, stamped with the import time');
    rows.push({
      id, pier, date, kind, description: str(r.txt) || null, amount, time, source: kind === 'out' ? source : null,
      created_at: created ?? ctx.now, created_by: str(r.by) || null, deleted_at: null, deleted_by: null, delete_reason: null,
    });
  }
  // A category pulled twice on one day is kept once (migration 170's index): the later rows become typed rows.
  const pulled = new Set<string>();
  for (const r of [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    if (!r.source) continue;
    const key = `${r.pier}|${r.date}|${r.source}`;
    if (pulled.has(key)) { report.note('pulled rows repeated on a day, kept as typed rows'); r.source = null; } else pulled.add(key);
  }

  const cellKey = (r: Row, what: string): { pier: string; date: string; boat_id: string } | undefined => {
    const pier = str(r.pier), date = str(r.date), boat = str(r.bid), id = str(r.id) || `${pier}|${date}|${boat}`;
    if (!CASH_PIERS.includes(pier)) { report.skip(what, id, `pier "${pier}"`); return undefined; }
    if (!isDay(date)) { report.skip(what, id, `date "${date}"`); return undefined; }
    if (!ctx.boats.has(boat)) { report.skip(what, id, `boat ${boat || '(none)'} is not in the catalogue`); return undefined; }
    return { pier, date, boat_id: boat };
  };
  const longtail: LongtailCell[] = [];
  for (const r of src.longtail) {
    const key = cellKey(r, 'longtail cell');
    if (!key) continue;
    let join = count(r.nj), charter = count(r.nc);
    if (join === null && charter === null && count(r.n)) { report.note('longtail cells with only a total (n), kept as join boats'); join = count(r.n); }
    const cell: LongtailCell = { ...key, join_boats: join, charter_boats: charter, amount: money(r.amt), note: str(r.note) || null,
      updated_at: instant(r.ts) ?? ctx.now, updated_by: str(r.by) || null };
    if (!cell.join_boats && !cell.charter_boats && !cell.amount && !cell.note) { report.note('empty longtail cells dropped'); continue; }
    longtail.push(cell);
  }
  const park: ParkCell[] = [];
  for (const r of src.park) {
    const key = cellKey(r, 'park cell');
    if (!key) continue;
    const heads = Object.fromEntries(PARK_HEADS.map((k) => [k, count(r[k])])) as Record<typeof PARK_HEADS[number], number | null>;
    const from = str(r.src);
    const cell: ParkCell = { ...key, ...heads, amount: money(r.amt), dock: money(r.dock), filled_from: from === 'nat' || from === 'price' ? from : null,
      updated_at: instant(r.ts) ?? ctx.now, updated_by: str(r.by) || null };
    if (!PARK_HEADS.some((k) => (cell[k] ?? 0) > 0) && !cell.amount && !cell.dock) { report.note('empty park cells dropped'); continue; }
    park.push(cell);
  }
  let company: unknown = src.company;
  if (typeof company === 'string') { try { company = JSON.parse(company); } catch { /* a plain string */ } }
  const companyName = str(company) || null;

  // ── The lists ──
  const sortOf = (value: unknown, i: number): number => { const n = num(value); return n === null ? i + 1 : Math.round(n); };
  const active = (value: unknown): boolean => value !== false && value !== 'false';
  const cut = (value: unknown, name: string): string | null => {
    const s = str(value);
    if (s.length > 40) report.note(`item kind ${name} longer than 40 characters, cut`);
    return s.slice(0, 40) || null;
  };
  const kinds: ItemKind[] = src.kinds.filter((r) => str(r.id)).map((r, i) => ({
    id: str(r.id), name: cut(r.name, 'names') ?? '', name_en: cut(r.name_en, 'English names'), unit: cut(r.unit, 'units') ?? 'ชิ้น',
    color: HEX.test(str(r.color)) ? str(r.color) : (report.note('item kinds with no usable colour, given the default'), '#5F6C7B'), sort: sortOf(r.ord, i), active: active(r.active),
  }));
  const kindIds = new Set(kinds.map((k) => k.id));
  const items: Item[] = [];
  for (const r of src.items) {
    const id = str(r.id), pier = str(r.pier), kind = str(r.kind), label = str(r.label);
    if (!id) { report.skip('item', '(none)', 'no id'); continue; }
    if (!CASH_PIERS.includes(pier)) { report.skip('item', id, `pier "${pier}"`); continue; }
    if (!kindIds.has(kind)) { report.skip('item', id, `kind ${kind || '(none)'} is not a kind`); continue; }
    if (!label) { report.skip('item', id, 'no label'); continue; }
    items.push({ id, pier, kind_id: kind, label, total: count(r.total) ?? 0, active: active(r.active), note: str(r.note) || null });
  }
  const codes: AttendanceCode[] = [];
  for (const [i, r] of src.codes.entries()) {
    const id = str(r.id), code = str(r.code);
    if (!id || !code) { report.skip('roster code', id || '(none)', 'no id or code'); continue; }
    if (codes.some((c) => c.code.toUpperCase() === code.toUpperCase())) { report.skip('roster code', id, `code ${code} repeated`); continue; }
    const kind = (CODE_KINDS as readonly string[]).includes(str(r.kind)) ? str(r.kind) as CodeKind : (report.note('roster codes with an unknown kind, counted as none'), 'none');
    codes.push({ id, code, label: str(r.label) || null, color: str(r.color) || '#5A6270', bg: str(r.bg) || '#F1F2F5', kind, sort: sortOf(r.ord, i), active: active(r.active) });
  }
  const sections: Section[] = [];
  for (const [i, r] of src.sections.entries()) {
    const id = str(r.id), pier = str(r.pier);
    if (!id || !CASH_PIERS.includes(pier)) { report.skip('roster group', id || '(none)', `pier "${pier}"`); continue; }
    sections.push({ id, pier, name: str(r.name), sort: sortOf(r.ord, i) });
  }
  const sectionPier = new Map(sections.map((s) => [s.id, s.pier]));
  const staff: Staff[] = [];
  const lastSort = new Map<string, number>();
  for (const r of src.staff) {
    const n = num(r.ord), pier = str(r.pier);
    if (n !== null && CASH_PIERS.includes(pier)) lastSort.set(pier, Math.max(lastSort.get(pier) ?? 0, Math.round(n)));
  }
  for (const r of src.staff) {
    const id = str(r.id), pier = str(r.pier), nick = str(r.nick), name = str(r.name);
    if (!id) { report.skip('staff', '(none)', 'no id'); continue; }
    if (!CASH_PIERS.includes(pier)) { report.skip('staff', id, `pier "${pier}"`); continue; }
    if (!nick && !name) { report.skip('staff', id, 'no nick or name'); continue; }
    let section: string | null = str(r.sect) || null;
    if (section && sectionPier.get(section) !== pier) { report.note('staff in a group missing or of another pier, left unassigned'); section = null; }
    let sort = num(r.ord);
    if (sort === null) { sort = (lastSort.get(pier) ?? 0) + 1; lastSort.set(pier, sort); }
    staff.push({ id, pier, nick: nick || name, name: name || nick, role: str(r.role) || null, phone: str(r.phone) || null, active: active(r.active),
      default_code: str(r.defcode).toUpperCase() || null, section_id: section, note: str(r.note) || null, sort: Math.round(sort) });
  }
  const types: LicenseType[] = [];
  for (const r of src.licenseTypes) {
    const id = str(r.id), side = str(r.side);
    if (!id || (side !== 'deck' && side !== 'eng')) { report.skip('licence type', id || '(none)', `side "${side}"`); continue; }
    types.push({ id, side, short: str(r.short) || id, formal: str(r.formal) || null, per_boat: count(r.perboat) ?? 1, active: active(r.active) });
  }
  const typeIds = new Set(types.map((t) => t.id));
  const classes: LicenseClass[] = [];
  for (const [i, r] of src.licenseClasses.entries()) {
    const id = str(r.id), type = str(r.typeid);
    if (!id || !typeIds.has(type)) { report.skip('licence class', id || '(none)', `type ${type || '(none)'} is not a licence type`); continue; }
    const lim = (v: unknown) => { const x = num(v); return x === null ? null : Math.max(0, x); };
    classes.push({ id, type_id: type, name: str(r.name) || id, max_gt: lim(r.maxgt), max_bhp: lim(r.maxbhp), sort: sortOf(r.ord, i) });
  }
  return { rows, longtail, park, companyName, lists: { 'item-kinds': kinds, items, 'attendance-codes': codes, sections, staff, 'license-types': types, 'license-classes': classes } };
}
