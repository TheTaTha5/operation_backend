/**
 * Alternate pickups (slice D of todo/trip-ops-and-vans-model.md, migration 037): some of a booking's
 * passengers are picked up, or dropped off, somewhere else. The sales form keeps them as a list on the
 * booking; the server turns them into van parts (Decision 4), a port of legacy
 * `bkV2SyncAltPickupSplits`, so every client sees the same parts. Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import type { Booking } from './operations.js';
import { PAX_CATEGORIES, parsePaxGrid } from './pax.js';
import { countsOf, partsFromView, partsToStore, type Counts, type StoredVanPart } from './van-groups.js';

export type AltPickup = {
  who: string | null; ad: number; chd: number; inf: number; foc: number;
  area_id: string | null; area: string | null; zone: string | null; place: string | null;
  drop_same: boolean | null; drop_area_id: string | null; drop_area: string | null; drop_zone: string | null; drop_place: string | null;
};

const bad = (message: string): never => refuse(message, 400);

/**
 * `alt_pickups` (or legacy's `altPickups`), as the list replaces outright. Legacy's spellings are read
 * too, and its old `qty`-only entries count as adults, as `bkAltPax` reads them.
 */
export function parseAltPickups(value: unknown, label = 'alt_pickups'): AltPickup[] {
  if (value === null) return [];
  if (!Array.isArray(value)) bad(`${label} must be a list`);
  return (value as unknown[]).map((raw, i) => {
    const at = `${label}[${i}]`;
    const a = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : bad(`${at} must be an object`);
    const pick = (...keys: string[]) => keys.map((k) => a![k]).find((v) => v !== undefined);
    const text = (name: string, ...keys: string[]): string | null => {
      const v = pick(...keys);
      if (v === undefined || v === null) return null;
      return typeof v === 'string' ? v.trim() || null : bad(`${at}.${name} must be text`);
    };
    const count = (k: string): number | undefined => {
      const v = a![k];
      if (v === undefined || v === null || v === '') return undefined;
      return Number.isInteger(v) && (v as number) >= 0 ? v as number : bad(`${at}.${k} must be a whole number, 0 or more`);
    };
    const counts = Object.fromEntries(PAX_CATEGORIES.map((c) => [c, count(c)])) as Record<string, number | undefined>;
    const hasCounts = PAX_CATEGORIES.some((c) => counts[c] !== undefined);
    const qty = a!.qty === undefined || a!.qty === null ? 0 : Number.isInteger(a!.qty) && (a!.qty as number) >= 0 ? a!.qty as number : bad(`${at}.qty must be a whole number, 0 or more`);
    const dropSame = pick('drop_same', 'dropSame');
    if (dropSame !== undefined && dropSame !== null && typeof dropSame !== 'boolean') bad(`${at}.drop_same must be true or false`);
    return {
      who: text('who', 'who'),
      ad: hasCounts ? counts.ad ?? 0 : qty, chd: counts.chd ?? 0, inf: counts.inf ?? 0, foc: counts.foc ?? 0,
      area_id: text('area_id', 'area_id', 'areaId'), area: text('area', 'area'), zone: text('zone', 'zone'), place: text('place', 'place'),
      drop_same: (dropSame as boolean | undefined) ?? null, drop_area_id: text('drop_area_id', 'drop_area_id', 'dropAreaId'),
      drop_area: text('drop_area', 'drop_area', 'dropArea'), drop_zone: text('drop_zone', 'drop_zone', 'dropZone'), drop_place: text('drop_place', 'drop_place', 'dropPlace'),
    };
  });
}

/** Parts compared whatever order their keys were built in. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const paxOf = (a: AltPickup): Counts => ({ ad: a.ad, chd: a.chd, inf: a.inf, foc: a.foc });
const total = (c: Counts): number => c.ad + c.chd + c.inf + c.foc;
/** Legacy `bkAltHasDrop`: dropped off somewhere else. */
const hasDrop = (a: AltPickup): boolean => a.drop_same === false && !!(a.drop_place || a.drop_area_id);
/** Legacy `bkSplitOwnPick`: picked up somewhere of its own. */
const ownPick = (a: Pick<AltPickup, 'place' | 'area_id'>): boolean => !!(a.place || a.area_id);
/** Legacy `_bkV2IsAltAutoSplit`: parts built from alternate pickups, not split by hand. */
const isAuto = (parts: readonly StoredVanPart[]): boolean => parts.some((p) => p.source === 'alt_pickup');

/**
 * The trip's parts for these alternate pickups, or `undefined` to leave them as they are. Legacy's rules:
 * - a split made by hand is left alone;
 * - an entry counts if it has passengers and a place, area, name or drop-off;
 * - with none, when they ask for more passengers than the trip has, or when the trip has one passenger,
 *   an automatic split folds back into one part that keeps the main part's group, order and return van;
 * - otherwise the main part keeps the rest, category by category, and each entry is a part of its own.
 *   When the entries take everyone, there is no main part (decided 2026-10-09; legacy split nothing).
 *   Parts keep their van assignment by position. A drop-off-only entry rides with the main part; one
 *   with its own pickup starts ungrouped. A part's pickup time stays while its pickup point does.
 */
export function altPickupParts(alts: readonly AltPickup[], tripPax: Counts, current: readonly StoredVanPart[]): StoredVanPart[] | undefined {
  if (current.length > 1 && !isAuto(current)) return undefined;
  if (current.length === 1 && current[0].source !== 'main') return undefined;
  const usable = alts.filter((a) => total(paxOf(a)) > 0 && (a.place || a.area_id || a.who || hasDrop(a)));
  const headcount = total(tripPax), altTotal = usable.reduce((s, a) => s + total(paxOf(a)), 0);
  const main = current.find((p) => p.source === 'main');
  // Entries that ask for more of a category than the trip has can't be split consistently.
  const overflow = PAX_CATEGORIES.some((c) => usable.reduce((s, a) => s + a[c], 0) > tripPax[c]);
  if (usable.length === 0 || overflow || altTotal > headcount || headcount < 2) {
    if (!isAuto(current)) return undefined;
    return partsToStore([{ idx: 0, source: 'main', ...tripPax, group_id: main?.group_id ?? null, sequence: main?.sequence ?? null, return_van_id: main?.return_van_id ?? null, alt: null }]);
  }
  const mainPax = Object.fromEntries(PAX_CATEGORIES.map((c) => [c, tripPax[c] - usable.reduce((s, a) => s + a[c], 0)])) as Counts;
  const assign = (p: StoredVanPart | undefined) => ({ group_id: p?.group_id ?? null, sequence: p?.sequence ?? null, return_van_id: p?.return_van_id ?? null });
  // Decided 2026-10-09: when the entries take every passenger, the main part, left with nobody, goes (legacy split nothing).
  const parts: StoredVanPart[] = total(mainPax) > 0 ? [{ idx: 0, source: 'main', ...mainPax, ...assign(main), alt: null }] : [];
  usable.forEach((a, i) => {
    const was = current.find((p) => p.idx === i + 1);
    const keepTime = ownPick(a) && was?.alt?.pick_time && (was.alt.pick_area_id ?? null) === a.area_id && (was.alt.pick_hotel ?? null) === a.place;
    parts.push({
      idx: i + 1, source: 'alt_pickup', ...paxOf(a), ...assign(was ?? (ownPick(a) ? undefined : main)),
      alt: {
        pick_area_id: a.area_id, pick_hotel: a.place, pick_zone: a.zone,
        drop_area_id: hasDrop(a) ? a.drop_area_id : null, drop_hotel: hasDrop(a) ? a.drop_place : null, drop_zone: hasDrop(a) ? a.drop_zone : null,
        pick_time: keepTime ? was!.alt!.pick_time : null, alt_who: a.who,
      },
    });
  });
  return parts;
}

/**
 * The van parts a booking's alternate pickups call for, trip by trip, where they differ from what is
 * stored. Every trip gets them (decided 2026-10-09; legacy did day 1 only). A cancelled booking is left
 * alone, as legacy's `bkV2HealAltSplits` leaves it.
 */
export function altPartsPlan(booking: Booking): { tripId: string; parts: StoredVanPart[] }[] {
  if ((SEAT_RELEASING_STATUSES as readonly string[]).includes(booking.status)) return [];
  return booking.trips.flatMap((trip) => {
    const current = partsFromView(trip.operations.van_parts);
    if (booking.alt_pickups.length === 0 && !isAuto(current)) return [];
    const parts = altPickupParts(booking.alt_pickups, countsOf(parsePaxGrid(trip.pax)), current);
    return !parts || canon(parts) === canon(partsToStore(current)) ? [] : [{ tripId: trip.id, parts }];
  });
}
