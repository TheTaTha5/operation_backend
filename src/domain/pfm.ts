/**
 * Proforma, legacy's Daily PFM (todo/money-model.md slice 2, decided 2026-10-09; migration 110):
 * `pfmInScope`, `pfmCutoff`, `renderDailyPFM`'s rows and tallies, `pfmApproveTravel`, `pfmHold` and
 * `pfmRemindAll`, decided here instead of in the browser. Pure, so both stores decide identically.
 *
 * A proforma agent pays before travel; the deadline is 18:00 (Bangkok) the day before the booking's
 * first trip. Past it and still unpaid, staff extend travel (anyone, naming who approved it) or put it
 * on hold, a label that blocks nothing (decided). Every decision and reminder is kept.
 */
import { amountOwed, refuse, type HistoryLine } from './booking-actions.js';
import { holdsSeats } from './booking-status.js';
import type { BookingInvoice } from './invoices.js';

const bad = (message: string): never => refuse(message, 400);
const cents = (n: number): number => Math.round(n * 100) / 100;

export type PfmEventKind = 'approved' | 'hold' | 'reminded';
export type PfmEvent = { id: number; booking_id: string; kind: PfmEventKind; approver: string | null; by: string | null; at: string };
export type PfmDecision = { decision: 'approved' | 'hold'; approver: string | null; by: string | null; at: string };
export type PfmStatus = 'hold' | 'approved' | 'paid' | 'prepaid_part' | 'alert' | 'awaiting' | 'no_invoice';
export const PFM_STATUSES: readonly PfmStatus[] = ['hold', 'approved', 'paid', 'prepaid_part', 'alert', 'awaiting', 'no_invoice'];

/** What a row needs of a booking. */
export type PfmBooking = {
  id: string; version: number; status: string; agent_id?: string; voucher_ref?: string; sold_by?: string; total?: number;
  fee_items: readonly { amount: number }[]; trips: readonly { route_id: string; service_date: string; pax_total: number }[]; invoice: BookingInvoice | null;
};
export type PfmAgent = { id: string; name: string; pay_type: string | null; sales_id: string | null };

/** Legacy `pfmCutoff`: 18:00 Bangkok (11:00 UTC) the day before. */
export const pfmCutoff = (firstTrip: string): string => new Date(Date.parse(`${firstTrip}T11:00:00Z`) - 86_400_000).toISOString();
const firstTrip = (b: Pick<PfmBooking, 'trips'>): string => b.trips.map((t) => t.service_date).sort()[0] ?? '';

/**
 * Legacy `pfmInScope`: a proforma agent's booking, or an invoice (credit) agent's that was paid ahead on
 * its own prepay invoice (§pfmPrepay). Cancelled, rejected and weather-cancelled ones are out.
 */
export function pfmKind(b: Pick<PfmBooking, 'status' | 'invoice'>, agent: Pick<PfmAgent, 'pay_type'> | undefined): 'proforma' | 'prepay' | null {
  if (!holdsSeats(b.status) || !agent) return null;
  if (agent.pay_type === 'proforma') return 'proforma';
  if (agent.pay_type === 'invoice' && b.invoice?.kind === 'prepay') return 'prepay';
  return null;
}

/** The decision in force (the last approve or hold) and the last reminder. */
export function pfmState(events: readonly PfmEvent[]): { decision: PfmDecision | null; reminded_at: string | null } {
  const sorted = [...events].sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1));
  const d = [...sorted].reverse().find((e) => e.kind !== 'reminded');
  const r = [...sorted].reverse().find((e) => e.kind === 'reminded');
  return { decision: d ? { decision: d.kind as 'approved' | 'hold', approver: d.approver, by: d.by, at: d.at } : null, reminded_at: r?.at ?? null };
}

export type PfmRow = {
  booking_id: string; version: number; voucher_ref: string | null; agent_id: string | null; agent_name: string | null; sales_name: string | null;
  kind: 'proforma' | 'prepay'; travel_date: string; route_id: string; pax: number; cutoff_at: string; past_cutoff: boolean;
  total: number; paid: number; balance: number; invoice: { id: string; number: string; status: string } | null;
  status: PfmStatus; decision: PfmDecision | null; reminded_at: string | null;
  /** Cash on tour taken off the agent's bill (slice 4); already out of `total` and `balance`. */
  cot_deduct: number;
};

/**
 * One row (`renderDailyPFM`). With an invoice its own amounts count (legacy took the booking's total and
 * the invoice's balance, which disagree once a deposit or a cash-on-tour deduction is involved: legacy's
 * own `bkV2PayOf` warns about it). Without one, the booking's total and fees, less its cash-on-tour
 * deductions. A prepay row counts only what was paid (§pfmPrepay) and has no cutoff.
 */
export function pfmRow(b: PfmBooking, agent: PfmAgent, salesName: string | null, kind: 'proforma' | 'prepay', events: readonly PfmEvent[], cotDeduct: number,
  range: { from: string; to: string }, now: Date): PfmRow {
  const inRange = b.trips.filter((t) => t.service_date >= range.from && t.service_date <= range.to).sort((x, y) => (x.service_date < y.service_date ? -1 : 1));
  const trip = inRange[0] ?? [...b.trips].sort((x, y) => (x.service_date < y.service_date ? -1 : 1))[0];
  const inv = b.invoice;
  const owed = cents(Math.max(0, amountOwed(b) - cotDeduct));
  const total = inv ? inv.total : owed;
  const balance = inv ? inv.balance : owed;
  const paid = inv ? inv.paid : 0;
  const cutoff = pfmCutoff(firstTrip(b));
  const past = now.getTime() > Date.parse(cutoff);
  const { decision, reminded_at } = pfmState(events);
  const unpaid = balance > 0;
  const status: PfmStatus = decision?.decision === 'hold' ? 'hold' : decision?.decision === 'approved' ? 'approved' : !unpaid && inv ? 'paid'
    : kind === 'prepay' ? 'prepaid_part' : past && unpaid ? 'alert' : inv ? 'awaiting' : 'no_invoice';
  return {
    booking_id: b.id, version: b.version, voucher_ref: b.voucher_ref ?? null, agent_id: b.agent_id ?? null, agent_name: agent.name, sales_name: salesName,
    kind, travel_date: trip?.service_date ?? '', route_id: trip?.route_id ?? '', pax: trip?.pax_total ?? 0, cutoff_at: cutoff, past_cutoff: kind === 'proforma' && past,
    total: kind === 'prepay' ? Math.max(0, paid) : total, paid: kind === 'prepay' ? Math.max(0, paid) : paid, balance: kind === 'prepay' ? 0 : balance,
    invoice: inv ? { id: inv.id, number: inv.number, status: inv.status } : null, status, decision, reminded_at, cot_deduct: cotDeduct,
  };
}

/** The tallies above legacy's list: totals, collected %, and how many rows are in each status. */
export function pfmTotals(rows: readonly PfmRow[]): { count: number; total: number; paid: number; unpaid: number; collected_pct: number; alert: number; by_status: Record<PfmStatus, number> } {
  const total = cents(rows.reduce((s, r) => s + r.total, 0)), paid = cents(rows.reduce((s, r) => s + r.paid, 0));
  const by = Object.fromEntries(PFM_STATUSES.map((s) => [s, 0])) as Record<PfmStatus, number>;
  for (const r of rows) by[r.status] += 1;
  return { count: rows.length, total, paid, unpaid: cents(rows.reduce((s, r) => s + (r.kind === 'proforma' ? r.balance : 0), 0)),
    collected_pct: total > 0 ? Math.round((paid / total) * 100) : 0, alert: by.alert, by_status: by };
}

/**
 * `pfmApproveTravel` and `pfmHold`: legacy shows the two buttons on a proforma row still owing after its
 * cutoff with no decision yet. Here the other decision may replace one (hold, then approve); the same
 * one twice is refused.
 */
export function planDecision(row: PfmRow | null, bookingId: string, decision: 'approved' | 'hold', approver: string | null, now: string, by: string | null):
  { event: Omit<PfmEvent, 'id'>; history: HistoryLine } {
  if (!row) return refuse(`Booking ${bookingId} is not a proforma booking`, 409, 'not_proforma');
  if (row.kind !== 'proforma') refuse(`Booking ${bookingId} was paid ahead on its own invoice: it has no PFM deadline`, 409, 'not_proforma');
  if (!(row.balance > 0)) refuse(`Booking ${bookingId} owes nothing`, 409, 'pfm_paid');
  if (!row.past_cutoff) refuse(`Booking ${bookingId}'s deadline is ${row.cutoff_at}: travel is extended or held only after it`, 409, 'before_cutoff');
  if (row.decision?.decision === decision) refuse(`Booking ${bookingId} is already ${decision === 'hold' ? 'on hold' : 'extended'}`, 409, 'pfm_decided');
  if (decision === 'approved') {
    const who = approver ?? bad('approver is required: who is extending travel (legacy asks for the salesperson)');
    return { event: { booking_id: bookingId, kind: 'approved', approver: who, by, at: now }, history: { by, kind: 'edit', tag: 'Confirmed', text: `PFM unpaid · travel EXTENDED by ${who}` } };
  }
  return { event: { booking_id: bookingId, kind: 'hold', approver: null, by, at: now }, history: { by, kind: 'edit', tag: 'Cancel', text: 'PFM unpaid · put on hold' } };
}

/** `pfmRemindAll`: the proforma rows still owing (held and approved ones too). */
export const toRemind = (rows: readonly PfmRow[]): PfmRow[] => rows.filter((r) => r.kind === 'proforma' && r.balance > 0);
export const remindedLine = (by: string | null): HistoryLine => ({ by, kind: 'edit', tag: 'Notify', text: 'PFM payment reminder sent' });

export const approverOf = (body: Record<string, unknown>): string | null => {
  const v = body.approver ?? body.extended_by ?? body.extendedBy;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return bad('approver must be text');
  return v.trim() || null;
};
