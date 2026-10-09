/**
 * Van parts and van groups (slice A2 of todo/trip-ops-and-vans-model.md, migration 016): who rides
 * which outbound van run. A trip's passengers are one part (idx 0) or split into several; a group is
 * the parts that ride one van together on one route and day, and holds the van, the default return
 * van and the pickup time. Legacy `bkV2VanGroup*`, `_bkV2VanNextGroup`, `_bkV2VanOtherGroups`,
 * `bkV2SplitApply`, `bkV2EffZone` and the van hand-off's rules R1–R14. Pure: a store reads one route's
 * day, these decide, and the store writes the plan back.
 */
import { refuse } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { isIsoTime } from './calendar.js';
import type { Booking, BookingTrip } from './operations.js';
import { PAX_CATEGORIES, parsePaxGrid, type PaxCategory, type PaxRow } from './pax.js';
import { outboundSeats, sortStops, type VanStop } from './van-stops.js';
import type { Van } from './vans.js';

export type Counts = Record<PaxCategory, number>;
export type VanGroup = {
  id: string; service_date: string; route_id: string; zone: string; number: number;
  van_id: string | null; return_van_id: string | null; pickup_time: string | null;
};
/** An alternate pickup or drop-off point; only an `alt_pickup` part has one (slice D builds them). */
export type AltPoint = { pick_area_id: string | null; pick_hotel: string | null; pick_zone: string | null; drop_area_id: string | null; drop_hotel: string | null; drop_zone: string | null };
export type PartSource = 'main' | 'manual' | 'alt_pickup';
export type StoredVanPart = Counts & {
  idx: number; source: PartSource; group_id: string | null; sequence: number | null; return_van_id: string | null; alt: AltPoint | null;
};
export type GroupRef = Pick<VanGroup, 'id' | 'number' | 'van_id' | 'return_van_id' | 'pickup_time'>;
/** As a booking read shows a part, under the trip's `operations.van_parts`. */
export type VanPartView = Omit<StoredVanPart, 'group_id'> & { group: GroupRef | null };

export const CHARTER_ZONE = '__CHARTER__';
const SELF_ARRIVE = new Set(['NoTransfer', 'NT']);
export const isSelfArrive = (zone: string): boolean => SELF_ARRIVE.has(zone);

const bad = (message: string): never => refuse(message, 400);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const countsOf = (pax: readonly PaxRow[]): Counts => {
  const counts: Counts = { ad: 0, chd: 0, inf: 0, foc: 0 };
  for (const row of pax) counts[row.category] += row.count;
  return counts;
};
/** Every category takes a seat, infants and FOC included (R5). */
export const partPax = (c: Counts): number => c.ad + c.chd + c.inf + c.foc;

const whole = (pax: Counts): StoredVanPart => ({ idx: 0, source: 'main', ...pax, group_id: null, sequence: null, return_van_id: null, alt: null });
/** A trip with no rows is one whole, ungrouped part (016). */
export const partsOrWhole = (stored: readonly StoredVanPart[], pax: Counts): StoredVanPart[] =>
  stored.length ? stored.map((p) => ({ ...p, alt: p.alt && { ...p.alt } })) : [whole(pax)];
/** What a store keeps: nothing at all for a whole, ungrouped part. */
export const partsToStore = (parts: readonly StoredVanPart[]): StoredVanPart[] => {
  const [only] = parts;
  return parts.length === 1 && only.group_id === null && only.sequence === null && only.return_van_id === null ? [] : parts.map((p) => ({ ...p }));
};

export function vanPartsView(stored: readonly StoredVanPart[], pax: readonly PaxRow[], groups: ReadonlyMap<string, VanGroup>): VanPartView[] {
  return partsOrWhole(stored, countsOf(pax)).map(({ group_id, ...part }) => {
    const g = group_id ? groups.get(group_id) : undefined;
    return { ...part, group: g ? { id: g.id, number: g.number, van_id: g.van_id, return_van_id: g.return_van_id, pickup_time: g.pickup_time } : null };
  });
}

/**
 * The parts after the trip's passengers change. The main part takes the change; when the passengers
 * fall below what the other parts carry, those shrink from the last one back, and an emptied one goes.
 */
export function rebalanceParts(stored: readonly StoredVanPart[], pax: readonly PaxRow[]): StoredVanPart[] {
  if (stored.length === 0) return [];
  const want = countsOf(pax);
  const [main, ...rest] = stored.map((p) => ({ ...p }));
  for (const c of PAX_CATEGORIES) {
    let others = rest.reduce((s, p) => s + p[c], 0);
    for (let i = rest.length - 1; i >= 0 && others > want[c]; i--) {
      const cut = Math.min(rest[i][c], others - want[c]);
      rest[i][c] -= cut; others -= cut;
    }
    main[c] = want[c] - others;
  }
  return partsToStore([main, ...rest.filter((p) => partPax(p) > 0)]);
}

/**
 * The zone a trip is grouped in (legacy `_bkV2InZone`, `bkV2EffZone`): a charter has its own; else the
 * trip's zone or the booking's pickup zone; and a NoTransfer seat with a private-van add-on
 * (`transfer-<route>-<PK|KL>-<vehicle>`) is picked up in that van's zone.
 */
export function effectiveZone(booking: Pick<Booking, 'pickup_zone' | 'add_ons'>, trip: Pick<BookingTrip, 'booking_mode' | 'zone' | 'route_id'>): string {
  if (trip.booking_mode === 'charter') return CHARTER_ZONE;
  const base = trip.zone || booking.pickup_zone || '';
  if (base && !isSelfArrive(base)) return base;
  const prefix = `transfer-${trip.route_id}-`;
  const privateVan = booking.add_ons.find((a) => a.type.startsWith(prefix))?.type.match(/^transfer-(.+)-(PK|KL|NoTransfer)-([a-z]+)$/i);
  return privateVan && privateVan[2] !== 'NoTransfer' ? privateVan[2] : base;
}

// ── One route's day ──

export type DayTrip = {
  trip_id: string; booking_id: string; active: boolean; zone: string; pax: Counts;
  /** The final pickup, else the booked one: what orders a group and its rounds (R6, R12). */
  pickup_time: string | null; return_same_van: boolean; parts: StoredVanPart[];
};
export type VanDayState = { service_date: string; route_id: string; groups: VanGroup[]; trips: DayTrip[]; stops: VanStop[] };

/** A booking read's parts back as stored (a whole, ungrouped part reads the same either way). */
export const partsFromView = (parts: readonly VanPartView[]): StoredVanPart[] =>
  parts.map(({ group, ...p }) => ({ ...p, alt: p.alt && { ...p.alt }, group_id: group?.id ?? null }));

/** One route's day from its bookings (as read) and groups. */
export function vanDayState(bookings: readonly Booking[], groups: readonly VanGroup[], stops: readonly VanStop[], date: string, routeId: string): VanDayState {
  const trips = bookings.flatMap((b) => b.trips.filter((t) => t.service_date === date && t.route_id === routeId).map((t): DayTrip => {
    const pax = countsOf(parsePaxGrid(t.pax));
    return {
      trip_id: t.id, booking_id: b.id, active: !(SEAT_RELEASING_STATUSES as readonly string[]).includes(b.status), zone: effectiveZone(b, t), pax,
      pickup_time: t.operations.pickup_time_final ?? t.pickup_time ?? null, return_same_van: t.operations.return_same_van,
      parts: partsFromView(t.operations.van_parts),
    };
  }));
  return { service_date: date, route_id: routeId, groups: groups.map((g) => ({ ...g })), trips, stops: stops.map((x) => ({ ...x })) };
}

type Member = { trip: DayTrip; part: StoredVanPart };
/** The parts of a group that ride (R1: a cancelled booking takes no part). */
const membersOf = (state: VanDayState, groupId: string): Member[] =>
  state.trips.filter((t) => t.active).flatMap((trip) => trip.parts.filter((p) => p.group_id === groupId).map((part) => ({ trip, part })));
const customerPax = (state: VanDayState, groupId: string): number => membersOf(state, groupId).reduce((s, m) => s + partPax(m.part), 0);
const stopsOf = (state: VanDayState, groupId: string): VanStop[] => sortStops(state.stops.filter((x) => x.group_id === groupId));
/** R5 plus van stops: customers and the guides riding along take seats (legacy `bkV2VanGroupPax`). */
const groupPax = (state: VanDayState, groupId: string): number => customerPax(state, groupId) + stopsOf(state, groupId).reduce((s, x) => s + outboundSeats(x), 0);

// ── Vans that day ──

/** A van as the pools see it on one date: usable or not, its programmes, and its zone that day (`vanZoneOn`). */
export type VanOnDay = { van: Van; usable: boolean; route_ids: string[]; zone: string | null };
/** R2 (`vanVehiclesForRoute`): usable vans the month matrix puts on this programme. No zone fallback. */
export const outboundPool = (vans: readonly VanOnDay[], routeId: string): VanOnDay[] => vans.filter((v) => v.usable && v.route_ids.includes(routeId));
/** R3 (`vanVehiclesForZone`): the outbound pool, plus usable vans based in the zone; a charter or other zone takes any usable van. */
export function returnPool(vans: readonly VanOnDay[], routeId: string, zone: string): VanOnDay[] {
  if (isSelfArrive(zone)) return [];
  const outbound = new Set(outboundPool(vans, routeId).map((v) => v.van.id));
  if (zone !== 'PK' && zone !== 'KL') return vans.filter((v) => v.usable);
  return vans.filter((v) => outbound.has(v.van.id) || (v.usable && v.zone === zone));
}

// ── Plans: what a command changes ──

export type VanPlan = {
  groups: VanGroup[]; deleteGroups: string[]; parts: Map<string, StoredVanPart[]>;
  /** Trip dispatch fields to set (`pickup_time_final` resets its window; `return_same_van`). */
  dispatch: Map<string, { pickup_time_final?: string | null; return_same_van?: boolean }>;
};
const emptyPlan = (): VanPlan => ({ groups: [], deleteGroups: [], parts: new Map(), dispatch: new Map() });
/** Applies a trip's new parts to the state, so later checks (seats) see them, and to the plan as a store keeps them. */
function putParts(state: VanDayState, plan: VanPlan, trip: DayTrip, parts: StoredVanPart[]): void {
  trip.parts = parts;
  plan.parts.set(trip.trip_id, partsToStore(parts));
}
function putGroup(state: VanDayState, plan: VanPlan, group: VanGroup): void {
  state.groups = [...state.groups.filter((g) => g.id !== group.id), group];
  plan.groups = [...plan.groups.filter((g) => g.id !== group.id), group];
}
const groupOf = (state: VanDayState, id: string): VanGroup =>
  state.groups.find((g) => g.id === id) ?? refuse(`Van group ${id} not found`, 404);

export type MemberRef = { trip_id: string; idx: number };
export function parseMembers(value: unknown, name = 'members'): MemberRef[] {
  if (!Array.isArray(value) || value.length === 0) bad(`${name} must be a list of {trip_id, idx}, one or more`);
  const refs = (value as unknown[]).map((raw, i) => {
    const m = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`${name}[${i}] must be an object`);
    const tripId = m.trip_id ?? m.booking_trip_id;
    if (typeof tripId !== 'string' || !tripId) bad(`${name}[${i}].trip_id is required`);
    const idx = m.idx ?? 0;
    if (!Number.isInteger(idx) || (idx as number) < 0) bad(`${name}[${i}].idx must be a whole number, 0 or more`);
    return { trip_id: tripId as string, idx: idx as number };
  });
  if (new Set(refs.map((r) => `${r.trip_id}#${r.idx}`)).size !== refs.length) bad(`${name} names a part twice`);
  return refs;
}

/** A part that may join a group of `zone`: on this route's day, riding, and from that zone (R1, R9). */
function joinable(state: VanDayState, ref: MemberRef, zone: string, label: string): Member {
  const trip = state.trips.find((t) => t.trip_id === ref.trip_id) ?? bad(`${label}: trip ${ref.trip_id} is not on route ${state.route_id} on ${state.service_date}`);
  const part = trip!.parts.find((p) => p.idx === ref.idx) ?? bad(`${label}: trip ${ref.trip_id} has no van part ${ref.idx}`);
  if (!trip!.active) refuse(`${label}: booking ${trip!.booking_id} is cancelled and rides no van`, 409, 'cancelled');
  if (isSelfArrive(trip!.zone)) refuse(`${label}: trip ${ref.trip_id} comes to the pier on its own (${trip!.zone}) and rides no van`, 409, 'self_arrive');
  if (trip!.zone !== zone) refuse(`${label}: trip ${ref.trip_id} is picked up in zone ${trip!.zone || '(none)'}, not ${zone}`, 409, 'zone_mismatch');
  return { trip: trip!, part: part! };
}

export function assertCapacity(state: VanDayState, group: VanGroup, vans: readonly VanOnDay[]): void {
  if (!group.van_id) return;
  const van = vans.find((v) => v.van.id === group.van_id)?.van;
  const pax = groupPax(state, group.id);
  if (van && pax > van.capacity) {
    refuse(`Not enough seats: group ${group.number} needs ${pax} seats and ${van.name} seats ${van.capacity}. Split the passengers, make a new group, or pick a bigger van`, 409, 'van_over_capacity');
  }
}

/** Moves parts into a group, numbered after its last member (legacy `bkV2VanGroupSelected`). */
function addParts(state: VanDayState, plan: VanPlan, group: VanGroup, refs: readonly MemberRef[], vans: readonly VanOnDay[]): void {
  const members = refs.map((ref, i) => joinable(state, ref, group.zone, `members[${i}]`));
  let seq = membersOf(state, group.id).reduce((m, x) => Math.max(m, x.part.sequence ?? 0), 0);
  for (const { trip, part } of members) {
    putParts(state, plan, trip, trip.parts.map((p) => (p.idx === part.idx ? { ...p, group_id: group.id, sequence: ++seq } : p)));
  }
  assertCapacity(state, group, vans);
}

export function createGroup(state: VanDayState, body: Record<string, unknown>, vans: readonly VanOnDay[], id: string): { plan: VanPlan; group: VanGroup } {
  const zone = typeof body.zone === 'string' && body.zone ? body.zone : bad('zone is required (the members\' pickup zone, or __CHARTER__)');
  const refs = parseMembers(body.members);
  const plan = emptyPlan();
  // One sequence per route and day across every zone, as legacy numbers them; a kept, emptied group keeps its number.
  const group: VanGroup = { id, service_date: state.service_date, route_id: state.route_id, zone: zone!, number: state.groups.reduce((m, g) => Math.max(m, g.number), 0) + 1, van_id: null, return_van_id: null, pickup_time: null };
  putGroup(state, plan, group);
  addParts(state, plan, group, refs, vans);
  if (body.van_id !== undefined && body.van_id !== null) {
    return { plan, group: setGroup(state, group.id, { van_id: body.van_id, allow_second_round: body.allow_second_round }, vans, plan) };
  }
  return { plan, group };
}

export function addMembers(state: VanDayState, groupId: string, body: Record<string, unknown>, vans: readonly VanOnDay[]): VanPlan {
  const plan = emptyPlan();
  addParts(state, plan, groupOf(state, groupId), parseMembers(body.members), vans);
  return plan;
}

const vanIdField = (body: Record<string, unknown>, key: string): string | null | undefined => {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return typeof v === 'string' ? v : bad(`${key} must be a van id`);
};

/**
 * `PATCH /operations/van-groups/{id}`: the van (R2 pool, R4 seats, R6 a second round needs
 * `allow_second_round`), the return van (R3 pool; members stop coming back on the same van, R11) and
 * the pickup time, which is also every member's final pickup (legacy `bkV2VanGroupSetTime`).
 */
export function setGroup(state: VanDayState, groupId: string, body: Record<string, unknown>, vans: readonly VanOnDay[], plan: VanPlan = emptyPlan()): VanGroup {
  let group = { ...groupOf(state, groupId) };
  const vanId = vanIdField(body, 'van_id'), returnId = vanIdField(body, 'return_van_id');
  if (body.allow_second_round !== undefined && typeof body.allow_second_round !== 'boolean') bad('allow_second_round must be true or false');
  if (vanId) {
    const van = outboundPool(vans, state.route_id).find((v) => v.van.id === vanId)
      ?? refuse(`Van ${vanId} is not assigned to route ${state.route_id} on ${state.service_date}, or is off that day: assign it in the month matrix first`, 409, 'van_not_in_pool');
    const others = otherRounds(state, vanId, group.id);
    if (others.length && body.allow_second_round !== true) {
      const list = others.map((o) => `group ${o.number} · ${o.pickup_time ?? 'no time set'}`).join('; ');
      refuse(`${van!.van.name} already runs another group of this programme (${list}). Send allow_second_round: true to run it again, ${others.length + 1} rounds today; set a different pickup time for each`, 409, 'van_in_other_group');
    }
  }
  if (vanId !== undefined) group.van_id = vanId;
  if (returnId) {
    if (!returnPool(vans, state.route_id, group.zone).some((v) => v.van.id === returnId)) {
      refuse(`Van ${returnId} cannot bring zone ${group.zone} back on ${state.service_date}`, 409, 'van_not_in_pool');
    }
    for (const { trip } of membersOf(state, group.id)) plan.dispatch.set(trip.trip_id, { ...plan.dispatch.get(trip.trip_id), return_same_van: false });
  }
  if (returnId !== undefined) group.return_van_id = returnId;
  if (body.pickup_time !== undefined) {
    const time = body.pickup_time === null || body.pickup_time === '' ? null : typeof body.pickup_time === 'string' && isIsoTime(body.pickup_time.trim()) ? body.pickup_time.trim() : bad('pickup_time must be HH:MM, or null');
    group.pickup_time = time;
    // Legacy writes an own-pickup part's time to the part (pick_time, slice D); every other member's trip gets it.
    for (const { trip, part } of membersOf(state, group.id)) if (part.source !== 'alt_pickup') plan.dispatch.set(trip.trip_id, { ...plan.dispatch.get(trip.trip_id), pickup_time_final: time });
  }
  putGroup(state, plan, group);
  assertCapacity(state, group, vans);
  return group;
}

/** R6: the other groups of this route's day the van already runs, with their time. */
function otherRounds(state: VanDayState, vanId: string, groupId: string): { number: number; pickup_time: string | null }[] {
  return state.groups.filter((g) => g.van_id === vanId && g.id !== groupId && membersOf(state, g.id).length > 0)
    .map((g) => ({ number: g.number, pickup_time: g.pickup_time ?? earliest(membersOf(state, g.id)) }))
    .sort((a, b) => a.number - b.number);
}
const earliest = (members: readonly Member[]): string | null =>
  members.map((m) => m.trip.pickup_time).filter((t): t is string => !!t).sort(cmp)[0] ?? null;

/** R12: `members` in pickup order become 1..n; `clear: true` drops the manual order (sort by time). */
export function orderGroup(state: VanDayState, groupId: string, body: Record<string, unknown>): VanPlan {
  const group = groupOf(state, groupId), plan = emptyPlan();
  const members = membersOf(state, group.id);
  if (body.clear === true) {
    for (const { trip } of members) putParts(state, plan, trip, trip.parts.map((p) => (p.group_id === group.id ? { ...p, sequence: null } : p)));
    return plan;
  }
  const refs = parseMembers(body.members);
  const key = (r: MemberRef) => `${r.trip_id}#${r.idx}`;
  const want = new Set(members.map((m) => key({ trip_id: m.trip.trip_id, idx: m.part.idx })));
  if (refs.length !== want.size || refs.some((r) => !want.has(key(r)))) bad(`members must list each of group ${group.number}'s ${want.size} members once`);
  refs.forEach((ref, i) => {
    const trip = state.trips.find((t) => t.trip_id === ref.trip_id)!;
    putParts(state, plan, trip, trip.parts.map((p) => (p.idx === ref.idx ? { ...p, sequence: i + 1 } : p)));
  });
  return plan;
}

/** R13: members lose the group, their order and their return van; their final pickup stays. The group goes. */
export function disbandGroup(state: VanDayState, groupId: string): VanPlan {
  const group = groupOf(state, groupId), plan = emptyPlan();
  for (const trip of state.trips) {
    if (trip.parts.some((p) => p.group_id === group.id)) {
      putParts(state, plan, trip, trip.parts.map((p) => (p.group_id === group.id ? { ...p, group_id: null, sequence: null, return_van_id: null } : p)));
    }
  }
  plan.deleteGroups.push(group.id);
  return plan;
}

/** R14 (`bkV2VanClearRoute`): no group of the route's day keeps its outbound van; groups and return vans stay. */
export function clearRouteVans(state: VanDayState): VanPlan {
  const plan = emptyPlan();
  for (const g of state.groups) if (g.van_id) putGroup(state, plan, { ...g, van_id: null });
  return plan;
}

// ── PATCH /operations/trip-ops/{trip_id} `van_parts` ──

type PartInput = Counts & { idx: number; source?: PartSource; group_id: string | null; sequence: number | null; return_van_id: string | null };
const count = (v: unknown, name: string): number => (v === undefined || v === null ? 0 : Number.isInteger(v) && (v as number) >= 0 ? v as number : bad(`${name} must be a whole number, 0 or more`));

/** `null` or `[]` is one whole, ungrouped part again (legacy unsplit). */
export function parseVanParts(value: unknown): PartInput[] {
  if (value === null) return [];
  if (!Array.isArray(value)) bad('van_parts must be a list');
  const parts = (value as unknown[]).map((raw, i): PartInput => {
    const p = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`van_parts[${i}] must be an object`);
    const at = `van_parts[${i}]`;
    const idx = p.idx ?? i;
    if (!Number.isInteger(idx) || (idx as number) < 0) bad(`${at}.idx must be a whole number, 0 or more`);
    const source = p.source === undefined ? undefined : (['main', 'manual', 'alt_pickup'] as const).find((s) => s === p.source) ?? bad(`${at}.source must be main, manual or alt_pickup`);
    const sequence = p.sequence === undefined || p.sequence === null ? null : Number.isInteger(p.sequence) && (p.sequence as number) > 0 ? p.sequence as number : bad(`${at}.sequence must be a whole number, 1 or more`);
    const id = (key: string) => (p[key] === undefined || p[key] === null || p[key] === '' ? null : typeof p[key] === 'string' ? p[key] as string : bad(`${at}.${key} must be an id`));
    return {
      idx: idx as number, source, ad: count(p.ad, `${at}.ad`), chd: count(p.chd, `${at}.chd`), inf: count(p.inf, `${at}.inf`), foc: count(p.foc, `${at}.foc`),
      group_id: id('group_id'), sequence, return_van_id: id('return_van_id'),
    };
  });
  if (new Set(parts.map((p) => p.idx)).size !== parts.length) bad('van_parts names an idx twice');
  if (parts.length && !parts.some((p) => p.idx === 0)) bad('van_parts needs the main part, idx 0');
  return parts.sort((a, b) => a.idx - b.idx);
}

/**
 * A trip's parts replaced. They must add up to the trip's passengers, each carrying one or more; a part
 * may join a group of the trip's zone on this route and day (R1, R9; seats R4); a return van comes from
 * the return pool (R3) and not with `return_same_van` (R11). Alternate-pickup parts come from the
 * booking's alternate pickups, so they stay as they are apart from their group, order and return van.
 */
export function setTripParts(state: VanDayState, tripId: string, input: PartInput[], returnSameVan: boolean,
  vans: readonly VanOnDay[]): { plan: VanPlan; warnings: string[] } {
  const plan = emptyPlan();
  const trip = state.trips.find((t) => t.trip_id === tripId)!;
  const alt = trip.parts.filter((p) => p.source === 'alt_pickup');
  const rows = input.length ? input : [{ idx: 0, ...trip.pax, group_id: null, sequence: null, return_van_id: null }];
  for (const a of alt) {
    const sent = rows.find((r) => r.idx === a.idx);
    if (!sent || PAX_CATEGORIES.some((c) => sent[c] !== a[c]) || (sent.source !== undefined && sent.source !== 'alt_pickup')) {
      refuse(`Part ${a.idx} is an alternate pickup: it follows the booking's alternate pickups, so keep it with its passengers`, 409, 'alt_pickup_split');
    }
  }
  for (const c of PAX_CATEGORIES) {
    const got = rows.reduce((s, r) => s + r[c], 0);
    if (got !== trip.pax[c]) bad(`van_parts put ${got} ${c} in vans, the trip has ${trip.pax[c]}`);
  }
  const warnings = new Set<string>();
  const parts = rows.map((r): StoredVanPart => {
    const kept = alt.find((a) => a.idx === r.idx);
    if (!kept && r.source === 'alt_pickup') bad(`van_parts: part ${r.idx} cannot be made an alternate pickup here; it comes from the booking's alternate pickups`);
    if (r.idx === 0 && r.source !== undefined && r.source !== 'main') bad('van_parts: part 0 is the main part');
    if (r.idx > 0 && r.source === 'main') bad(`van_parts: only part 0 is the main part`);
    if (partPax(r) === 0) bad(`van_parts: part ${r.idx} carries nobody`);
    if ((r.chd > 0 || r.inf > 0) && r.ad === 0) warnings.add('child_without_adult');
    if (r.return_van_id && returnSameVan) bad('Send return_same_van or a return_van_id, not both');
    return { idx: r.idx, source: kept ? 'alt_pickup' : r.idx === 0 ? 'main' : 'manual', ad: r.ad, chd: r.chd, inf: r.inf, foc: r.foc,
      group_id: r.group_id, sequence: r.sequence, return_van_id: r.return_van_id, alt: kept?.alt ?? null };
  });
  const touched = new Set<string>();
  for (const p of parts) {
    if (p.group_id) {
      const group = state.groups.find((g) => g.id === p.group_id) ?? bad(`van_parts: part ${p.idx}'s group ${p.group_id} is not a group of route ${state.route_id} on ${state.service_date}`);
      if (!trip.active) refuse(`Booking ${trip.booking_id} is cancelled and rides no van`, 409, 'cancelled');
      if (isSelfArrive(trip.zone)) refuse(`Trip ${tripId} comes to the pier on its own (${trip.zone}) and rides no van`, 409, 'self_arrive');
      if (group!.zone !== trip.zone) refuse(`Trip ${tripId} is picked up in zone ${trip.zone || '(none)'}, not group ${group!.number}'s ${group!.zone}`, 409, 'zone_mismatch');
      touched.add(group!.id);
    }
    if (p.return_van_id && !returnPool(vans, state.route_id, trip.zone).some((v) => v.van.id === p.return_van_id)) {
      refuse(`Van ${p.return_van_id} cannot bring zone ${trip.zone || '(none)'} back on ${state.service_date}`, 409, 'van_not_in_pool');
    }
  }
  putParts(state, plan, trip, parts);
  for (const id of touched) assertCapacity(state, groupOf(state, id), vans);
  if (parts.some((p) => p.return_van_id)) plan.dispatch.set(tripId, { return_same_van: false });
  return { plan, warnings: [...warnings] };
}

/**
 * The trips of an amended booking whose pickup zone changed while a part sat in a group: they leave it,
 * as a group holds one zone. Legacy drops them from the group's view without saying; here they are
 * ungrouped. Answers the trips and their parts to store.
 */
export function rezonedParts(before: Booking, after: Booking): Map<string, StoredVanPart[]> {
  const out = new Map<string, StoredVanPart[]>();
  for (const trip of after.trips) {
    const old = before.trips.find((t) => t.id === trip.id);
    if (!old || effectiveZone(before, old) === effectiveZone(after, trip)) continue;
    const parts = partsFromView(trip.operations.van_parts);
    if (parts.some((p) => p.group_id)) out.set(trip.id, partsToStore(parts.map((p) => ({ ...p, group_id: null, sequence: null }))));
  }
  return out;
}

// ── GET /operations/van-groups ──

export type VanGroupView = VanGroup & {
  /** Every seat taken: `customer_pax` plus `stop_seats` (guides riding along on the outbound leg). */
  pax: number; customer_pax: number; stop_seats: number; capacity: number | null; over_capacity: boolean;
  stops: VanStop[];
  members: (Counts & { trip_id: string; booking_id: string; idx: number; source: PartSource; sequence: number | null; pickup_time: string | null; return_van_id: string | null })[];
};
/** A group and its riding members in pickup order: the manual order, then pickup time (R12). */
export function groupView(state: VanDayState, group: VanGroup, vans: readonly Van[]): VanGroupView {
  const members = membersOf(state, group.id).sort((a, b) => (a.part.sequence ?? Infinity) - (b.part.sequence ?? Infinity)
    || cmp(a.trip.pickup_time ?? '~', b.trip.pickup_time ?? '~') || cmp(a.trip.trip_id, b.trip.trip_id) || a.part.idx - b.part.idx);
  const customers = members.reduce((s, m) => s + partPax(m.part), 0);
  const stops = stopsOf(state, group.id);
  const seats = stops.reduce((s, x) => s + outboundSeats(x), 0);
  const capacity = vans.find((v) => v.id === group.van_id)?.capacity ?? null;
  return {
    ...group, pax: customers + seats, customer_pax: customers, stop_seats: seats, capacity, over_capacity: capacity !== null && customers + seats > capacity, stops,
    members: members.map(({ trip, part }) => ({ trip_id: trip.trip_id, booking_id: trip.booking_id, idx: part.idx, source: part.source,
      ad: part.ad, chd: part.chd, inf: part.inf, foc: part.foc, sequence: part.sequence, pickup_time: trip.pickup_time, return_van_id: part.return_van_id })),
  };
}
/** The day's groups by number, leaving out one with nobody riding and no stop (decided 2026-10-09: it is kept, and hidden). */
export const visibleGroups = (state: VanDayState, vans: readonly Van[]): VanGroupView[] =>
  [...state.groups].sort((a, b) => a.number - b.number).map((g) => groupView(state, g, vans)).filter((g) => g.members.length > 0 || g.stops.length > 0);
