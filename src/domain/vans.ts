/**
 * The van fleet and its month matrix (slice A3 of todo/trip-ops-and-vans-model.md, migration 016):
 * the catalogue, which programmes each van serves on a date, its days off and its driver of the day.
 * Legacy's Vans page (`vehFormSave`, `vehDayToggleRoute`, `vehDaySetStatus`, `vehStatus*`,
 * `vanJobsSetDriver`) and its pools (`_vehUsableOn`, `vanVehiclesForRoute`, `vanVehiclesForZone`).
 * Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { isIsoDate } from './calendar.js';

export const VAN_OWNERSHIPS = ['own', 'rented', 'partner'] as const;
export const VAN_RANGE_STATUSES = ['off', 'maintenance'] as const;
export const VAN_DAY_STATUSES = ['available', 'off', 'maintenance'] as const;
export type VanRangeStatus = typeof VAN_RANGE_STATUSES[number];
export type VanDayStatus = typeof VAN_DAY_STATUSES[number];
export type Zone = 'PK' | 'KL';
const ZONES = ['PK', 'KL'] as const;

export type Van = {
  id: string; name: string; plate: string | null; type: string | null; capacity: number;
  ownership: typeof VAN_OWNERSHIPS[number]; partner_name: string | null; zone_base: Zone | null;
  color: string | null; driver: string | null; driver_phone: string | null; active: boolean; note: string | null;
};
export type VanInput = Omit<Van, 'id'>;
export type VanPatch = Partial<VanInput>;
/** A span off the road. `to_date` null is open-ended. Where spans overlap, the latest added (highest id) wins. */
export type VanStatusRange = { id: number; van_id: string; status: VanRangeStatus; from_date: string; to_date: string | null; note: string | null };
export type VanStatusRangeInput = Omit<VanStatusRange, 'id' | 'van_id'>;
/** A span the van works from another zone (legacy zoneOverrides). Either end may be open. Where spans overlap, the first added wins. */
export type VanZoneRange = { id: number; van_id: string; zone: Zone; from_date: string | null; to_date: string | null };
export type VanZoneRangeInput = Omit<VanZoneRange, 'id' | 'van_id'>;
/** One van on one date as stored: its programmes and its overrides. Every field null/empty = no row. */
export type StoredVanDay = {
  van_id: string; service_date: string; route_ids: string[];
  status: VanDayStatus | null; zone: Zone | null; driver: string | null; driver_phone: string | null; plate: string | null;
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
  const zone = pick(body, 'zone_base', ZONES);
  if (zone !== undefined) patch.zone_base = zone;
  if (body.color !== undefined) {
    const color = text(body, 'color');
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color!)) bad('color must be #rrggbb');
    patch.color = color === null ? null : color!.toLowerCase();
  }
  if (body.active !== undefined) patch.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  for (const key of ['plate', 'type', 'partner_name', 'driver', 'driver_phone', 'note'] as const) {
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
    color: null, driver: null, driver_phone: null, active: true, note: null,
  }, patch);
}

/** Legacy `vehFormSave`: an own van has no partner name (a rented one keeps its lessor's). */
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
  const zone = pick(body, 'zone', ZONES);
  if (zone !== undefined) patch.zone = zone;
  for (const key of ['driver', 'driver_phone', 'plate'] as const) {
    const v = text(body, key);
    if (v !== undefined) patch[key] = v;
  }
  // "Sent to the driver" is per job now (migration 080), stamped by the server.
  if (body.sent_at !== undefined) bad('sent_at is no longer a van-day field: a job is marked sent with PUT /operations/van-jobs/{date}/{key}/sent');
  return patch;
}

export const emptyVanDay = (vanId: string, date: string): StoredVanDay =>
  ({ van_id: vanId, service_date: date, route_ids: [], status: null, zone: null, driver: null, driver_phone: null, plate: null });
export const applyVanDayPatch = (day: StoredVanDay, patch: VanDayPatch): StoredVanDay => ({ ...day, ...patch, route_ids: [...(patch.route_ids ?? day.route_ids)] });
/** Nothing set: the stores keep no row for it. */
export const isEmptyVanDay = (d: StoredVanDay): boolean =>
  d.route_ids.length === 0 && d.status === null && d.zone === null && d.driver === null && d.driver_phone === null && d.plate === null;

/** Legacy `vehStatusOn`: the day's own status wins, then the latest range covering the date, else none. */
export function vanStatusOn(ranges: readonly VanStatusRange[], day: StoredVanDay | undefined, date: string): VanDayStatus | null {
  if (day?.status) return day.status;
  const covering = ranges.filter((r) => r.from_date <= date && (r.to_date === null || date <= r.to_date)).sort((a, b) => a.id - b.id);
  return covering.length ? covering[covering.length - 1].status : null;
}
/** Legacy `_vehUsableOn`: active, and not off or in maintenance that day. */
export const usableOn = (van: Van, status: VanDayStatus | null): boolean => van.active && status !== 'off' && status !== 'maintenance';

/** One cell of the matrix as `GET /operations/van-days` shows it. */
export type VanDayView = StoredVanDay & { status_on: VanDayStatus | null; usable: boolean; zone_on: Zone | null };
/** What the matrix reads besides the vans and their cells. */
export type MatrixContext = { statusRanges: readonly VanStatusRange[]; zoneRanges: readonly VanZoneRange[]; routePiers: ReadonlyMap<string, string | undefined> };

const PIER_ZONE: Record<string, Zone> = { panwa: 'PK', tublamu: 'KL' };
/**
 * Legacy `vehEffectiveZone`: the pier zone of the van's first route that day, else its day zone, else
 * the first zone range covering the date, else its base.
 */
export function vanZoneOn(van: Van, day: StoredVanDay | undefined, zoneRanges: readonly VanZoneRange[], routePiers: ReadonlyMap<string, string | undefined>, date: string): Zone | null {
  const fromRoute = (day?.route_ids ?? []).map((id) => PIER_ZONE[routePiers.get(id) ?? '']).find(Boolean);
  if (fromRoute) return fromRoute;
  if (day?.zone) return day.zone;
  const range = [...zoneRanges].sort((a, b) => a.id - b.id).find((r) => (r.from_date === null || r.from_date <= date) && (r.to_date === null || date <= r.to_date));
  return range?.zone ?? van.zone_base;
}

/**
 * Every van × every date of the range, in van then date order: the stored cell (or an empty one)
 * and what it comes to, so a client never re-derives the status or zone from the ranges.
 */
export function vanMatrix(vans: readonly Van[], days: readonly StoredVanDay[], dates: readonly string[], ctx: MatrixContext): VanDayView[] {
  const stored = new Map(days.map((d) => [`${d.van_id}|${d.service_date}`, d]));
  const byVan = <T extends { van_id: string }>(rows: readonly T[]) => {
    const out = new Map<string, T[]>();
    for (const r of rows) out.set(r.van_id, [...(out.get(r.van_id) ?? []), r]);
    return out;
  };
  const statusOf = byVan(ctx.statusRanges), zonesOf = byVan(ctx.zoneRanges);
  return sortVans(vans).flatMap((van) => dates.map((date) => {
    const day = stored.get(`${van.id}|${date}`);
    const status = vanStatusOn(statusOf.get(van.id) ?? [], day, date);
    return {
      ...(day ? applyVanDayPatch(day, {}) : emptyVanDay(van.id, date)), status_on: status, usable: usableOn(van, status),
      zone_on: vanZoneOn(van, day, zonesOf.get(van.id) ?? [], ctx.routePiers, date),
    };
  }));
}

// ── Zone ranges ──

const optionalDate = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && isIsoDate(v) ? v : bad(`${name} must be YYYY-MM-DD, or null for open`);
};
export function parseZoneRange(body: Record<string, unknown>): VanZoneRangeInput {
  const zone = pick(body, 'zone', ZONES) ?? bad('zone must be one of PK, KL');
  const from = optionalDate(body.from_date, 'from_date'), to = optionalDate(body.to_date, 'to_date');
  if (from !== null && to !== null && to < from) bad('to_date is before from_date');
  return { zone: zone!, from_date: from, to_date: to };
}
export const patchZoneRange = (range: VanZoneRange, body: Record<string, unknown>): VanZoneRange => ({
  ...range,
  ...parseZoneRange({
    zone: body.zone ?? range.zone,
    from_date: body.from_date !== undefined ? body.from_date : range.from_date,
    to_date: body.to_date !== undefined ? body.to_date : range.to_date,
  }),
});

// ── The van's log (legacy `vehLog`), in legacy's words ──

export type VanLogKind = 'created' | 'edit' | 'status' | 'zone' | 'driver';
export type VanLogLine = { kind: VanLogKind; text: string };
export type VanLogEntry = VanLogLine & { at: string; by: string | null };
const DAY_STATUS_TH: Record<VanDayStatus, string> = { available: 'พร้อม', maintenance: 'ซ่อม', off: 'หยุด' };

export const createdLine: VanLogLine = { kind: 'created', text: 'เพิ่มรถใหม่' };
/** Legacy `vehFormSave` / `vehSetField`: the active switch, base zone, driver and colour. */
export function vanEditLines(before: Van, after: Van): VanLogLine[] {
  const lines: VanLogLine[] = [];
  if (before.active !== after.active) lines.push({ kind: 'status', text: after.active ? 'เปลี่ยนเป็น Active' : 'เปลี่ยนเป็น Inactive' });
  if (before.zone_base !== after.zone_base) lines.push({ kind: 'zone', text: `ย้ายโซนหลัก ${before.zone_base ?? '?'} → ${after.zone_base ?? '?'}` });
  if (before.driver !== after.driver) lines.push({ kind: 'driver', text: `เปลี่ยนคนขับ → ${after.driver ?? '—'}` });
  if (before.color !== after.color) lines.push({ kind: 'edit', text: `เปลี่ยนสีประจำรถ → ${after.color ?? 'อัตโนมัติ'}` });
  return lines;
}
/** Legacy `vehDayToggleRoute`, `vehDayClearRoutes`, `vehDaySetStatus`, `vehDaySetZone`. The driver of the day is not logged. */
export function vanDayLines(before: StoredVanDay, after: StoredVanDay, routeName: (id: string) => string): VanLogLine[] {
  const date = after.service_date, lines: VanLogLine[] = [];
  if (after.route_ids.length === 0 && before.route_ids.length > 0) lines.push({ kind: 'zone', text: `${date} · ล้างเส้นทาง` });
  else {
    for (const id of before.route_ids) if (!after.route_ids.includes(id)) lines.push({ kind: 'zone', text: `${date} · เอาออกเส้นทาง ${routeName(id)}` });
    for (const id of after.route_ids) if (!before.route_ids.includes(id)) lines.push({ kind: 'zone', text: `${date} · เพิ่มเส้นทาง ${routeName(id)}` });
  }
  if (before.status !== after.status) lines.push({ kind: 'status', text: `${date} · ${after.status ? DAY_STATUS_TH[after.status] : 'ล้างสถานะ'}` });
  if (before.zone !== after.zone) lines.push({ kind: 'zone', text: `${date} · โซน ${after.zone ?? 'ตามหลัก'}` });
  return lines;
}
/** Legacy `vehStatusSet` logs a range once it has both ends; a delete is not logged. */
export const statusRangeLines = (r: VanStatusRangeInput): VanLogLine[] =>
  r.to_date ? [{ kind: 'status', text: `${DAY_STATUS_TH[r.status]} ${r.from_date}→${r.to_date}` }] : [];
/** Legacy `vehZoneSet` (once both ends are set) and `vehZoneDel`. */
export const zoneRangeLines = (r: VanZoneRangeInput): VanLogLine[] =>
  r.from_date && r.to_date ? [{ kind: 'zone', text: `สลับโซน ${r.zone} · ${r.from_date}→${r.to_date}` }] : [];
export const zoneRangeDeletedLine = (r: VanZoneRangeInput): VanLogLine => ({ kind: 'zone', text: `ลบช่วงสลับโซน ${r.zone}${r.from_date ? ` ${r.from_date}` : ''}` });

export function parseLogLimit(query: Record<string, unknown>): number {
  if (query.limit === undefined) return 100;
  const n = Number(query.limit);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : bad('limit must be a whole number from 1 to 500');
}

export const sortRanges = (ranges: readonly VanStatusRange[]): VanStatusRange[] => [...ranges].sort((a, b) => cmp(a.van_id, b.van_id) || a.id - b.id);
