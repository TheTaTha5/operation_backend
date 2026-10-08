/**
 * The van fleet and its month matrix (slice A3 of todo/trip-ops-and-vans-model.md, migration 016):
 * the catalogue, which programmes each van serves on a date, its days off and its driver of the day.
 * Legacy's Vans page (`vehFormSave`, `vehDayToggleRoute`, `vehDaySetStatus`, `vehStatus*`,
 * `vanJobsSetDriver`) and its pools (`_vehUsableOn`, `vanVehiclesForRoute`, `vanVehiclesForZone`).
 * Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { isIsoDate } from './calendar.js';

export const VAN_OWNERSHIPS = ['own', 'partner'] as const;
export const VAN_RANGE_STATUSES = ['off', 'maintenance'] as const;
export const VAN_DAY_STATUSES = ['available', 'off', 'maintenance'] as const;
export type VanRangeStatus = typeof VAN_RANGE_STATUSES[number];
export type VanDayStatus = typeof VAN_DAY_STATUSES[number];

export type Van = {
  id: string; name: string; plate: string | null; type: string | null; capacity: number;
  ownership: 'own' | 'partner'; partner_name: string | null; zone_base: 'PK' | 'KL' | null;
  color: string | null; driver: string | null; driver_phone: string | null; active: boolean;
};
export type VanInput = Omit<Van, 'id'>;
export type VanPatch = Partial<VanInput>;
/** A span off the road. `to_date` null is open-ended. Where spans overlap, the latest added (highest id) wins. */
export type VanStatusRange = { id: number; van_id: string; status: VanRangeStatus; from_date: string; to_date: string | null; note: string | null };
export type VanStatusRangeInput = Omit<VanStatusRange, 'id' | 'van_id'>;
/** One van on one date as stored: its programmes and its overrides. Every field null/empty = no row. */
export type StoredVanDay = {
  van_id: string; service_date: string; route_ids: string[];
  status: VanDayStatus | null; driver: string | null; driver_phone: string | null; plate: string | null; sent_at: string | null;
};
export type VanDayPatch = Partial<Omit<StoredVanDay, 'van_id' | 'service_date'>>;

const bad = (message: string): never => refuse(message, 400);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── The catalogue ──

const text = (body: Record<string, unknown>, key: string): string | null | undefined => {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === 'string' ? v.trim() || null : bad(`${key} must be text`);
};
const pick = <T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T | null | undefined => {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return (allowed as readonly unknown[]).includes(v) ? v as T : bad(`${key} must be one of ${allowed.join(', ')}`);
};

/** Every field a van carries is the client's; this checks shapes. Legacy's form names are accepted too. */
export function parseVanPatch(raw: Record<string, unknown>): VanPatch {
  const body: Record<string, unknown> = { ...raw };
  for (const [legacy, ours] of [['partnerName', 'partner_name'], ['zoneBase', 'zone_base'], ['driverPhone', 'driver_phone']] as const) {
    if (body[ours] === undefined && body[legacy] !== undefined) body[ours] = body[legacy];
  }
  const patch: VanPatch = {};
  if (body.name !== undefined) patch.name = text(body, 'name') ?? bad('name is required: legacy says "Please enter a vehicle name"');
  if (body.capacity !== undefined) patch.capacity = Number.isInteger(body.capacity) && (body.capacity as number) > 0 ? body.capacity as number : bad('capacity must be a whole number, 1 or more');
  const ownership = pick(body, 'ownership', VAN_OWNERSHIPS);
  if (ownership === null) bad(`ownership must be one of ${VAN_OWNERSHIPS.join(', ')}`);
  if (ownership !== undefined) patch.ownership = ownership!;
  const zone = pick(body, 'zone_base', ['PK', 'KL'] as const);
  if (zone !== undefined) patch.zone_base = zone;
  if (body.color !== undefined) {
    const color = text(body, 'color');
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color!)) bad('color must be #rrggbb');
    patch.color = color === null ? null : color!.toLowerCase();
  }
  if (body.active !== undefined) patch.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  for (const key of ['plate', 'type', 'partner_name', 'driver', 'driver_phone'] as const) {
    const v = text(body, key);
    if (v !== undefined) patch[key] = v;
  }
  return patch;
}

export function parseNewVan(body: Record<string, unknown>): VanInput {
  const patch = parseVanPatch(body);
  if (patch.name === undefined) bad('name is required: legacy says "Please enter a vehicle name"');
  // Legacy's new-van form starts at 9 seats, a van, own, PK, active.
  return applyVanPatch({
    name: '', plate: null, type: 'van', capacity: 9, ownership: 'own', partner_name: null, zone_base: 'PK',
    color: null, driver: null, driver_phone: null, active: true,
  }, patch);
}

/** Legacy `vehFormSave`: an own van has no partner name. */
export function applyVanPatch<T extends VanInput>(van: T, patch: VanPatch): T {
  const next = { ...van, ...patch };
  if (next.ownership === 'own') next.partner_name = null;
  return next;
}

/** Legacy `vehFormSave`: `veh` and one more than the highest number in use, two digits at least. */
export function nextVanId(ids: readonly string[]): string {
  const max = ids.reduce((m, id) => Math.max(m, Number.parseInt(id.replace(/^veh/, ''), 10) || 0), 0);
  return `veh${String(max + 1).padStart(2, '0')}`;
}

export const sortVans = (vans: readonly Van[]): Van[] => [...vans].sort((a, b) => cmp(a.id, b.id));

// ── Status ranges ──

function rangeDates(from: unknown, to: unknown): { from_date: string; to_date: string | null } {
  if (typeof from !== 'string' || !isIsoDate(from)) bad('from_date must be YYYY-MM-DD');
  if (to !== null && to !== undefined && to !== '' && (typeof to !== 'string' || !isIsoDate(to))) bad('to_date must be YYYY-MM-DD, or null for open-ended');
  const end = typeof to === 'string' && to !== '' ? to : null;
  if (end !== null && end < (from as string)) bad('to_date is before from_date');
  return { from_date: from as string, to_date: end };
}

export function parseStatusRange(body: Record<string, unknown>): VanStatusRangeInput {
  const status = pick(body, 'status', VAN_RANGE_STATUSES) ?? bad(`status must be one of ${VAN_RANGE_STATUSES.join(', ')}`);
  return { status: status!, ...rangeDates(body.from_date, body.to_date), note: text(body, 'note') ?? null };
}

/** A range edited in place keeps its place in the order (legacy edits the array entry). */
export function patchStatusRange(range: VanStatusRange, body: Record<string, unknown>): VanStatusRange {
  const merged = {
    status: body.status ?? range.status,
    from_date: body.from_date ?? range.from_date,
    to_date: body.to_date !== undefined ? body.to_date : range.to_date,
    note: body.note !== undefined ? body.note : range.note,
  };
  return { ...range, ...parseStatusRange(merged) };
}

// ── The month matrix ──

const MAX_DAYS = 93;
export function parseVanDayRange(query: Record<string, unknown>): { from: string; to: string } {
  const { from, to } = query;
  if (typeof from !== 'string' || !isIsoDate(from) || typeof to !== 'string' || !isIsoDate(to)) bad('from and to must be YYYY-MM-DD dates');
  if ((to as string) < (from as string)) bad('to is before from');
  if ((Date.parse(to as string) - Date.parse(from as string)) / 86_400_000 >= MAX_DAYS) bad(`Ask for ${MAX_DAYS} days or fewer`);
  return { from: from as string, to: to as string };
}

/** An absent field is unchanged; `null` (or `[]` for `route_ids`) clears it. */
export function parseVanDayPatch(raw: Record<string, unknown>, knownRoutes: ReadonlySet<string>): VanDayPatch {
  const body: Record<string, unknown> = { ...raw };
  if (body.driver_phone === undefined && body.phone !== undefined) body.driver_phone = body.phone;
  const patch: VanDayPatch = {};
  if (body.route_ids !== undefined) {
    if (body.route_ids !== null && !Array.isArray(body.route_ids)) bad('route_ids must be a list of route ids');
    const ids = (body.route_ids as unknown[] | null) ?? [];
    for (const [i, id] of ids.entries()) {
      if (typeof id !== 'string' || !id) bad(`route_ids[${i}] must be a route id`);
      if (!knownRoutes.has(id as string)) bad(`route_ids[${i}]: route ${id} does not exist`);
    }
    patch.route_ids = [...new Set(ids as string[])];
  }
  const status = pick(body, 'status', VAN_DAY_STATUSES);
  if (status !== undefined) patch.status = status;
  for (const key of ['driver', 'driver_phone', 'plate'] as const) {
    const v = text(body, key);
    if (v !== undefined) patch[key] = v;
  }
  if (body.sent_at !== undefined) {
    if (body.sent_at !== null && (typeof body.sent_at !== 'string' || Number.isNaN(Date.parse(body.sent_at)))) bad('sent_at must be an ISO 8601 instant, or null');
    patch.sent_at = body.sent_at === null ? null : new Date(body.sent_at as string).toISOString();
  }
  return patch;
}

export const emptyVanDay = (vanId: string, date: string): StoredVanDay =>
  ({ van_id: vanId, service_date: date, route_ids: [], status: null, driver: null, driver_phone: null, plate: null, sent_at: null });
export const applyVanDayPatch = (day: StoredVanDay, patch: VanDayPatch): StoredVanDay => ({ ...day, ...patch, route_ids: [...(patch.route_ids ?? day.route_ids)] });
/** Nothing set: the stores keep no row for it. */
export const isEmptyVanDay = (d: StoredVanDay): boolean =>
  d.route_ids.length === 0 && d.status === null && d.driver === null && d.driver_phone === null && d.plate === null && d.sent_at === null;

/** Legacy `vehStatusOn`: the day's own status wins, then the latest range covering the date, else none. */
export function vanStatusOn(ranges: readonly VanStatusRange[], day: StoredVanDay | undefined, date: string): VanDayStatus | null {
  if (day?.status) return day.status;
  const covering = ranges.filter((r) => r.from_date <= date && (r.to_date === null || date <= r.to_date)).sort((a, b) => a.id - b.id);
  return covering.length ? covering[covering.length - 1].status : null;
}
/** Legacy `_vehUsableOn`: active, and not off or in maintenance that day. */
export const usableOn = (van: Van, status: VanDayStatus | null): boolean => van.active && status !== 'off' && status !== 'maintenance';

/** One cell of the matrix as `GET /operations/van-days` shows it. */
export type VanDayView = StoredVanDay & { status_on: VanDayStatus | null; usable: boolean };

/**
 * Every van × every date of the range, in van then date order: the stored cell (or an empty one)
 * and what it comes to, so a client never re-derives the status from the ranges.
 */
export function vanMatrix(vans: readonly Van[], ranges: readonly VanStatusRange[], days: readonly StoredVanDay[], dates: readonly string[]): VanDayView[] {
  const stored = new Map(days.map((d) => [`${d.van_id}|${d.service_date}`, d]));
  const rangesOf = new Map<string, VanStatusRange[]>();
  for (const r of ranges) rangesOf.set(r.van_id, [...(rangesOf.get(r.van_id) ?? []), r]);
  return sortVans(vans).flatMap((van) => dates.map((date) => {
    const day = stored.get(`${van.id}|${date}`);
    const status = vanStatusOn(rangesOf.get(van.id) ?? [], day, date);
    return { ...(day ? applyVanDayPatch(day, {}) : emptyVanDay(van.id, date)), status_on: status, usable: usableOn(van, status) };
  }));
}

export const sortRanges = (ranges: readonly VanStatusRange[]): VanStatusRange[] => [...ranges].sort((a, b) => cmp(a.van_id, b.van_id) || a.id - b.id);
