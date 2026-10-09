/**
 * Refund and credit (todo/weather-closures-model.md, decision 6, 2026-10-09; migration 061). Legacy's
 * weather outcomes `refund` and `credit` (`bkV2WeatherResolveOne`, `acctCreateDeposit`,
 * `acctApplyDeposit`, `acctPayUseDeposit`), decided here instead of in the browser. Pure, so both
 * stores decide identically.
 *
 * A weather cancel takes only the booking's share off its invoice. Legacy voided the whole invoice,
 * which may have carried other bookings (bug 6), then pushed a refund onto the voided invoice and
 * lost it on reload (bug 7). Here:
 * - the booking's lines are taken off; an invoice left with no other booking's line is voided;
 * - what the invoice was paid beyond what it still asks comes back: owed to the agent (`refund`), or
 *   kept as the agent's credit (`credit`), spent later as a payment with method `credit`.
 */
import { refuse } from './booking-actions.js';
import { invoiceAmounts, livePayments, paidOf, returnedOf, voided, type StoredInvoice, type StoredPayment, type StoredRefund } from './invoices.js';
import { todayInThailand } from './calendar.js';

const cents = (n: number): number => Math.round(n * 100) / 100;
const badRequest = (message: string): never => refuse(message, 400);

/** What `/cancel-weather` does with the money: legacy's "Cancel" ("No refund"), "Refund" and "Credit". */
export const WEATHER_CANCEL_OUTCOMES = ['cancel', 'refund', 'credit'] as const;
export type WeatherCancelOutcome = typeof WEATHER_CANCEL_OUTCOMES[number];

/** One invoice the booking was on, after its share came off, and what that frees. */
export type ShareOff = { invoice: StoredInvoice; refundable: number };

/**
 * Takes the booking's live lines off each live booking or prepay invoice that carries them. A fee
 * invoice stands: a fee for an earlier reschedule is still owed. An invoice left with no other live
 * line is voided, as legacy voids it; otherwise its totals and VAT are worked out from the lines left,
 * so the other bookings on it owe what they owed.
 *
 * `refundable` is what the invoice was paid, less refunds and credits already taken from it, less
 * what it still asks: never below 0. Payments go to the bookings still travelling first, so on a
 * shared invoice only money the invoice no longer needs comes back.
 */
export function takeShareOff(bookingId: string, invoices: readonly StoredInvoice[], payments: readonly StoredPayment[], refunds: readonly StoredRefund[],
  now: string, by: string | null): ShareOff[] {
  const out: ShareOff[] = [];
  for (const inv of invoices) {
    if (inv.voided || inv.kind === 'fee') continue;
    if (!inv.lines.some((l) => l.booking_id === bookingId && !l.removed_at)) continue;
    const others = inv.lines.some((l) => l.booking_id !== bookingId && !l.removed_at);
    let after: StoredInvoice;
    if (!others) after = voided(inv, 'weather', now, by);
    else {
      const lines = inv.lines.map((l) => (l.booking_id === bookingId && !l.removed_at ? { ...l, removed_at: now, removed_by: by, removed_reason: 'weather' } : { ...l }));
      after = { ...inv, lines, ...invoiceAmounts(lines, inv.vat_mode, inv.vat_rate) };
    }
    const net = cents(paidOf(payments.filter((p) => p.invoice_id === inv.id)) - returnedOf(refunds.filter((r) => r.invoice_id === inv.id)));
    out.push({ invoice: after, refundable: Math.max(0, cents(net - (after.voided ? 0 : after.total))) });
  }
  return out;
}

/** What a weather cancel would give back now: legacy's "Paid ฿x" on the follow-up list. */
export const refundableFor = (bookingId: string, invoices: readonly StoredInvoice[], payments: readonly StoredPayment[], refunds: readonly StoredRefund[]): number =>
  cents(takeShareOff(bookingId, invoices, payments, refunds, new Date(0).toISOString(), null).reduce((s, x) => s + x.refundable, 0));

export type WeatherMoney = { invoices: StoredInvoice[]; refunds: StoredRefund[]; amount: number };

/**
 * The money side of `/cancel-weather`. `cancel` keeps what was paid on the invoice (legacy "No
 * refund"); `refund` records it as owed to the agent; `credit` keeps it as the agent's balance, and
 * is refused when there is nothing to keep (legacy greys the option out) or no agent to keep it for.
 */
export function weatherMoney(input: {
  booking_id: string; outcome: WeatherCancelOutcome; invoices: readonly StoredInvoice[]; payments: readonly StoredPayment[]; refunds: readonly StoredRefund[];
  now: string; by: string | null; newId: () => string;
}): WeatherMoney {
  const shares = takeShareOff(input.booking_id, input.invoices, input.payments, input.refunds, input.now, input.by);
  const amount = cents(shares.reduce((s, x) => s + x.refundable, 0));
  if (input.outcome === 'credit') {
    if (!(amount > 0)) refuse(`Booking ${input.booking_id} has nothing paid to keep as credit`, 409, 'nothing_paid');
    const orphan = shares.find((s) => s.refundable > 0 && !s.invoice.agent_id);
    if (orphan) refuse(`Invoice ${orphan.invoice.number} has no agent to keep the credit for: refund it instead`, 409, 'no_agent');
  }
  const refunds = input.outcome === 'cancel' ? [] : shares.filter((s) => s.refundable > 0).map((s): StoredRefund => ({
    id: input.newId(), kind: input.outcome as 'refund' | 'credit', invoice_id: s.invoice.id, booking_id: input.booking_id, agent_id: s.invoice.agent_id,
    amount: s.refundable, reason: 'weather', created_by: input.by, created_at: input.now,
  }));
  return { invoices: shares.map((s) => s.invoice), refunds, amount };
}

// ── The agent's credit balance ───────────────────────────────────────────────────────────────────

export type CreditBalance = { credited: number; used: number; available: number };

/**
 * Legacy `acctAgentDepositAvail`: the agent's credits less what its live `credit` payments spent.
 * `payments` are the payments on the agent's invoices; others are ignored.
 */
export function creditBalance(refunds: readonly Pick<StoredRefund, 'kind' | 'amount'>[], payments: readonly StoredPayment[]): CreditBalance {
  const credited = cents(returnedOf(refunds.filter((r) => r.kind === 'credit')));
  const used = cents(livePayments(payments).filter((p) => p.method === 'credit').reduce((s, p) => s + p.amount, 0));
  return { credited, used, available: cents(credited - used) };
}

/** A `credit` payment spends the invoice agent's balance, never more than it holds (legacy `acctPayUseDeposit`). */
export function assertCreditCovers(invoice: Pick<StoredInvoice, 'number' | 'agent_id'>, balance: CreditBalance, amount: number): void {
  if (!invoice.agent_id) refuse(`Invoice ${invoice.number} has no agent, so there is no credit to spend`, 409, 'no_agent');
  if (amount > balance.available + 0.005) {
    refuse(`Agent ${invoice.agent_id} has ฿${balance.available.toLocaleString('en-US')} of credit; this payment asks for ฿${amount.toLocaleString('en-US')}`, 409, 'credit_short');
  }
}

// ── Lists ────────────────────────────────────────────────────────────────────────────────────────

export type RefundListQuery = { agent_id?: string; booking_id?: string; kind?: 'refund' | 'credit'; from?: string; to?: string };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function parseRefundListQuery(query: Record<string, unknown>): RefundListQuery {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const day = (v: unknown, name: string) => { const s = str(v); if (s !== undefined && !ISO_DAY.test(s)) badRequest(`${name} must be a YYYY-MM-DD date`); return s; };
  const kind = str(query.kind);
  if (kind !== undefined && kind !== 'refund' && kind !== 'credit') badRequest('kind must be refund or credit');
  const out: RefundListQuery = {};
  for (const [key, value] of [['agent_id', str(query.agent_id)], ['booking_id', str(query.booking_id)], ['kind', kind], ['from', day(query.from, 'from')], ['to', day(query.to, 'to')]] as const) {
    if (value !== undefined) (out as Record<string, string>)[key] = value;
  }
  return out;
}
/** `from` and `to` are the day it was recorded, Bangkok time. */
export const matchesRefundQuery = (r: StoredRefund, q: RefundListQuery): boolean =>
  (!q.agent_id || r.agent_id === q.agent_id) && (!q.booking_id || r.booking_id === q.booking_id) && (!q.kind || r.kind === q.kind)
  && (!q.from || todayInThailand(new Date(r.created_at)) >= q.from) && (!q.to || todayInThailand(new Date(r.created_at)) <= q.to);
