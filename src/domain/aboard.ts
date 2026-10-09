/**
 * Who actually travelled, from a trip's check-in records (todo/money-model.md slices 5 and 6). Legacy
 * reads this two ways and both are kept:
 * - `ckLostByType` / `ckPaxLeft`: the passengers lost by category, from the no-show and on-site
 *   cancel events. The partner van bill sells by it (§vbPaxReal).
 * - `ckSummary`: booked less the last count taken (the pier's, else the van's). Travel Summary's
 *   "travelled" reads it.
 * Legacy read only the trip's main record; here every slot (van part) counts, which is the same for a
 * trip that is not split. Pure, so both stores decide identically.
 */
import type { CheckinView } from './checkin.js';
import type { BookingTrip } from './operations.js';
import { PAX_CATEGORIES, parsePaxGrid, type PaxCategory } from './pax.js';
import { countsOf, partPax, type Counts } from './van-groups.js';

/** A van no-show with one of these reasons still went: on their own, or on another van (legacy `expectAtPier`). */
export const EXPECT_AT_PIER = new Set(['self_arrive', 'own_transfer']);

export type Lost = Counts & { total: number; unalloc: number; ns: number; cxl: number; self_pier: number };
type Records = { van: readonly CheckinView[]; pier: readonly CheckinView[] };

/** Legacy `ckLostByType`: the passengers lost on the van and at the pier, by category. */
export function lostByType(checkins: Records): Lost {
  const out: Lost = { ad: 0, chd: 0, inf: 0, foc: 0, total: 0, unalloc: 0, ns: 0, cxl: 0, self_pier: 0 };
  const reinstated = checkins.pier.some((r) => r.reinstate);
  for (const [kind, records] of [['van', checkins.van], ['pier', checkins.pier]] as const) {
    for (const r of records) {
      for (const e of r.events) {
        if (e.undone) continue;
        const n = Math.max(0, e.pax);
        if (!n) continue;
        // Didn't board the van but said they would go to the pier, or the pier confirmed they came.
        if (kind === 'van' && e.type !== 'cxl' && (reinstated || EXPECT_AT_PIER.has(e.reason_code ?? ''))) { out.self_pier += n; continue; }
        out.total += n;
        if (e.type === 'cxl') out.cxl += n; else out.ns += n;
        if ((e.ad ?? 0) || (e.chd ?? 0) || (e.inf ?? 0) || (e.foc ?? 0)) for (const k of PAX_CATEGORIES) out[k] += e[k] ?? 0;
        else out.unalloc += n;
      }
    }
  }
  // Legacy §ckSelfLost: the pier confirmed people who came on their own; they come back off the lost.
  for (const r of checkins.pier) {
    const sa = r.self_add;
    if (!sa || !(sa.pax > 0)) continue;
    const back = Math.min(out.total, sa.pax);
    if (back <= 0) continue;
    let rest = back;
    for (const k of PAX_CATEGORIES) { const q = Math.min(out[k], Math.max(0, sa[k] ?? 0), rest); out[k] -= q; rest -= q; }
    if (rest > 0) { const u = Math.min(out.unalloc, rest); out.unalloc -= u; rest -= u; }
    while (rest > 0) {
      let big: PaxCategory | '' = '', bn = 0;
      for (const k of PAX_CATEGORIES) if (out[k] > bn) { bn = out[k]; big = k; }
      if (!big) break;
      out[big]--; rest--;
    }
    const used = back - rest, nn = Math.min(out.ns, used);
    out.ns -= nn;
    out.cxl = Math.max(0, out.cxl - (used - nn));
    out.total -= used;
    out.self_pier += used;
  }
  return out;
}

export const bookedCounts = (trip: Pick<BookingTrip, 'pax'>): Counts => countsOf(parsePaxGrid(trip.pax));

/** Legacy `ckPaxLeft` for every category: booked less lost; lost with no breakdown comes off adults. */
export function aboardCounts(trip: Pick<BookingTrip, 'pax' | 'operations'>): Counts {
  const booked = bookedCounts(trip), lost = lostByType(trip.operations.checkins);
  const out = {} as Counts;
  for (const k of PAX_CATEGORIES) out[k] = Math.max(0, booked[k] - lost[k]);
  if (lost.unalloc > 0) out.ad = Math.max(0, out.ad - lost.unalloc);
  return out;
}

/**
 * Legacy `ckSummary(...).noShow`, per slot: booked less the pier's count once the pier checked in,
 * else less the van's once the van did. A slot's booked is its van part's.
 */
export function summaryNoShow(trip: Pick<BookingTrip, 'pax' | 'pax_total' | 'operations'>): number {
  const { van, pier } = trip.operations.checkins;
  const parts = trip.operations.van_parts;
  const bookedOf = (slot: number, r: CheckinView | undefined): number => {
    if (parts.length <= 1 && slot === 0) return trip.pax_total;
    const part = parts.find((p) => p.idx === slot);
    return part ? partPax(part) : r?.expected ?? 0;
  };
  const slots = new Set([...van, ...pier].map((r) => r.slot));
  let miss = 0;
  for (const slot of slots) {
    const p = pier.find((r) => r.slot === slot && r.checked_in_at), v = van.find((r) => r.slot === slot && r.checked_in_at);
    const booked = bookedOf(slot, p ?? v);
    if (p) miss += Math.max(0, booked - (p.actual_pax ?? booked));
    else if (v) miss += Math.max(0, booked - (v.actual_pax ?? booked));
  }
  return miss;
}
