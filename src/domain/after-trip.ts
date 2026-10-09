/**
 * After the trip (todo/money-model.md slice 4, decided 2026-10-09; migration 112): legacy's Travel
 * Summary decisions, per booking and trip date. Pure, so both stores decide identically.
 *
 * - The cash-on-tour decision (`TS_COT`, `tsCotPick`, `tsCotAmt`): what became of the cash the
 *   customer paid on tour. `deduct` comes off the agent's invoice (decided: legacy only warned, so it
 *   was collected twice), `payout` is paid back to the agent, the rest the company keeps; `nocol` says
 *   it was never collected, and why.
 * - The no-show charge decision (`travel_sum`, `tsSet`, `tsTripAmount`): what a no-show is charged.
 *   It bills nothing by itself, as in legacy.
 *
 * An invoice is frozen at issue and a proforma one is issued before the trip, so a deduction reaches it
 * as a line of its own: one minus line per trip date, kept in step with the decision, after which the
 * totals and VAT are worked out again as a discount's are.
 */
import { refuse, type HistoryLine } from './booking-actions.js';
import { cotLineLabel, invoiceAmounts, liveBookingInvoiceOf, NOT_REMOVED, type StoredInvoice } from './invoices.js';
import type { AttachmentRef } from './attachments.js';
import { assertOnTrip, slipIdsOf, type MoneyBooking } from './pier-money.js';

const bad = (message: string): never => refuse(message, 400);
const cents = (n: number): number => Math.round(n * 100) / 100;
/** Legacy `_tsCotNum` and `tsSet`: whole baht, never below 0. */
const wholeBaht = (value: unknown, name: string): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.replace(/,/g, '')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return bad(`${name} must be a number, 0 or more`);
  return Math.round(n);
};
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return bad(`${name} must be text`);
  return value.trim() || null;
};
const baht = (n: number): string => `฿${Math.round(n).toLocaleString('en-US')}`;

// ── Cash on tour ─────────────────────────────────────────────────────────────────────────────────

export const COT_MODES = ['full', 'part', 'none', 'payout', 'nocol'] as const;
export type CotMode = typeof COT_MODES[number];
export type StoredCotDecision = {
  booking_id: string; service_date: string; mode: CotMode; deduct: number; payout: number; ref: string | null; by: string | null; at: string; slips: string[];
};
export type CotDecisionView = Omit<StoredCotDecision, 'slips'> & {
  /** The booking's cash on tour, what the company keeps, and whether deduct + payout is more than it (a warning, as legacy). */
  cot: number; kept: number; over: boolean; slips: AttachmentRef[];
};
export const cotAmount = (b: Pick<MoneyBooking, 'cash_on_tour_amount'>): number => Math.max(0, b.cash_on_tour_amount ?? 0);
export const cotDecisionView = (d: StoredCotDecision, cot: number, files: ReadonlyMap<string, AttachmentRef> = new Map()): CotDecisionView => ({
  ...d, cot, kept: Math.max(0, cents(cot - d.deduct - d.payout)), over: d.deduct + d.payout > cot + 0.005,
  slips: d.slips.map((id) => files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 }),
});
/** Legacy `tsCotSugMode`: what the screen suggests before anyone decides. */
export const suggestedCotMode = (handling: string | null | undefined): CotMode => (handling === 'separate' ? 'none' : 'full');

/**
 * `PUT /v1/bookings/{id}/cot-decisions/{date}` (legacy `tsCotPick`/`tsCotAmt`/`tsCotRefSave`). `full`
 * and `payout` take the whole cash on tour, `none` and `nocol` nothing; `part` is the client's split,
 * starting from deduct-all when it was another mode (legacy). A computed amount sent different is
 * `400`. The slips stay when the mode changes (legacy §cotSlip) unless new ones are sent.
 */
export function planCotDecision(b: Pick<MoneyBooking, 'id' | 'trips' | 'cash_on_tour_amount'>, date: string, body: Record<string, unknown>, current: StoredCotDecision | undefined,
  now: string, by: string | null): { decision: StoredCotDecision; warnings: { code: string; message: string }[] } {
  const cot = cotAmount(b);
  if (!(cot > 0)) refuse(`Booking ${b.id} has no cash on tour to decide on`, 409, 'no_cash_on_tour');
  assertOnTrip(b, date);
  const mode = (COT_MODES as readonly unknown[]).includes(body.mode) ? body.mode as CotMode : bad(`mode must be one of ${COT_MODES.join(', ')}`);
  const sent = (k: 'deduct' | 'payout') => (body[k] === undefined || body[k] === null || body[k] === '' ? undefined : wholeBaht(body[k], k));
  let deduct = 0, payout = 0;
  if (mode === 'part') {
    const wasPart = current?.mode === 'part';
    deduct = sent('deduct') ?? (wasPart ? current!.deduct : Math.round(cot));
    payout = sent('payout') ?? (wasPart ? current!.payout : 0);
  } else {
    deduct = mode === 'full' ? Math.round(cot) : 0;
    payout = mode === 'payout' ? Math.round(cot) : 0;
    for (const [k, v] of [['deduct', deduct], ['payout', payout]] as const) {
      const s = sent(k);
      if (s !== undefined && s !== v) bad(`${k} is ${v} for mode ${mode}: send mode part to split the cash on tour yourself`);
    }
  }
  const ref = body.ref !== undefined ? text(body.ref, 'ref') : current?.ref ?? null;
  const slips = body.slip_ids !== undefined || body.slips !== undefined ? slipIdsOf(body.slip_ids ?? body.slips) : current?.slips ?? [];
  const decision: StoredCotDecision = { booking_id: b.id, service_date: date, mode, deduct, payout, ref, by, at: now, slips };
  const warnings = deduct + payout > cot + 0.005
    ? [{ code: 'cot_over', message: `Deduct ${baht(deduct)} and payout ${baht(payout)} are more than the cash on tour (${baht(cot)})` }] : [];
  return { decision, warnings };
}

/** Each trip date's deduction, as the invoice lines carry them. */
export const cotDeductions = (decisions: readonly Pick<StoredCotDecision, 'service_date' | 'deduct'>[]): { service_date: string; deduct: number }[] =>
  decisions.filter((d) => d.deduct > 0).map((d) => ({ service_date: d.service_date, deduct: d.deduct })).sort((a, b) => (a.service_date < b.service_date ? -1 : 1));

/**
 * The booking's live booking or prepay invoice with its cash-on-tour lines in step with the decisions:
 * a line per date with a deduction (added, or its amount changed), a date with none taken off
 * (`removed_reason: 'cot'`), then the totals and VAT worked out again. Answers nothing when no live
 * invoice carries the booking or nothing changed. A fee invoice is never touched.
 */
export function syncCotLines(bookingId: string, invoices: readonly StoredInvoice[], decisions: readonly Pick<StoredCotDecision, 'service_date' | 'deduct'>[], now: string, by: string | null):
  { invoice: StoredInvoice; before: StoredInvoice } | undefined {
  const inv = liveBookingInvoiceOf(bookingId, invoices);
  if (!inv) return undefined;
  const want = new Map(cotDeductions(decisions).map((d) => [d.service_date, d.deduct]));
  const lines = inv.lines.map((l) => ({ ...l }));
  let changed = false;
  for (const l of lines) {
    if (l.booking_id !== bookingId || !l.cot_date) continue;
    const amount = want.get(l.cot_date);
    if (amount === undefined) {
      if (!l.removed_at) { Object.assign(l, { removed_at: now, removed_by: by, removed_reason: 'cot' }); changed = true; }
    } else {
      if (l.removed_at || l.amount !== -amount) { Object.assign(l, { amount: -amount, removed_at: null, removed_by: null, removed_reason: null }); changed = true; }
      want.delete(l.cot_date);
    }
  }
  let seq = Math.max(-1, ...lines.map((l) => l.seq)) + 1;
  for (const [date, deduct] of [...want].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    lines.push({ seq: seq++, booking_id: bookingId, label: cotLineLabel(date), amount: -deduct, discount: null, ...NOT_REMOVED, cot_date: date });
    changed = true;
  }
  if (!changed) return undefined;
  return { before: inv, invoice: { ...inv, lines, ...invoiceAmounts(lines, inv.vat_mode, inv.vat_rate) } };
}

export const cotInvoiceLine = (by: string | null, inv: StoredInvoice, deducted: number): HistoryLine =>
  ({ by, kind: 'invoice', tag: 'Invoice', text: `Invoice ${inv.number} · cash on tour deducted ${baht(deducted)} · total ${baht(inv.total)}` });

// ── No-show charges ──────────────────────────────────────────────────────────────────────────────

export const NOSHOW_DECISIONS = ['full', 'partial', 'none', 'postpone'] as const;
export type NoshowDecision = typeof NOSHOW_DECISIONS[number];
export type StoredNoshowCharge = { booking_id: string; service_date: string; decision: NoshowDecision; amount: number; note: string | null; by: string | null; at: string };

/**
 * Legacy `tsTripAmount`: the price of the trip that day. An overnight return leg has none of its own
 * (it is in the way out); a multi-trip booking's trip has its own subtotal; else the booking's total.
 */
export function tripAmount(b: Pick<MoneyBooking, 'trips' | 'total'>, date: string): number {
  const t = b.trips.find((x) => x.service_date === date);
  if (!t || t.ovn_leg) return 0;
  if (b.trips.length > 1 && typeof t.subtotal === 'number' && t.subtotal > 0) return t.subtotal;
  return b.total ?? 0;
}

/**
 * `PUT /v1/bookings/{id}/noshow-charges/{date}` (legacy `tsPick`, `tsCustom`, `tsPostpone`): `full`
 * charges the trip's price (the server's), `partial` the client's amount, `none` and `postpone` nothing.
 */
export function planNoshowCharge(b: Pick<MoneyBooking, 'id' | 'trips' | 'total'>, date: string, body: Record<string, unknown>, now: string, by: string | null): StoredNoshowCharge {
  assertOnTrip(b, date);
  const decision = (NOSHOW_DECISIONS as readonly unknown[]).includes(body.decision) ? body.decision as NoshowDecision : bad(`decision must be one of ${NOSHOW_DECISIONS.join(', ')}`);
  const sent = body.amount === undefined || body.amount === null || body.amount === '' ? undefined : wholeBaht(body.amount, 'amount');
  let amount: number;
  if (decision === 'partial') amount = sent ?? bad('amount is required for a partial charge: legacy asks "ยอดที่จะเก็บ (บาท)"');
  else {
    amount = decision === 'full' ? Math.max(0, Math.round(tripAmount(b, date))) : 0;
    if (sent !== undefined && sent !== amount) bad(`amount is ${amount} for decision ${decision}${decision === 'full' ? ' (the trip\'s price)' : ''}: send decision partial to charge another amount`);
  }
  return { booking_id: b.id, service_date: date, decision, amount, note: text(body.note, 'note'), by, at: now };
}
