/**
 * Pickup areas and pickup times (todo/booking-extras-model.md §4, approved 2026-10-09; migration 043).
 * Legacy's "Pickup time setup" screen: `psuSaveArea`, `psuDeleteArea`, `psuSaveProfile`,
 * `psuSetTimeCell`, `_psuInheritTimesForArea`, and the lookup `bkV2GetPickupTime` / `psuResolveProfile`.
 * Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { isIsoDate } from './calendar.js';
import { pickupFields, pickupProblem, type PickupWindow } from './pickup.js';

export const AREA_ZONES = ['PK', 'KL', 'RN', 'NoTransfer'] as const;
export type PickupArea = { id: string; name: string; zone: typeof AREA_ZONES[number]; region: string | null; time_group: string; active: boolean };
export type TimeProfile = { id: string; name: string; from_date: string | null; to_date: string | null; notes: string | null; cloned_from: string | null; created_at: string };
export type PickupCell = PickupWindow & { profile_id: string; route_id: string; target: string };

const bad = (message: string): never => refuse(message, 400);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const text = (body: Record<string, unknown>, key: string): string | null | undefined => {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return typeof v === 'string' ? v : bad(`${key} must be text`);
};

// ── Areas ──

const PREFIX: Record<PickupArea['zone'], string> = { PK: 'pk', KL: 'kl', RN: 'rn', NoTransfer: 'nt' };
/** Legacy `psuSaveArea`: `<zone>-<name slug, 20 characters>`, with `-2`, `-3`… on a clash. Never changes after. */
export function areaId(name: string, zone: PickupArea['zone'], taken: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'area';
  const base = `${PREFIX[zone]}-${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function parseAreaPatch(body: Record<string, unknown>): Partial<Omit<PickupArea, 'id'>> {
  const patch: Partial<Omit<PickupArea, 'id'>> = {};
  const name = text(body, 'name'), group = text(body, 'time_group') ?? text(body, 'timeGroup'), region = text(body, 'region');
  if (name !== undefined) patch.name = name ?? bad('name is required');
  if (group !== undefined) patch.time_group = group ?? bad('time_group is required');
  if (region !== undefined) patch.region = region;
  if (body.zone !== undefined) patch.zone = (AREA_ZONES as readonly unknown[]).includes(body.zone) ? body.zone as PickupArea['zone'] : bad(`zone must be one of ${AREA_ZONES.join(', ')}`);
  if (body.active !== undefined) patch.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  return patch;
}
export function parseNewArea(body: Record<string, unknown>): Omit<PickupArea, 'id'> {
  const p = parseAreaPatch(body);
  if (!p.name) bad('name is required');
  if (!p.zone) bad(`zone is required: one of ${AREA_ZONES.join(', ')}`);
  if (!p.time_group) bad('time_group is required');
  return { name: p.name!, zone: p.zone!, region: p.region ?? null, time_group: p.time_group!, active: p.active ?? true };
}
export const sortAreas = (areas: readonly PickupArea[]): PickupArea[] => [...areas].sort((a, b) => cmp(a.zone, b.zone) || cmp(a.name, b.name) || cmp(a.id, b.id));

// ── Profiles and cells ──

export function parseProfile(body: Record<string, unknown>, current?: TimeProfile): Omit<TimeProfile, 'id' | 'created_at' | 'cloned_from'> {
  const name = text(body, 'name') ?? (body.name === undefined ? current?.name : undefined) ?? bad('name is required');
  const date = (key: 'from_date' | 'to_date') => {
    const v = body[key] === undefined ? current?.[key] ?? null : body[key];
    if (v === null) return null;
    return typeof v === 'string' && isIsoDate(v) ? v : bad(`${key} must be YYYY-MM-DD`);
  };
  const from = date('from_date'), to = date('to_date');
  if ((from === null) !== (to === null)) bad('from_date and to_date go together (both empty is the fallback profile)');
  if (from && to && to < from) bad('to_date is before from_date');
  const notes = text(body, 'notes');
  return { name: name!, from_date: from, to_date: to, notes: notes === undefined ? current?.notes ?? null : notes };
}

/** A cell's window, as the trip pickup fields take it (migration 024). */
export function parseCell(body: Record<string, unknown>): PickupWindow {
  const window: PickupWindow = {
    ...(typeof body.pickup_time === 'string' && body.pickup_time ? { pickup_time: body.pickup_time } : {}),
    ...(typeof body.pickup_time_end === 'string' && body.pickup_time_end ? { pickup_time_end: body.pickup_time_end } : {}),
    ...(body.pickup_at_pier === true ? { pickup_at_pier: true } : {}),
  };
  const problem = pickupProblem(window);
  if (problem) bad(problem);
  if (!window.pickup_time && !window.pickup_at_pier) bad('Send pickup_time, or pickup_time_end with pickup_at_pier for a pier deadline');
  return window;
}

/**
 * Legacy `psuResolveProfile`: of the profiles covering the date, the narrowest range, then the newest;
 * else the fallback profile (no dates; legacy's older flat table, decision D4).
 */
export function resolveProfile(profiles: readonly TimeProfile[], date: string): { dated: TimeProfile | undefined; fallback: TimeProfile | undefined } {
  const span = (p: TimeProfile) => Date.parse(p.to_date!) - Date.parse(p.from_date!);
  const dated = profiles.filter((p) => p.from_date && p.to_date && p.from_date <= date && date <= p.to_date)
    .sort((a, b) => span(a) - span(b) || cmp(b.created_at, a.created_at))[0];
  const fallback = profiles.filter((p) => !p.from_date).sort((a, b) => cmp(b.created_at, a.created_at))[0];
  return { dated, fallback };
}

/** Legacy `bkV2GetPickupTime`: the profile's cell for the area, else for its time group; then the fallback's. */
export function lookupPickupTime(profiles: readonly TimeProfile[], cells: readonly PickupCell[], area: PickupArea, routeId: string, date: string):
  (PickupWindow & { profile_id: string; target: string }) | undefined {
  const { dated, fallback } = resolveProfile(profiles, date);
  for (const profile of [dated, fallback]) {
    if (!profile) continue;
    for (const target of [area.id, area.time_group]) {
      const cell = cells.find((c) => c.profile_id === profile.id && c.route_id === routeId && c.target === target);
      if (cell) return { ...pickupFields(cell), profile_id: profile.id, target };
    }
  }
  return undefined;
}

/**
 * Legacy `_psuInheritTimesForArea`: a saved area gets, in every profile and route where it has no time,
 * the time of another area in its time group (the first by id).
 */
export function inheritedCells(area: PickupArea, areas: readonly PickupArea[], cells: readonly PickupCell[]): PickupCell[] {
  const siblings = areas.filter((a) => a.id !== area.id && a.time_group === area.time_group).map((a) => a.id).sort(cmp);
  const out: PickupCell[] = [];
  const keys = new Set(cells.map((c) => `${c.profile_id}|${c.route_id}`));
  for (const key of keys) {
    const [profileId, routeId] = key.split('|');
    if (cells.some((c) => c.profile_id === profileId && c.route_id === routeId && c.target === area.id)) continue;
    const from = siblings.map((id) => cells.find((c) => c.profile_id === profileId && c.route_id === routeId && c.target === id)).find(Boolean);
    if (from) out.push({ ...from, target: area.id });
  }
  return out;
}
