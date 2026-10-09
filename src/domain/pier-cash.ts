/**
 * Pier petty cash (todo/pier-office-model.md; migration 170): legacy's §poCash. A cash box per pier
 * whose balance carries from day to day (`pcOpening`), its ledger rows (`pcRowSave`, `pcRowDel`), the
 * two month sheets the pier keys (longtail boats paid, `pcSetLT`; park and dock fees, `pcSetPK`),
 * pulling a sheet's day total into the ledger (`pcPull`), the month table (`pcMonthTable`) and the
 * receipt-substitute certificate (`pcPrintCert`, `pcBahtText`, `pcThDate`). Pure, so both stores
 * decide identically: a route reads the rows a rule needs, asks it, and writes what it answers.
 *
 * Not here (todo/pier-office-model.md, Open 1): the sheets' booked side (join heads and charter boats
 * from bookings, on-board heads by nationality, the expected park fee from the cost plan).
 */
import { refuse } from './booking-actions.js';
import { isIsoTime } from './calendar.js';
import { PIERS } from './catalogue.js';
import { dayOf, money } from './pier-money.js';
import { assertKnownKeys, withoutServerOwned } from './server-owned.js';

const bad = (message: string): never => refuse(message, 400);
const sum = (values: readonly number[]): number => money(values.reduce((s, v) => s + v, 0));

export const CASH_PIERS: readonly string[] = PIERS;
export type CashKind = 'in' | 'out';
export type CashSource = 'longtail' | 'park' | 'dock';
export const CASH_SOURCES: readonly CashSource[] = ['longtail', 'park', 'dock'];

/** A ledger row (legacy po_cash_rows). A deleted row stays, out of every total. */
export type CashRow = {
  id: string; pier: string; date: string; kind: CashKind; description: string | null; amount: number; time: string | null;
  source: CashSource | null; created_at: string; created_by: string | null;
  deleted_at: string | null; deleted_by: string | null; delete_reason: string | null;
};
/** The longtail sheet's cell for one boat and day (legacy po_cash_lt). */
export type LongtailCell = {
  pier: string; date: string; boat_id: string; join_boats: number | null; charter_boats: number | null; amount: number | null; note: string | null;
  updated_at: string; updated_by: string | null;
};
export const PARK_HEADS = ['ad_th', 'chd_th', 'inf_th', 'foc_th', 'ad_fr', 'chd_fr', 'inf_fr', 'foc_fr'] as const;
export type ParkHead = typeof PARK_HEADS[number];
/** The park-fee sheet's cell for one boat and day (legacy po_cash_pk). */
export type ParkCell = { pier: string; date: string; boat_id: string; amount: number | null; dock: number | null; filled_from: 'nat' | 'price' | null; updated_at: string; updated_by: string | null }
  & Record<ParkHead, number | null>;
export type CashSettings = { company_name: string | null; updated_at: string | null; updated_by: string | null };
export type Ctx = { now: string; by: string | null };

// ── Requests ──

export function parsePier(value: unknown): string {
  return typeof value === 'string' && CASH_PIERS.includes(value) ? value : bad(`pier must be one of ${CASH_PIERS.join(', ')}`);
}
export const parseDate = (value: unknown, name = 'date'): string => dayOf(value, name);
export function parseMonth(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : bad('month must be YYYY-MM');
}
/** The first and last day of a month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return bad(`${name} must be text`);
  return value.trim() || null;
};
const amountOf = (value: unknown, name: string, positive: boolean): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.replace(/,/g, '')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (positive && n <= 0)) return bad(`${name} must be a number${positive ? ' above 0' : ', 0 or more'}`);
  if (Math.abs(money(n) - n) > 1e-9) bad(`${name} has more than 2 decimals`);
  return money(n);
};
const optionalAmount = (value: unknown, name: string): number | null => (value === null || value === '' ? null : amountOf(value, name, false));
const count = (value: unknown, name: string): number | null => {
  if (value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : bad(`${name} must be a whole number, 0 or more`);
};

/** `POST …/rows`: legacy's add dialog. The amount must be above 0 ("ใส่จำนวนเงินก่อนครับ"). */
export function parseCashRow(body: Record<string, unknown>): { kind: CashKind; description: string | null; amount: number; time: string | null } {
  if (body.source !== undefined && body.source !== null) bad('source cannot be set: a sheet total is pulled in with POST /v1/pier-cash/{pier}/days/{date}/pull');
  assertKnownKeys(body, ['kind', 'description', 'amount', 'time', 'source'], 'A petty cash row');
  const kind = body.kind === 'in' || body.kind === 'out' ? body.kind : bad('kind must be in or out');
  const time = text(body.time, 'time');
  if (time !== null && !isIsoTime(time)) bad('time must be HH:MM');
  if (body.amount === undefined || body.amount === null || body.amount === '') bad('amount is required');
  return { kind: kind!, description: text(body.description, 'description'), amount: amountOf(body.amount, 'amount', true), time };
}
export const newCashRow = (pier: string, date: string, input: ReturnType<typeof parseCashRow>, id: string, ctx: Ctx): CashRow => ({
  id, pier, date, ...input, source: null, created_at: ctx.now, created_by: ctx.by, deleted_at: null, deleted_by: null, delete_reason: null,
});
/** `DELETE /v1/pier-cash/rows/{id}`: kept, out of every total. */
export function deleteCashRow(row: CashRow, reason: string | null, ctx: Ctx): CashRow {
  if (row.deleted_at) refuse(`Row ${row.id} is already deleted`, 409, 'row_deleted');
  return { ...row, deleted_at: ctx.now, deleted_by: ctx.by, delete_reason: reason };
}

// ── The day, the balance, the month ──

const live = (rows: readonly CashRow[]): CashRow[] => rows.filter((r) => !r.deleted_at);
/** The balance carried into a day: every earlier day's in − out at that pier (legacy `pcOpening`). */
export const openingOf = (rowsBefore: readonly CashRow[]): number =>
  sum(live(rowsBefore).map((r) => (r.kind === 'in' ? r.amount : -r.amount)));

export type DayTotals = {
  in: number; out: number; net: number;
  /** The sheets' figures for the day, which count in the ledger only once pulled (legacy §pcSum). */
  reference: { longtail: number; park: number; dock: number; total: number };
  pulled: number; waiting: number;
};
/** Legacy `pcTotals`, from the day's rows and sheet cells. */
export function dayTotals(rows: readonly CashRow[], longtail: readonly LongtailCell[], park: readonly ParkCell[]): DayTotals {
  const l = live(rows);
  const tin = sum(l.filter((r) => r.kind === 'in').map((r) => r.amount));
  const tout = sum(l.filter((r) => r.kind === 'out').map((r) => r.amount));
  const lt = sum(longtail.map((c) => c.amount ?? 0)), pk = sum(park.map((c) => c.amount ?? 0)), dock = sum(park.map((c) => c.dock ?? 0));
  const total = sum([lt, pk, dock]);
  const pulled = sum(l.filter((r) => r.source).map((r) => r.amount));
  return { in: tin, out: tout, net: money(tin - tout), reference: { longtail: lt, park: pk, dock, total }, pulled, waiting: Math.max(0, money(total - pulled)) };
}

/** Untimed rows last; at one time, in before out (legacy pushes in-rows first), then as added. */
const minutes = (time: string | null): number => (time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : 90000);
export const sortCashRows = (rows: readonly CashRow[]): CashRow[] => [...rows].sort((a, b) =>
  minutes(a.time) - minutes(b.time) || (a.kind === b.kind ? 0 : a.kind === 'in' ? -1 : 1) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export type CashRowView = CashRow & { balance: number | null };
export type LedgerDay = DayTotals & {
  pier: string; date: string; opening: number; closing: number;
  /** The balance below 0: legacy's "⚠ ติดลบ · ตรวจรายการ", a warning only. */
  negative: boolean;
  rows: CashRowView[];
  /** Deleted rows, with `?deleted=true`. */
  deleted?: CashRow[];
};
/** The ledger for one day (legacy `pcSheetMain`): each live row with the balance after it. */
export function ledgerDay(pier: string, date: string, opening: number, rows: readonly CashRow[], longtail: readonly LongtailCell[], park: readonly ParkCell[],
  withDeleted = false): LedgerDay {
  const t = dayTotals(rows, longtail, park);
  let run = opening;
  const views = sortCashRows(live(rows)).map((r) => { run = money(run + (r.kind === 'in' ? r.amount : -r.amount)); return { ...r, balance: run }; });
  const closing = money(opening + t.net);
  return { pier, date, opening, ...t, closing, negative: closing < 0, rows: views,
    ...(withDeleted ? { deleted: sortCashRows(rows.filter((r) => r.deleted_at)) } : {}) };
}

export type MonthDay = DayTotals & { date: string; opening: number; closing: number; negative: boolean };
export type MonthTable = { pier: string; month: string; opening: number; closing: number; days: MonthDay[]; totals: { in: number; out: number; reference: number } };
/**
 * Legacy `pcMonthTable`: every day of the month with money rows, sheet cells or boats running at the
 * pier, each carrying the balance on. `opening` is the balance carried into the month.
 */
export function monthTable(pier: string, month: string, opening: number, rows: readonly CashRow[], longtail: readonly LongtailCell[], park: readonly ParkCell[],
  boatDays: Iterable<string>): MonthTable {
  const dates = new Set<string>(boatDays);
  for (const r of live(rows)) dates.add(r.date);
  for (const c of longtail) dates.add(c.date);
  for (const c of park) dates.add(c.date);
  let run = opening;
  const days = [...dates].filter((d) => d.startsWith(month)).sort().map((date) => {
    const t = dayTotals(rows.filter((r) => r.date === date), longtail.filter((c) => c.date === date), park.filter((c) => c.date === date));
    const dayOpening = run;
    run = money(run + t.net);
    return { date, opening: dayOpening, ...t, closing: run, negative: run < 0 };
  });
  return { pier, month, opening, closing: run, days,
    totals: { in: sum(days.map((d) => d.in)), out: sum(days.map((d) => d.out)), reference: sum(days.map((d) => d.reference.total)) } };
}

/**
 * Legacy `pcPull`: the day's longtail, park and dock totals into the ledger as out rows, each
 * category once (a live pulled row of it blocks it); nothing new is `409 nothing_to_pull`.
 */
export function planPull(pier: string, date: string, totals: DayTotals, rows: readonly CashRow[], newId: () => string, ctx: Ctx): CashRow[] {
  const pulled = new Set(live(rows).map((r) => r.source).filter((s): s is CashSource => !!s));
  const want: [CashSource, number, string][] = [
    ['longtail', totals.reference.longtail, 'ค่าเรือหางยาว'], ['park', totals.reference.park, 'ค่าอุทยาน'], ['dock', totals.reference.dock, 'ค่าจอดเรือ'],
  ];
  const out = want.filter(([source, amount]) => amount > 0 && !pulled.has(source)).map(([source, amount, label]): CashRow => ({
    id: newId(), pier, date, kind: 'out', description: `${label} (ดึงจากชีท)`, amount, time: null, source,
    created_at: ctx.now, created_by: ctx.by, deleted_at: null, deleted_by: null, delete_reason: null,
  }));
  if (!out.length) refuse('No new totals to pull: already pulled, or nothing entered in the longtail and park sheets', 409, 'nothing_to_pull');
  return out;
}

// ── The sheets ──

export type LongtailView = LongtailCell & { used_boats: number };
export type ParkView = ParkCell & { heads: number };
export const longtailView = (c: LongtailCell): LongtailView => ({ ...c, used_boats: (c.join_boats ?? 0) + (c.charter_boats ?? 0) });
export const parkView = (c: ParkCell): ParkView => ({ ...c, heads: PARK_HEADS.reduce((s, k) => s + (c[k] ?? 0), 0) });

const LONGTAIL_OWNED = { pier: 'it is the path\'s', date: 'it is the path\'s', boat_id: 'it is the path\'s', used_boats: 'it is join_boats + charter_boats',
  n: 'it is join_boats + charter_boats', updated_at: 'nothing', updated_by: 'nothing' };
const PARK_OWNED = { pier: 'it is the path\'s', date: 'it is the path\'s', boat_id: 'it is the path\'s', heads: 'it is the sum of the 8 head counts',
  updated_at: 'nothing', updated_by: 'nothing' };

/**
 * `PATCH …/longtail/{boat}` (legacy `pcSetLT`, `pcSetLTNote`): the fields sent are set, `null`
 * clears one; a cell left with nothing is removed (`null` answered).
 */
export function applyLongtail(current: LongtailCell | undefined, key: { pier: string; date: string; boat_id: string }, body: Record<string, unknown>, ctx: Ctx): LongtailCell | null {
  const was = current ?? { ...key, join_boats: null, charter_boats: null, amount: null, note: null, updated_at: ctx.now, updated_by: ctx.by };
  const rest = withoutServerOwned(body, longtailView(was), LONGTAIL_OWNED);
  assertKnownKeys(rest, ['join_boats', 'charter_boats', 'amount', 'note'], 'A longtail cell');
  const next: LongtailCell = { ...was, updated_at: ctx.now, updated_by: ctx.by };
  if (rest.join_boats !== undefined) next.join_boats = count(rest.join_boats, 'join_boats');
  if (rest.charter_boats !== undefined) next.charter_boats = count(rest.charter_boats, 'charter_boats');
  if (rest.amount !== undefined) next.amount = optionalAmount(rest.amount, 'amount');
  if (rest.note !== undefined) next.note = text(rest.note, 'note');
  const empty = !next.join_boats && !next.charter_boats && !next.amount && !next.note;
  return empty ? null : next;
}

/** `PATCH …/park/{boat}` (legacy `pcSetPK`): no head, no fee and no dock fee left removes the cell. */
export function applyPark(current: ParkCell | undefined, key: { pier: string; date: string; boat_id: string }, body: Record<string, unknown>, ctx: Ctx): ParkCell | null {
  const blank = Object.fromEntries(PARK_HEADS.map((k) => [k, null])) as Record<ParkHead, number | null>;
  const was: ParkCell = current ?? { ...key, ...blank, amount: null, dock: null, filled_from: null, updated_at: ctx.now, updated_by: ctx.by };
  const rest = withoutServerOwned(body, parkView(was), PARK_OWNED);
  assertKnownKeys(rest, [...PARK_HEADS, 'amount', 'dock', 'filled_from'], 'A park cell');
  const next: ParkCell = { ...was, updated_at: ctx.now, updated_by: ctx.by };
  for (const k of PARK_HEADS) if (rest[k] !== undefined) next[k] = count(rest[k], k);
  if (rest.amount !== undefined) next.amount = optionalAmount(rest.amount, 'amount');
  if (rest.dock !== undefined) next.dock = optionalAmount(rest.dock, 'dock');
  if (rest.filled_from !== undefined) {
    next.filled_from = rest.filled_from === null || rest.filled_from === '' ? null
      : rest.filled_from === 'nat' || rest.filled_from === 'price' ? rest.filled_from : bad('filled_from must be nat, price or null');
  }
  const any = PARK_HEADS.some((k) => (next[k] ?? 0) > 0) || (next.amount ?? 0) > 0 || (next.dock ?? 0) > 0;
  return any ? next : null;
}

/** A boat running from the pier that day: a deployment on one of its routes. */
export type BoatOfDay = { date: string; boat_id: string; boat_name: string; route_id: string | null; route_name: string | null; route_color: string | null };
const boatsOf = (date: string, boats: readonly BoatOfDay[], cellBoats: readonly string[], names: ReadonlyMap<string, string>): BoatOfDay[] => {
  const out = boats.filter((b) => b.date === date);
  for (const id of cellBoats) if (!out.some((b) => b.boat_id === id)) out.push({ date, boat_id: id, boat_name: names.get(id) ?? id, route_id: null, route_name: null, route_color: null });
  return out.sort((a, b) => (a.route_name ?? '￿').localeCompare(b.route_name ?? '￿') || a.boat_name.localeCompare(b.boat_name) || (a.boat_id < b.boat_id ? -1 : 1));
};
const sheetDates = (month: string, only: string | undefined, boats: readonly BoatOfDay[], cells: readonly { date: string }[]): string[] =>
  only ? [only] : [...new Set([...boats.map((b) => b.date), ...cells.map((c) => c.date)])].filter((d) => d.startsWith(month)).sort();

type LongtailTotals = { join_boats: number; charter_boats: number; used_boats: number; amount: number };
const ltTotals = (cells: readonly LongtailView[]): LongtailTotals => ({
  join_boats: cells.reduce((s, c) => s + (c.join_boats ?? 0), 0), charter_boats: cells.reduce((s, c) => s + (c.charter_boats ?? 0), 0),
  used_boats: cells.reduce((s, c) => s + c.used_boats, 0), amount: sum(cells.map((c) => c.amount ?? 0)),
});
/** Legacy `pcSheetLT`, the pier's side: each day's boats and what was keyed for them. */
export function longtailSheet(pier: string, month: string, only: string | undefined, boats: readonly BoatOfDay[], cells: readonly LongtailCell[], names: ReadonlyMap<string, string>) {
  const days = sheetDates(month, only, boats, cells).map((date) => {
    const mine = cells.filter((c) => c.date === date);
    const rows = boatsOf(date, boats, mine.map((c) => c.boat_id), names).map((b) => {
      const c = mine.find((x) => x.boat_id === b.boat_id);
      return { ...b, cell: c ? longtailView(c) : null };
    });
    return { date, boats: rows, totals: ltTotals(mine.map(longtailView)) };
  }).filter((d) => d.boats.length);
  return { pier, month, ...(only ? { date: only } : {}), days, totals: ltTotals(days.flatMap((d) => d.boats.map((b) => b.cell).filter((c): c is LongtailView => !!c))) };
}

type ParkTotals = Record<ParkHead, number> & { heads: number; amount: number; dock: number };
const pkTotals = (cells: readonly ParkView[]): ParkTotals => ({
  ...Object.fromEntries(PARK_HEADS.map((k) => [k, cells.reduce((s, c) => s + (c[k] ?? 0), 0)])) as Record<ParkHead, number>,
  heads: cells.reduce((s, c) => s + c.heads, 0), amount: sum(cells.map((c) => c.amount ?? 0)), dock: sum(cells.map((c) => c.dock ?? 0)),
});
/** Legacy `pcSheetPK`, the pier's side: each day's boats and the heads and fees keyed for them. */
export function parkSheet(pier: string, month: string, only: string | undefined, boats: readonly BoatOfDay[], cells: readonly ParkCell[], names: ReadonlyMap<string, string>) {
  const days = sheetDates(month, only, boats, cells).map((date) => {
    const mine = cells.filter((c) => c.date === date);
    const rows = boatsOf(date, boats, mine.map((c) => c.boat_id), names).map((b) => {
      const c = mine.find((x) => x.boat_id === b.boat_id);
      return { ...b, cell: c ? parkView(c) : null };
    });
    return { date, boats: rows, totals: pkTotals(mine.map(parkView)) };
  }).filter((d) => d.boats.length);
  return { pier, month, ...(only ? { date: only } : {}), days, totals: pkTotals(days.flatMap((d) => d.boats.map((b) => b.cell).filter((c): c is ParkView => !!c))) };
}

// ── The receipt-substitute certificate (legacy `pcPrintCert`) ──

const TH_DIGIT = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const TH_PLACE = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
/** Legacy `_pcThGroup`: up to six digits. */
function thaiGroup(s: string): string {
  let out = '', prev = false;
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]), pos = s.length - 1 - i;
    if (!d) continue;
    if (pos === 1 && d === 1) out += 'สิบ';
    else if (pos === 1 && d === 2) out += 'ยี่สิบ';
    else if (pos === 0 && d === 1 && prev) out += 'เอ็ด';
    else out += TH_DIGIT[d] + TH_PLACE[pos];
    prev = true;
  }
  return out;
}
/** A whole number in Thai words, in groups of six digits joined by ล้าน (legacy `pcBahtText`). */
function thaiNumber(n: number): string {
  let s = String(n);
  const groups: string[] = [];
  while (s.length > 6) { groups.unshift(s.slice(-6)); s = s.slice(0, -6); }
  groups.unshift(s);
  return groups.map((g, i) => thaiGroup(g) + (i < groups.length - 1 ? 'ล้าน' : '')).join('');
}
/** Legacy `pcBahtText` ("หนึ่งพันสองร้อยบาทถ้วน"); satang, which legacy rounded away, as "…สตางค์". */
export function thaiBahtText(amount: number): string {
  const satang = Math.round(Math.abs(amount) * 100);
  const baht = Math.floor(satang / 100), rest = satang % 100;
  if (!baht && !rest) return 'ศูนย์บาทถ้วน';
  return `${baht ? `${thaiNumber(baht)}บาท` : ''}${rest ? `${thaiNumber(rest)}สตางค์` : 'ถ้วน'}`;
}
/** Legacy `pcThDate`: DD/MM/YYYY in the Buddhist era. */
export const thaiDate = (date: string): string => `${date.slice(8, 10)}/${date.slice(5, 7)}/${Number(date.slice(0, 4)) + 543}`;

/**
 * The day's out rows on the certificate, in ledger order; with `ids`, only those (legacy §pcPick:
 * "No rows selected." when none of them is an out row of the day). Needs the company name first
 * (legacy opens its dialog): `409 company_name_missing`.
 */
export function certificate(pier: string, date: string, company: string | null, rows: readonly CashRow[], ids: readonly string[] | undefined) {
  if (!company) refuse('Set the company name first: PUT /v1/pier-cash/settings {company_name}', 409, 'company_name_missing');
  let out = sortCashRows(live(rows).filter((r) => r.kind === 'out'));
  if (ids) {
    out = out.filter((r) => ids.includes(r.id));
    if (!out.length) bad('No rows selected.');
  }
  const total = sum(out.map((r) => r.amount));
  return {
    pier, date, date_th: thaiDate(date), company_name: company!, selected: !!ids,
    rows: out.map((r) => ({ id: r.id, description: r.description, source: r.source, time: r.time, amount: r.amount })),
    total, total_text_th: thaiBahtText(total),
  };
}

/** `PUT /v1/pier-cash/settings`. */
export function parseSettings(body: Record<string, unknown>): { company_name: string | null } {
  assertKnownKeys(body, ['company_name'], 'The petty cash settings');
  if (body.company_name === undefined) bad('company_name is required (null clears it)');
  return { company_name: text(body.company_name, 'company_name') };
}
