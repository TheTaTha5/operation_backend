/**
 * Legacy's booking action records as rows for this service's tables: the cancellation, the latest
 * reschedule, every partial cancel, the fee items and the history (`README.md`, the booking actions;
 * hand-off §7). Pure, so `test/legacy-records.test.ts` can check the mapping on fixture rows without
 * a legacy database; `import-legacy.ts` reads the source and writes what these return.
 *
 * The cutover import runs once, so a record left out here is lost for good. A row that does not map
 * is reported, never guessed; an expected absence (an old cancel with no category) is only counted.
 */
import { holdsSeats, type BookingStatus } from '../domain/booking-status.js';
import { cancelGroup, isCancelCategory } from '../domain/booking-actions.js';
import { parsePaxGrid, formatPaxGrid } from '../domain/pax.js';

type Row = Record<string, unknown>;
export type Report = { skip(kind: string, id: string, reason: string): void; note(what: string): void };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const money = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const count = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0; };
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const day = (value: unknown): string | null => { const s = str(value); return ISO_DAY.test(s) && !Number.isNaN(Date.parse(s)) ? s : null; };
const CHARGE_TYPES = new Set(['none', 'full', 'partial']);
const chargeType = (value: unknown): string | undefined => { const s = str(value) || 'none'; return CHARGE_TYPES.has(s) ? s : undefined; };

/**
 * The booking's cancellation record. Only a booking that has given its seats back keeps one; a
 * restored booking's leftover columns are stale. A cancel from before categories existed has none,
 * and its text is already carried in `cancellation_reason`.
 */
export function cancellationRow(booking: Row, bookingId: string, status: BookingStatus, fallbackAt: string, report: Report): Row | undefined {
  const category = str(booking.cancellation_category) || str(booking.cancelcategory);
  if (holdsSeats(status)) { if (category) report.note('cancellation records dropped: booking no longer cancelled'); return undefined; }
  if (!category) { report.note('cancellations without a category (reason text only)'); return undefined; }
  if (!isCancelCategory(category)) { report.skip('cancellation', bookingId, `category ${category} is not a cancel category`); return undefined; }
  const type = chargeType(booking.cancellation_chargetype);
  if (!type) { report.skip('cancellation', bookingId, `charge type ${str(booking.cancellation_chargetype)}`); return undefined; }
  return {
    booking_id: bookingId, category, grp: cancelGroup(category), note: str(booking.cancellation_note) || null,
    charge_type: type, charge_amount: type === 'none' ? 0 : Math.max(0, money(booking.cancellation_chargeamount)),
    at: instant(booking.cancellation_at) ?? instant(booking.cancelledat) ?? fallbackAt, by: str(booking.cancellation_by) || null,
  };
}

/**
 * Legacy keeps only the latest reschedule. A `rebook` with no `reschedule` beside it is the weather
 * flow's move (`reason: 'weather'`); with one, it is the same move written twice and is ignored.
 */
export function rescheduleRow(booking: Row, bookingId: string, fallbackAt: string, report: Report): Row | undefined {
  if (str(booking.reschedule_fromdate) || str(booking.reschedule_todate)) {
    const from = day(booking.reschedule_fromdate), to = day(booking.reschedule_todate);
    if (!from || !to) { report.skip('reschedule', bookingId, `dates ${str(booking.reschedule_fromdate)} → ${str(booking.reschedule_todate)}`); return undefined; }
    const type = chargeType(booking.reschedule_chargetype);
    if (!type) { report.skip('reschedule', bookingId, `charge type ${str(booking.reschedule_chargetype)}`); return undefined; }
    const amount = Math.max(0, money(booking.reschedule_chargeamount));
    const collect = str(booking.reschedule_collect);
    return {
      booking_id: bookingId, from_date: from, to_date: to, reason: str(booking.reschedule_reason) || null, charge_type: type, charge_amount: amount,
      collect: amount > 0 && (collect === 'invoice' || collect === 'separate') ? collect : 'none',
      at: instant(booking.reschedule_at) ?? fallbackAt, by: str(booking.reschedule_by) || null,
    };
  }
  if (!str(booking.rebook_from) && !str(booking.rebook_to)) return undefined;
  const from = day(booking.rebook_from), to = day(booking.rebook_to);
  if (!from || !to) { report.skip('reschedule', bookingId, `rebook dates ${str(booking.rebook_from)} → ${str(booking.rebook_to)}`); return undefined; }
  report.note('reschedules taken from rebook (no reschedule record)');
  return {
    booking_id: bookingId, from_date: from, to_date: to, reason: str(booking.rebook_reason) || null, charge_type: 'none', charge_amount: 0, collect: 'none',
    at: instant(booking.rebook_at) ?? fallbackAt, by: null,
  };
}

/**
 * Every partial cancel. `paxremoved_<key>` columns become the grid. `tripidx` is the trip's position
 * in the legacy booking, which is the imported trip `trip_<booking>_<position>`; a position the
 * booking no longer has keeps the date and no trip.
 */
export function partialCancelRows(rows: readonly Row[], bookingId: string, tripIds: readonly string[], tripDates: readonly string[], fallbackAt: string, report: Report): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const where = `${bookingId}#${str(row.idx)}`;
    const grid: Record<string, number> = {};
    for (const [column, value] of Object.entries(row)) {
      if (!column.startsWith('paxremoved_')) continue;
      const n = count(value);
      if (n > 0) grid[column.slice('paxremoved_'.length)] = n;
    }
    let paxRemoved: Record<string, number>;
    try { paxRemoved = formatPaxGrid(parsePaxGrid(grid, 'pax_removed')); } catch (error) { report.skip('partial cancel', where, (error as Error).message); continue; }
    const position = row.tripidx == null || str(row.tripidx) === '' ? -1 : Number(row.tripidx);
    const tripId = Number.isInteger(position) && position >= 0 && position < tripIds.length ? tripIds[position] : null;
    if (!tripId) report.note('partial cancels whose trip is gone (kept with its date)');
    const category = str(row.category);
    if (category && !isCancelCategory(category)) report.note('partial cancels with an unknown category (kept, no group)');
    out.push({
      booking_id: bookingId, booking_trip_id: tripId, service_date: day(row.date) ?? (tripId ? tripDates[position] : null),
      pax_removed: paxRemoved, count: count(row.count) || Object.values(paxRemoved).reduce((sum, n) => sum + n, 0),
      category: category || null, grp: isCancelCategory(category) ? cancelGroup(category) : null, note: str(row.note) || null,
      charged_count: count(row.charged_count), charged_amount: Math.max(0, money(row.charged_amount)),
      waived_count: count(row.waived_count), waived_amount: Math.max(0, money(row.waived_amount ?? row.refund)),
      at: instant(row.at) ?? fallbackAt, by: str(row.by) || null,
    });
  }
  return out;
}

export function feeItemRows(rows: readonly Row[], bookingId: string, fallbackAt: string, report: Report): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const where = `${bookingId}#${str(row.idx)}`;
    const type = str(row.type);
    if (!type) { report.skip('fee item', where, 'no type'); continue; }
    const amount = money(row.amount);
    if (amount < 0) { report.skip('fee item', where, `negative amount ${amount}`); continue; }
    out.push({ booking_id: bookingId, type, label: str(row.label) || null, amount, at: instant(row.at) ?? fallbackAt });
  }
  return out;
}

/** Legacy writes `kind || 'note'` and `text || ''`, so those defaults reproduce what it showed. */
export function historyRows(rows: readonly Row[], bookingId: string, fallbackAt: string, report: Report): Row[] {
  return rows.map((row) => {
    const at = instant(row.at);
    if (!at) report.note('history lines with no readable time (given the booking\'s)');
    return { booking_id: bookingId, at: at ?? fallbackAt, by: str(row.by) || null, kind: str(row.kind) || 'note', tag: str(row.tag) || null, text: str(row.text) };
  });
}
