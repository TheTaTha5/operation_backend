/**
 * Legacy's van job order stores as this service's rows (todo/van-job-orders-model.md, migration 080).
 * Pure, so `test/legacy-van-jobs.test.ts` checks the mapping on fixture rows; `import-legacy.ts` reads
 * the source and writes what these return.
 *
 * - `vanjob_sent` `date::van~route[~group]` → a mark on the one imported group of that van, route and
 *   day; else on the van's return-only run; a van that now runs the route twice keeps no mark, as
 *   legacy then shows its round-less key as unsent (the note's bug 2).
 * - `vanjob_sreq` → the booking's `job_note`, `""` (blanked) kept.
 * - `vanjob_pickup_th` → `pickup_name_th`, keyed as the API keys it (`pickupNameKey`).
 * - `app_meta.bkv2_grp_order` → each group's `display_order`.
 */
import { pickupNameKey } from '../domain/van-jobs.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Legacy keeps these values JSON-encoded in a text column (`"\"2026-07-09T11:16:19.776Z\""`). */
const json = (value: unknown): unknown => {
  if (value == null) return undefined;
  try { return JSON.parse(String(value)); } catch { return value; }
};

/** An imported van group, as the import made it: its legacy number before any renumbering. */
export type ImportedGroup = { id: string; day: string; route: string; zone: string; legacyNumber: number; van: string | null };
export type SentMark = { group_id: string | null; service_date: string | null; route_id: string | null; van_id: string | null; sent_at: string; sent_by: null; fingerprint: null };

/**
 * `returnRuns` holds `day|route|van` for every van that brings an imported part back on a route that
 * day (a return van of its own, or its group's). `note` counts what is dropped and why.
 */
export function sentMarks(rows: readonly Row[], groups: readonly ImportedGroup[], returnRuns: ReadonlySet<string>, note: (what: string) => void): SentMark[] {
  const marks = new Map<string, SentMark>();
  for (const r of rows) {
    const [day, job] = str(r.key).split('::');
    const [van, route, group] = (job ?? '').split('~');
    const at = str(json(r.value));
    if (!day || !ISO_DAY.test(day) || !van || !route || !at || Number.isNaN(Date.parse(at))) { note('sent marks dropped: bad key or no time'); continue; }
    const sentAt = new Date(at).toISOString();
    const vans = groups.filter((g) => g.day === day && g.route === route && g.van === van);
    const on = group ? vans.filter((g) => g.legacyNumber === Number(group)) : vans;
    let mark: SentMark;
    if (on.length === 1) {
      mark = { group_id: on[0].id, service_date: null, route_id: null, van_id: null, sent_at: sentAt, sent_by: null, fingerprint: null };
    } else if (on.length > 1) {
      note('sent marks dropped: the van now runs that programme more than once that day (legacy shows it unsent)'); continue;
    } else if (!group && returnRuns.has(`${day}|${route}|${van}`)) {
      mark = { group_id: null, service_date: day, route_id: route, van_id: van, sent_at: sentAt, sent_by: null, fingerprint: null };
      note('sent marks on a van that only brings people back');
    } else { note('sent marks dropped: no imported job for that van, programme and day'); continue; }
    const key = mark.group_id ?? `${day}|${route}|${van}`;
    // Two legacy keys landing on one job keep the later time.
    if (!marks.has(key) || marks.get(key)!.sent_at < sentAt) marks.set(key, mark);
  }
  return [...marks.values()];
}

/** `vanjob_sreq` → booking id → `job_note`; `""` stays: legacy's override cleared on purpose. */
export function jobNotes(rows: readonly Row[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const id = str(r.key), value = json(r.value);
    if (id && typeof value === 'string') out.set(id, value.trim());
  }
  return out;
}

/** `vanjob_pickup_th` → `pickup_name_th` rows. Names that fold to one key keep the first, in key order. */
export function thaiNames(rows: readonly Row[], note: (what: string) => void): { name_key: string; name: string; name_th: string }[] {
  const out = new Map<string, { name_key: string; name: string; name_th: string }>();
  for (const r of [...rows].sort((a, b) => (str(a.key) < str(b.key) ? -1 : str(a.key) > str(b.key) ? 1 : 0))) {
    const name = str(r.key), value = json(r.value), th = typeof value === 'string' ? value.trim() : '';
    if (!name || !th) { note('Thai pickup names dropped: no name or no Thai'); continue; }
    const key = pickupNameKey(name);
    if (out.has(key)) { note('Thai pickup names folded into one typed in another case'); continue; }
    out.set(key, { name_key: key, name, name_th: th });
  }
  return [...out.values()];
}

/**
 * `bkv2_grp_order` (a JSON string of `{"date::route::zone": [group numbers]}`) → group id → its place.
 * `groupOf` finds the imported group by its legacy key.
 */
export function groupOrders(value: unknown, groupOf: (day: string, route: string, zone: string, number: number) => string | undefined, note: (what: string) => void): Map<string, number> {
  let map = json(value);
  if (typeof map === 'string') map = json(map);
  const out = new Map<string, number>();
  if (!map || typeof map !== 'object') return out;
  for (const [key, list] of Object.entries(map as Record<string, unknown>)) {
    const [day, route, zone] = key.split('::');
    if (!Array.isArray(list)) { note('group orders dropped: not a list'); continue; }
    let place = 0;
    for (const n of list) {
      const id = groupOf(day, route, zone, Number(n));
      if (!id) { note('group order entries dropped: no imported group'); continue; }
      out.set(id, ++place);
    }
  }
  return out;
}
