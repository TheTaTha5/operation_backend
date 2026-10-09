/**
 * Van job orders (todo/van-job-orders-model.md, decided 2026-10-09; migration 080): the sheet a van
 * driver gets for one van, one programme, one day, one per round. Legacy builds it in the browser
 * (`renderVanJobs`, `vanJobsOrderInner`, `vjRoundAll`, `vjRoundPick`, §vjOrder, §vsSeqTime, §altDrop,
 * §strandVj, §vjRound3); here the server does, from what the stores read for the day. Pure, so both
 * stores answer the same sheet.
 *
 * A job is an outbound van group with a van (key: the group's id), or a van that only brings people
 * back on a route (key `<van>~<route>`). "Sent to the driver" is kept per job, with a fingerprint of
 * the sheet as sent, so a change after sending keeps the tick and is flagged (new vs legacy).
 */
import { createHash } from 'node:crypto';
import { refuse } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { isIsoDate, type Route } from './calendar.js';
import type { Booking, BookingTrip } from './operations.js';
import type { PickupArea } from './pickup-areas.js';
import { effectiveZone, isSelfArrive, ownPickup, partPax, partsFromView, zoneRank, type StoredVanPart, type VanGroup } from './van-groups.js';
import type { VanStop } from './van-stops.js';
import type { StoredVanDay, Van } from './vans.js';

/** A "sent to the driver" mark: on a group (outbound job), or on a date, route and van (return-only job). */
export type VanJobSend = {
  group_id: string | null; service_date: string | null; route_id: string | null; van_id: string | null;
  sent_at: string; sent_by: string | null;
  /** `sheetFingerprint` when it was sent; null = imported from legacy, which kept none. */
  fingerprint: string | null;
};
/** A Thai name for a pickup place (legacy VANJOB_PICKUP_TH). */
export type PickupNameTh = { name_key: string; name: string; name_th: string; updated_at: string; updated_by: string | null };

/** What a store reads for one day. */
export type VanJobsInput = {
  date: string; bookings: readonly Booking[]; groups: readonly VanGroup[]; stops: readonly VanStop[];
  vans: readonly Van[]; vanDays: readonly StoredVanDay[]; routes: readonly Route[]; areas: readonly PickupArea[];
  names: readonly PickupNameTh[]; sends: readonly VanJobSend[];
};

export type SplitLabel = { kind: 'main' | 'pickup' | 'drop' | 'manual'; who: string | null };
export type BookingRow = {
  no: number | null; kind: 'booking'; booking_id: string; trip_id: string; parts: number[]; merged_parts: number;
  voucher: string; lead_pax: string | null; other_names: string[];
  ad: number; chd: number; inf: number; foc: number; pax: number; split: SplitLabel | null;
  pickup_time: string | null; pickup: string | null; pickup_th: string | null; room: string | null;
  zone: string | null; zone_th: string | null; drop_off: string | null; drop_own: boolean;
  /** Outbound: comes back on another van. Return: came out on another van. */
  return_van_id: string | null; from_van_id: string | null; extra: boolean;
  bags: number | null; special_request: string | null;
  /** A cancelled booking still in the group: printed struck through, numbered and counted nowhere (legacy §strandVj). */
  struck: 'cancelled' | null;
  /** `out`: stays on the island tonight; `leg`: comes back from it today. */
  ovn: 'out' | 'leg' | null; ovn_return_date: string | null;
};
export type StopRow = {
  no: number; kind: 'stop'; stop_id: string; stop_kind: VanStop['kind']; label: string; seats: number; leg: VanStop['leg'];
  time: string | null; place: string; phone: string | null; zone: string | null; zone_th: string | null; note: string | null;
};
export type SheetRow = BookingRow | StopRow;
export type SectionTotals = { ad: number; chd: number; inf: number; foc: number; pax: number; bookings: number; separate_drops: number; struck: number; stops: number; stop_seats: number };
export type Section = { rows: SheetRow[]; totals: SectionTotals };
export type Round = { no: number; of: number; time: string | null };
export type Driver = { name: string | null; phone: string | null; plate: string | null; override: boolean; plate_override: boolean };
export type VanJob = {
  key: string; service_date: string; route_id: string; route_name: string; group_id: string | null; group_number: number | null;
  van_id: string; van: Pick<Van, 'name' | 'plate' | 'color' | 'capacity' | 'ownership' | 'partner_name' | 'zone_base'>;
  round: Round | null; has_out: boolean; has_ret: boolean; zones: string[];
  out_pax: number; ret_pax: number; stop_seats: number; pax: number; capacity: number; over_capacity: boolean;
  bookings: number; struck: number; driver: Driver; pickups: { name: string; name_th: string | null }[];
  sent: { at: string; by: string | null; changed_since_sent: boolean | null } | null;
};
export type VanJobSheet = {
  job: VanJob; out: Section | null; ret: Section | null;
  /** A later round: its van's return leg prints on round 1's sheet only (legacy §vjRound3). */
  ret_on_round_1: boolean;
  /** Bookings on this route with no van yet, not on this sheet: they may be missing from it (legacy's late-booking guard). */
  unassigned_on_route: { bookings: number; pax: number };
};
export type VanJobsDay = {
  date: string; jobs: VanJob[];
  /** Passengers with no outbound van yet, by route (legacy's red banner). */
  unassigned: { pax: number; by_route: { route_id: string; pax: number }[] };
  /** A separate drop-off with no return van (legacy `bkV2RetInfo(...).alert`, the amber banner). */
  return_unarranged: { booking_id: string; trip_id: string; route_id: string; lead_pax: string | null; drop: string; pax: number }[];
  /** Ticked "comes on their own" but still on a van or a transfer zone (legacy `selfWarn`). */
  self_arrive: { booking_id: string; trip_id: string; voucher: string; lead_pax: string | null; hotel: string | null; has_van: boolean }[];
  /** Struck-through rows across the day's sheets. */
  struck: number;
};

const bad = (message: string): never => refuse(message, 400);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Numbers where `Infinity` (no place) may meet `Infinity`. */
const rankDiff = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);
const RELEASED = new Set<string>(SEAT_RELEASING_STATUSES);

// ── Small rules ──

/** Legacy `vanJobsSreqFinal`: the override when there is one (`""` = blanked), else the notes. */
export function specialRequest(b: { job_note?: string; notes?: string }): string | null {
  if (b.job_note !== undefined && b.job_note !== null) return b.job_note.trim() || null;
  return b.notes?.trim() || null;
}
/** The key a Thai name is kept under: the place as typed, trimmed and lower-cased (decided 2026-10-09). */
export const pickupNameKey = (name: string): string => name.trim().toLowerCase();
/** `PUT /operations/pickup-names-th`: a name, and its Thai name; an empty Thai name deletes it, as legacy's box does. */
export function parsePickupNameTh(body: Record<string, unknown>): { name: string; name_key: string; name_th: string | null } {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : bad('name is required: the pickup place as the sheet prints it');
  const th = body.name_th;
  if (th !== undefined && th !== null && typeof th !== 'string') bad('name_th must be text, or empty to delete');
  return { name: name!, name_key: pickupNameKey(name!), name_th: typeof th === 'string' && th.trim() ? th.trim() : null };
}

/** Legacy `VANJOB_AREA_TH`: the Thai name printed under a pickup area's name. */
export const AREA_TH: Readonly<Record<string, string>> = {
  'Airport': 'สนามบิน', 'Aopor': 'อ่าวปอ', 'Aoyon': 'อ่าวยน', 'Bang Niang': 'บางเนียง', 'Bangtao': 'บางเทา',
  'Chalong': 'ฉลอง', 'Chaofa': 'เจ้าฟ้า', 'Cherngtalay': 'เชิงทะเล', 'Kalim': 'กะหลิม', 'Kamala': 'กมลา',
  'Karon': 'กะรน', 'Kata': 'กะตะ', 'Kathu': 'กะทู้', 'Khok Kloi': 'โคกกลอย', 'Ko Kaeo': 'เกาะแก้ว', 'Laguna': 'ลากูน่า',
  'Layan': 'ลายัน', 'Maikhao': 'ไม้ขาว', 'Monument': 'อนุสาวรีย์', 'Naithon': 'ในทอน', 'Naiyang': 'ในยาง',
  'Naiharn': 'ในหาน', 'Nang Thong / La Flora': 'นางทอง', 'Natai': 'นาใต้', 'Pa Khlok': 'ป่าคลอก', 'Panwa': 'พันวา',
  'Patong': 'ป่าตอง', 'Phuket Town': 'เมืองภูเก็ต', 'Rawai': 'ราไวย์', 'Saiyuan': 'ไสยวน', 'Sapam': 'สะปำ',
  'Siray': 'สิเหร่', 'Surin (beach)': 'สุรินทร์', 'Talang': 'ถลาง', 'Thalang': 'ถลาง', 'Tritrang': 'ตรีตรัง',
  'Nang Thong': 'นางทอง', 'Poseidon': 'โพไซดอน',
  'Khaolak': 'เขาหลัก', 'Khuk Khak': 'คึกคัก', 'Bang Sak': 'บางสัก', 'Num Khem': 'น้ำเค็ม', 'Merlin': 'เมอร์ลิน',
  'Tub Lamu Pier (self-arrive)': 'ท่าเรือทับละมุ', 'Visit Panwa Pier (self-arrive)': 'ท่าเรือวิสิทพันวา', 'Yamu': 'ยามู',
};
/** Where a return run picks people up: the programme's pier (legacy `_pierNm`). */
export const pierName = (route: Pick<Route, 'pier'> | undefined): string =>
  route?.pier === 'panwa' ? 'Visit Panwa Pier' : route?.pier === 'tublamu' ? 'Tub Lamu Pier' : route?.pier || 'ท่าเรือ / Pier';
/** Legacy `bkIsOvnOutbound`: goes out today and comes back another day. */
const ovnOutbound = (t: BookingTrip): boolean => t.ovn === 'return' && !!t.ovn_return_date;
const SELF_RETURN = /self-?arrive|กลับเอง|self[\s-]?return/i;

/** `GET /operations/van-jobs?date=`, `…/{date}/{key}`: the date must be a date. */
export function parseJobDate(value: unknown): string {
  return typeof value === 'string' && isIsoDate(value) ? value : bad('date must be YYYY-MM-DD');
}

// ── The day ──

type Ctx = {
  date: string; groups: Map<string, VanGroup>; vans: Map<string, Van>; routes: Map<string, Route>; areas: Map<string, PickupArea>;
  names: Map<string, string>; days: Map<string, StoredVanDay>;
};
/** One part of a trip, as a sheet sees it. */
type Src = { booking: Booking; trip: BookingTrip; part: StoredVanPart; group: VanGroup | null; zone: string; struck: boolean; split: boolean };

const areaName = (ctx: Ctx, id: string | null | undefined): string | null => (id ? ctx.areas.get(id)?.name ?? null : null);
/** Legacy `bkV2RetInfo`: a separate drop-off, and whether it is the customer going back on their own. */
function dropInfo(ctx: Ctx, b: Booking): { sep: boolean; drop: string; selfReturn: boolean } {
  const sep = b.dropoff_same === false && !!(b.dropoff_hotel_name || b.dropoff_area || b.dropoff_area_id);
  if (!sep) return { sep, drop: '', selfReturn: false };
  const area = b.dropoff_area_id ? ctx.areas.get(b.dropoff_area_id) : undefined;
  const name = area?.name || b.dropoff_hotel_name || b.dropoff_area_id || b.dropoff_area || '';
  return { sep, drop: b.dropoff_hotel_name || b.dropoff_area || '', selfReturn: area?.zone === 'NoTransfer' || SELF_RETURN.test(name) };
}
/** The explicit return van of a part: its own, else its group's default (legacy `vanReturnId`). */
const explicitReturn = (s: Pick<Src, 'part' | 'group'>): string | null => s.part.return_van_id ?? s.group?.return_van_id ?? null;
/** The van a part comes back on: the explicit one, else its group's van (legacy `vanReturnId || vanId`). */
const returnVan = (s: Pick<Src, 'part' | 'group'>): string | null => explicitReturn(s) ?? s.group?.van_id ?? null;
/** The trip's pickup time, as its van group orders rounds (legacy `pickupTimeFinal || pickupTime`). */
const tripTime = (t: BookingTrip): string | null => t.operations.pickup_time_final ?? t.pickup_time ?? null;

/** A row with what orders it: the manual sequence, the time (`~` = none, last), and a stable tie-break. */
type Sortable = SheetRow & { seq: number; sort_time: string; tie: string };
type SortableBooking = BookingRow & { seq: number; sort_time: string; tie: string };
const tieOf = (bookingId: string, tripId: string, idx: number): string => `${bookingId}|${tripId}|${String(idx).padStart(4, '0')}`;

function bookingRow(ctx: Ctx, s: Src, vanId: string, ret: boolean): SortableBooking {
  const { booking: b, trip: t, part } = s;
  const route = ctx.routes.get(t.route_id);
  const own = ownPickup(part);
  const baseArea = areaName(ctx, b.pickup_area_id) ?? b.pickup_area ?? null;
  const hotel = own ? part.alt!.pick_hotel || areaName(ctx, part.alt!.pick_area_id) || b.hotel_name || null : b.hotel_name || b.pickup_area || null;
  const pickup = ret || t.ovn_leg ? pierName(route) : hotel;
  // The zone cell: an own pickup's area, else (coming back to a separate drop-off) the drop-off's, else the pickup's.
  const dropArea = b.dropoff_same === false && b.dropoff_area_id ? areaName(ctx, b.dropoff_area_id) ?? b.dropoff_area ?? null : baseArea;
  const zone = own ? areaName(ctx, part.alt!.pick_area_id) ?? baseArea : ret ? dropArea : baseArea;
  const ownDrop = !!part.alt && !!(part.alt.drop_hotel || part.alt.drop_area_id);
  const sepDrop = ownDrop ? part.alt!.drop_hotel || areaName(ctx, part.alt!.drop_area_id) || ''
    : b.dropoff_same === false ? b.dropoff_hotel_name || b.dropoff_area || areaName(ctx, b.dropoff_area_id) || '' : '';
  const time = own ? part.alt!.pick_time ?? null : tripTime(t);
  const back = explicitReturn(s), out = s.group?.van_id ?? null;
  const returnVanId = !ret && back && back !== vanId ? back : null;
  const fromVanId = ret && out && out !== vanId ? out : null;
  const lead = b.lead_pax?.trim() || null;
  const split: SplitLabel | null = !s.split ? null : {
    kind: part.source === 'main' ? 'main' : own ? 'pickup' : part.source === 'alt_pickup' ? 'drop' : 'manual', who: part.alt?.alt_who ?? null,
  };
  return {
    no: null, kind: 'booking', booking_id: b.id, trip_id: t.id, parts: [part.idx], merged_parts: 1, voucher: b.voucher_ref || b.id, lead_pax: lead,
    other_names: (b.passengers ?? []).map((p) => p.name.trim()).filter((n) => n && n !== lead),
    ad: part.ad, chd: part.chd, inf: part.inf, foc: part.foc, pax: partPax(part), split,
    pickup_time: ret ? null : time, pickup, pickup_th: pickup ? ctx.names.get(pickupNameKey(pickup)) ?? null : null, room: b.room_number || null,
    zone, zone_th: zone ? AREA_TH[zone] ?? null : null, drop_off: (ret ? sepDrop || hotel : sepDrop) || null, drop_own: ownDrop,
    return_van_id: returnVanId, from_van_id: fromVanId, extra: !!(returnVanId || fromVanId),
    bags: b.large_luggage || null, special_request: specialRequest(b), struck: s.struck ? 'cancelled' : null,
    ovn: t.ovn_leg ? 'leg' : ovnOutbound(t) ? 'out' : null, ovn_return_date: ovnOutbound(t) ? t.ovn_return_date ?? null : null,
    // For ordering only (legacy `_rowTime`: the return leg orders by the trip's time too).
    seq: part.sequence ?? 0, sort_time: (ret ? tripTime(t) : time) ?? '~', tie: tieOf(b.id, t.id, part.idx),
  };
}
function stopRow(ctx: Ctx, x: VanStop): Sortable {
  const zone = areaName(ctx, x.area_id) ?? x.area ?? null;
  return {
    no: 0, kind: 'stop', stop_id: x.id, stop_kind: x.kind, label: x.label, seats: x.kind === 'staff' ? x.pax : 0, leg: x.leg, time: x.time,
    place: x.place, phone: x.phone, zone, zone_th: zone ? AREA_TH[zone] ?? null : null, note: x.note,
    seq: x.sequence ?? 0, sort_time: x.time ?? '~', tie: `~${x.created_at}|${x.id}`,
  };
}

/**
 * Legacy §altDrop: on the outbound leg, a booking's parts picked up at the same place are one row,
 * their passengers added up. The return leg keeps them apart: that is where they part.
 */
function mergeSamePickup(rows: SortableBooking[], srcs: Src[]): SortableBooking[] {
  const out: SortableBooking[] = [];
  const at = new Map<string, number>();
  rows.forEach((row, i) => {
    const s = srcs[i];
    const key = `${row.booking_id}|${row.trip_id}|${ownPickup(s.part) ? `${s.part.alt!.pick_area_id ?? ''}~${(s.part.alt!.pick_hotel ?? '').trim()}` : 'MAIN'}|${row.struck ?? ''}`;
    const first = at.get(key);
    if (first === undefined) { at.set(key, out.length); out.push(row); return; }
    const into = out[first];
    for (const c of ['ad', 'chd', 'inf', 'foc', 'pax'] as const) into[c] += row[c];
    into.parts = [...into.parts, ...row.parts];
    into.merged_parts += 1;
  });
  return out;
}

/**
 * Legacy §vsSeqTime: rows with a manual order keep it; a row without one goes in before the first
 * ordered row whose time is later; with no manual order at all, by time; untimed last. On the return
 * leg, rows that came out on another van go last.
 */
function orderRows(rows: Sortable[], ret: boolean): Sortable[] {
  const byTie = [...rows].sort((a, b) => cmp(a.tie, b.tie));
  const ordered = byTie.filter((r) => r.seq > 0).sort((a, b) => a.seq - b.seq);
  const rank = (r: Sortable): number => {
    if (r.seq > 0) return ordered.indexOf(r);
    let i = 0;
    while (i < ordered.length && ordered[i].sort_time <= r.sort_time) i++;
    return i - 0.5;
  };
  const other = (r: Sortable) => (r.kind === 'booking' && r.from_van_id ? 1 : 0);
  return byTie.sort((a, b) => (ret ? other(a) - other(b) : 0) || (ordered.length ? rank(a) - rank(b) : 0) || cmp(a.sort_time, b.sort_time) || cmp(a.tie, b.tie));
}

function section(rows: Sortable[], ret: boolean): Section {
  let no = 0;
  const totals: SectionTotals = { ad: 0, chd: 0, inf: 0, foc: 0, pax: 0, bookings: 0, separate_drops: 0, struck: 0, stops: 0, stop_seats: 0 };
  const ids = new Set<string>();
  const out = orderRows(rows, ret).map(({ seq: _s, sort_time: _t, tie: _x, ...row }) => {
    const r = row as SheetRow;
    if (r.kind === 'stop') { totals.stops += 1; totals.stop_seats += r.seats; return { ...r, no: ++no }; }
    if (r.struck) { totals.struck += 1; return { ...r, no: null }; }
    for (const c of ['ad', 'chd', 'inf', 'foc', 'pax'] as const) totals[c] += r[c];
    ids.add(r.booking_id);
    if (r.drop_own) totals.separate_drops += 1;
    return { ...r, no: ++no };
  });
  totals.bookings = ids.size;
  return { rows: out, totals };
}

/** What the driver acts on, as one string (see the design note): a change to any of it flags a sent job. */
export function sheetFingerprint(job: Pick<VanJob, 'van_id' | 'route_id' | 'group_id' | 'driver'>, out: Section | null, ret: Section | null): string {
  const rows = (s: Section | null) => (s?.rows ?? []).map((r) => (r.kind === 'stop'
    ? ['stop', r.stop_id, r.label, r.seats, r.leg, r.time, r.place, r.phone, r.note]
    : ['booking', r.booking_id, r.trip_id, r.parts, r.ad, r.chd, r.inf, r.foc, r.pickup_time, r.pickup, r.room, r.zone, r.drop_off, r.return_van_id, r.from_van_id,
      r.bags, r.special_request, r.struck, r.ovn]));
  const body = JSON.stringify([job.van_id, job.route_id, job.group_id, job.driver.name, job.driver.phone, job.driver.plate, rows(out), rows(ret)]);
  return createHash('sha256').update(body).digest('hex');
}

type Built = VanJob & { sheet: VanJobSheet; fingerprint: string; routeDeparture: string; groupRank: [number, number]; zoneRankOf: number };

/** The day's jobs and sheets, every rule in one place. */
export function vanJobsDay(input: VanJobsInput): { day: VanJobsDay; sheets: Map<string, VanJobSheet & { fingerprint: string }> } {
  const ctx: Ctx = {
    date: input.date, groups: new Map(input.groups.map((g) => [g.id, g])), vans: new Map(input.vans.map((v) => [v.id, v])),
    routes: new Map(input.routes.map((r) => [r.id, r])), areas: new Map(input.areas.map((a) => [a.id, a])),
    names: new Map(input.names.map((n) => [n.name_key, n.name_th])), days: new Map(input.vanDays.filter((d) => d.service_date === input.date).map((d) => [d.van_id, d])),
  };
  const outSrc = new Map<string, Src[]>(); // group id → its parts
  const retSrc = new Map<string, Src[]>(); // `${van}~${route}` → the parts it brings back
  const push = <K>(map: Map<K, Src[]>, key: K, s: Src) => map.set(key, [...(map.get(key) ?? []), s]);
  const unassigned = new Map<string, number>();
  const unassignedParts: Src[] = [];
  const returnUnarranged: VanJobsDay['return_unarranged'] = [];
  const selfArrive: VanJobsDay['self_arrive'] = [];

  const bookings = [...input.bookings].sort((a, b) => cmp(a.id, b.id));
  for (const b of bookings) {
    const active = !RELEASED.has(b.status);
    const drop = dropInfo(ctx, b);
    for (const t of b.trips) {
      if (t.service_date !== input.date) continue;
      const zone = t.ovn_leg ? 'NoTransfer' : effectiveZone(b, t);
      const parts = partsFromView(t.operations.van_parts);
      const srcs = parts.map((part): Src => {
        const group = part.group_id ? ctx.groups.get(part.group_id) ?? null : null;
        return { booking: b, trip: t, part, group, zone, struck: !active, split: parts.length > 1 };
      });
      for (const s of srcs) {
        const van = s.group?.van_id ?? null;
        if (!b.pickup_self && !t.ovn_leg && van) push(outSrc, s.group!.id, s);
        if (active && !b.pickup_self && !van && zone && !isSelfArrive(zone)) {
          unassigned.set(t.route_id, (unassigned.get(t.route_id) ?? 0) + partPax(s.part));
          unassignedParts.push(s);
        }
        const back = returnVan(s);
        if (back && !ovnOutbound(t) && !drop.selfReturn) push(retSrc, `${back}~${t.route_id}`, s);
      }
      if (!active) continue;
      if (b.pickup_self) {
        const hasVan = srcs.some((s) => s.group?.van_id);
        if (hasVan || (zone && !isSelfArrive(zone))) {
          selfArrive.push({ booking_id: b.id, trip_id: t.id, voucher: b.voucher_ref || b.id, lead_pax: b.lead_pax ?? null, hotel: b.hotel_name || b.pickup_area || null, has_van: hasVan });
        }
      }
      // Legacy `bkV2RetInfo(...).alert`: a separate drop-off, every part without a return van, not their own way back, not confirmed on the same van.
      const arranged = srcs.every((s) => explicitReturn(s));
      if (!t.ovn_leg && drop.sep && !arranged && !drop.selfReturn && !t.operations.return_same_van) {
        returnUnarranged.push({ booking_id: b.id, trip_id: t.id, route_id: t.route_id, lead_pax: b.lead_pax ?? null, drop: drop.drop || '?', pax: srcs.reduce((n, s) => n + partPax(s.part), 0) });
      }
    }
  }

  // Outbound jobs: a group with a van and something to carry. Its van's rounds on the route.
  const stopsOf = new Map<string, VanStop[]>();
  for (const x of input.stops) if (x.service_date === input.date && x.group_id) stopsOf.set(x.group_id, [...(stopsOf.get(x.group_id) ?? []), x]);
  const outbound = input.groups.filter((g) => g.service_date === input.date && g.van_id && ((outSrc.get(g.id)?.length ?? 0) > 0 || (stopsOf.get(g.id)?.length ?? 0) > 0));
  const runs = new Map<string, VanGroup[]>(); // `${van}~${route}` → its outbound groups
  for (const g of outbound) runs.set(`${g.van_id}~${g.route_id}`, [...(runs.get(`${g.van_id}~${g.route_id}`) ?? []), g]);
  const earliest = (g: VanGroup): string | null => (outSrc.get(g.id) ?? []).map((s) => tripTime(s.trip)).filter((t): t is string => !!t).sort(cmp)[0] ?? null;
  const roundOf = new Map<string, Round | null>();
  for (const groups of runs.values()) {
    // Legacy `vjRoundPick`: by earliest pickup, then group number; one group is no round at all.
    const sorted = [...groups].sort((a, b) => cmp(earliest(a) ?? '~~', earliest(b) ?? '~~') || a.number - b.number);
    sorted.forEach((g, i) => roundOf.set(g.id, sorted.length < 2 ? null : { no: i + 1, of: sorted.length, time: earliest(g) }));
  }

  const job = (key: string, vanId: string, routeId: string, group: VanGroup | null, outRows: Src[], outStops: VanStop[], retRows: Src[] | null, retStops: VanStop[], retElsewhere: boolean): Built => {
    const van = ctx.vans.get(vanId);
    const route = ctx.routes.get(routeId);
    const tie = (s: Src) => tieOf(s.booking.id, s.trip.id, s.part.idx);
    const sortedOut = [...outRows].sort((a, b) => cmp(tie(a), tie(b)));
    const outBooking = mergeSamePickup(sortedOut.map((s) => bookingRow(ctx, s, vanId, false)), sortedOut);
    const stopsFor = (xs: VanStop[]) => xs.map((x) => stopRow(ctx, x));
    const out = outBooking.length || outStops.length ? section([...outBooking, ...stopsFor(outStops)], false) : null;
    const retBooking = (retRows ?? []).map((s) => bookingRow(ctx, s, vanId, true));
    const ret = retRows && (retBooking.length || retStops.length) ? section([...retBooking, ...stopsFor(retStops)], true) : null;
    const day = ctx.days.get(vanId);
    const driver: Driver = {
      name: day?.driver || van?.driver || null, phone: day?.driver_phone || van?.driver_phone || null, plate: day?.plate || van?.plate || null,
      override: !!(day?.driver || day?.driver_phone || day?.plate), plate_override: !!day?.plate,
    };
    const rowsOf = (s: Section | null) => (s?.rows ?? []);
    const bookingRows = [...rowsOf(out), ...rowsOf(ret)].filter((r): r is BookingRow => r.kind === 'booking');
    const live = bookingRows.filter((r) => !r.struck);
    const zones = [...new Set([...outRows, ...(retRows ?? [])].map((s) => s.zone).filter(Boolean))].sort((a, b) => zoneRank(a) - zoneRank(b) || cmp(a, b));
    const pickups = [...new Set(live.map((r) => r.pickup).filter((p): p is string => !!p))].map((name) => ({ name, name_th: ctx.names.get(pickupNameKey(name)) ?? null }));
    const capacity = van?.capacity ?? 0;
    const outPax = out?.totals.pax ?? 0, retPax = ret?.totals.pax ?? 0, stopSeats = rowsOf(out).reduce((n, r) => n + (r.kind === 'stop' && r.leg !== 'ret' ? r.seats : 0), 0);
    // Legacy shows the outbound load when there is one, else the return's; a guide riding out takes a seat too (as van groups count it).
    const pax = out ? outPax + stopSeats : retPax;
    const core = { van_id: vanId, route_id: routeId, group_id: group?.id ?? null, driver };
    const fingerprint = sheetFingerprint(core, out, ret);
    const send = group ? input.sends.find((x) => x.group_id === group.id)
      : input.sends.find((x) => x.group_id === null && x.service_date === input.date && x.route_id === routeId && x.van_id === vanId);
    const built: VanJob = {
      key, service_date: input.date, route_id: routeId, route_name: route?.name ?? routeId, group_id: group?.id ?? null, group_number: group?.number ?? null,
      van_id: vanId, van: { name: van?.name ?? vanId, plate: van?.plate ?? null, color: van?.color ?? null, capacity, ownership: van?.ownership ?? 'own', partner_name: van?.partner_name ?? null, zone_base: van?.zone_base ?? null },
      round: group ? roundOf.get(group.id) ?? null : null, has_out: !!out, has_ret: !!ret, zones,
      out_pax: outPax, ret_pax: retPax, stop_seats: stopSeats, pax, capacity, over_capacity: pax > capacity,
      bookings: new Set(live.map((r) => r.booking_id)).size, struck: bookingRows.length - live.length, driver, pickups,
      sent: send ? { at: send.sent_at, by: send.sent_by, changed_since_sent: send.fingerprint === null ? null : send.fingerprint !== fingerprint } : null,
    };
    const onSheet = new Set(bookingRows.map((r) => r.booking_id));
    const missing = unassignedParts.filter((s) => s.trip.route_id === routeId && !s.trip.ovn_leg && !onSheet.has(s.booking.id));
    return {
      ...built, fingerprint, routeDeparture: route?.times?.[0]?.trim() || '99:99',
      groupRank: group ? [group.display_order ?? Infinity, group.number] : [Infinity, Infinity], zoneRankOf: zones.length ? zoneRank(zones[0]) : 9,
      sheet: {
        job: built, out, ret, ret_on_round_1: retElsewhere,
        unassigned_on_route: { bookings: new Set(missing.map((s) => s.booking.id)).size, pax: missing.reduce((n, s) => n + partPax(s.part), 0) },
      },
    };
  };

  const built: Built[] = [];
  const hosted = new Set<string>();
  for (const [run, groups] of runs) {
    const [vanId, routeId] = [groups[0].van_id!, groups[0].route_id];
    const first = [...groups].sort((a, b) => (roundOf.get(a.id)?.no ?? 1) - (roundOf.get(b.id)?.no ?? 1))[0];
    const backRows = retSrc.get(run) ?? [];
    const backStops = groups.flatMap((g) => (stopsOf.get(g.id) ?? []).filter((x) => x.leg !== 'out'));
    hosted.add(run);
    for (const g of groups) {
      const hosts = g.id === first.id;
      built.push(job(g.id, vanId, routeId, g, outSrc.get(g.id) ?? [], (stopsOf.get(g.id) ?? []).filter((x) => x.leg !== 'ret'),
        hosts ? backRows : null, hosts ? backStops : [], !hosts && (backRows.length > 0 || backStops.length > 0)));
    }
  }
  // A van that only brings people back on a route: a job of its own.
  for (const [run, rows] of retSrc) {
    if (hosted.has(run) || !rows.length) continue;
    const sep = run.indexOf('~');
    const [vanId, routeId] = [run.slice(0, sep), run.slice(sep + 1)];
    if (!ctx.vans.has(vanId)) continue;
    built.push(job(run, vanId, routeId, null, [], [], rows, [], false));
  }

  // Legacy §vjOrder: the programme's first departure, its name, the zone, the group's place (the order staff dragged), the van's name.
  const vanName = (j: Built) => j.van.name;
  built.sort((a, b) => cmp(a.routeDeparture, b.routeDeparture) || a.route_name.localeCompare(b.route_name) || a.zoneRankOf - b.zoneRankOf
    || rankDiff(a.groupRank[0], b.groupRank[0]) || rankDiff(a.groupRank[1], b.groupRank[1])
    || vanName(a).localeCompare(vanName(b), 'th', { numeric: true }) || cmp(a.van_id, b.van_id) || cmp(a.key, b.key));

  const sheets = new Map(built.map((j) => [j.key, { ...j.sheet, fingerprint: j.fingerprint }]));
  const strip = ({ sheet: _s, fingerprint: _f, routeDeparture: _d, groupRank: _g, zoneRankOf: _z, ...rest }: Built): VanJob => rest;
  return {
    sheets,
    day: {
      date: input.date, jobs: built.map(strip),
      unassigned: { pax: [...unassigned.values()].reduce((a, b) => a + b, 0), by_route: [...unassigned].map(([route_id, pax]) => ({ route_id, pax })).sort((a, b) => b.pax - a.pax || cmp(a.route_id, b.route_id)) },
      return_unarranged: returnUnarranged, self_arrive: selfArrive, struck: built.reduce((n, j) => n + j.struck, 0),
    },
  };
}

/** The send to store for a job: on its group, or on its date, route and van. */
export function sendFor(job: VanJob, fingerprint: string, at: string, by: string | null): VanJobSend {
  return job.group_id
    ? { group_id: job.group_id, service_date: null, route_id: null, van_id: null, sent_at: at, sent_by: by, fingerprint }
    : { group_id: null, service_date: job.service_date, route_id: job.route_id, van_id: job.van_id, sent_at: at, sent_by: by, fingerprint };
}
