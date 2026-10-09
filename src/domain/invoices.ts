/**
 * Invoices and payments (todo/money-model.md slice 1, approved 2026-10-09; migration 045): legacy's
 * accounting (`acctCreateInvoice`, `acctRecordPayment`, `acctInvoiceState`, `acctVoidInvoice`,
 * `acctCreateFeeInvoice`, `acctInvDisc`, `acctInvRecalc`, `pfmEditSubmit`, `agCreditState`), decided
 * here instead of in the browser. Pure, so both stores decide identically.
 *
 * An invoice's amounts are frozen when it is issued: each line keeps the amount it was issued for
 * (legacy `gross0`) and is never recomputed from the booking. Discounts come off those amounts, and
 * VAT is worked out again the way it was at issue. Its status is not stored: `voided` and the
 * payments decide it.
 */
import { amountOwed, baht, refuse, type HistoryLine } from './booking-actions.js';
import type { Agent } from './agents.js';
import { todayInThailand } from './calendar.js';
import type { BookingStatus } from './booking-status.js';
import type { AttachmentRef } from './attachments.js';

const badRequest = (message: string): never => refuse(message, 400);

export const VAT_RATE = 0.07;
export const VAT_MODES = ['none', 'include', 'exclude'] as const;
export type VatMode = typeof VAT_MODES[number];
export type InvoiceKind = 'booking' | 'prepay' | 'fee';
export type FeeType = 'cancellation' | 'reschedule';
/** `credit` spends the agent's credit balance (`refunds.ts`); the others are money received. */
export const PAYMENT_METHODS = ['transfer', 'cash', 'card', 'credit'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];
export type InvoiceStatus = 'issued' | 'partial' | 'paid' | 'void';

/**
 * `removed_*`: a line taken off a live invoice (a weather cancel takes only its booking's lines off,
 * migration 061). It stays on the document and leaves every total.
 */
export type InvoiceLine = {
  seq: number; booking_id: string | null; label: string; amount: number; discount: number | null;
  removed_at: string | null; removed_by: string | null; removed_reason: string | null;
};
export const NOT_REMOVED = { removed_at: null, removed_by: null, removed_reason: null } as const;
/** The document's header text: legacy's editor wrote it and lost it on every save. */
export const HEADER_FIELDS = ['note', 'ref', 'dear', 'accept_at', 'remark'] as const;
type HeaderField = typeof HEADER_FIELDS[number];

export type StoredInvoice = {
  id: string; number: string; agent_id: string | null; kind: InvoiceKind; fee_type: FeeType | null;
  vat_mode: VatMode | null; vat_rate: number | null;
  subtotal: number; net_amount: number | null; vat_amount: number | null; total: number; wht_amount: number | null;
  issued_at: string; due_at: string;
  voided: boolean; voided_at: string | null; voided_by: string | null; void_reason: string | null;
  created_by: string | null;
  lines: InvoiceLine[];
} & Record<HeaderField, string | null>;

export type StoredPayment = {
  id: string; invoice_id: string; amount: number; method: PaymentMethod; paid_on: string; ref: string | null;
  recorded_by: string | null; recorded_at: string;
  deleted_at: string | null; deleted_by: string | null; delete_reason: string | null;
  /** Attachment ids, in order. */
  slips: string[];
};

/**
 * Money taken back from an invoice for one booking (migration 061): owed back to the agent (`refund`)
 * or kept as the agent's credit (`credit`), spent later as a payment with method `credit`.
 */
export type RefundKind = 'refund' | 'credit';
export type StoredRefund = {
  id: string; kind: RefundKind; invoice_id: string; booking_id: string | null; agent_id: string | null;
  amount: number; reason: string; created_by: string | null; created_at: string;
};

export const copyInvoice = (i: StoredInvoice): StoredInvoice => ({ ...i, lines: i.lines.map((l) => ({ ...l })) });

/** Money to the satang, so sums of NUMERIC(12,2) values don't drift. */
const cents = (n: number): number => Math.round(n * 100) / 100;
const sum = (values: readonly number[]): number => cents(values.reduce((s, v) => s + v, 0));

// ── Amounts ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `acctInvRecalc` (and `acctCreateInvoice`, which is the same with no discount): the discounts come
 * off the amount issued, never more than all of it, then VAT in whole baht by the VAT mode.
 */
export function invoiceAmounts(all: readonly (Pick<InvoiceLine, 'amount' | 'discount'> & { removed_at?: string | null })[], vatMode: VatMode | null, vatRate: number | null):
  Pick<StoredInvoice, 'subtotal' | 'net_amount' | 'vat_amount' | 'total'> {
  const lines = all.filter((l) => !l.removed_at);
  const gross = sum(lines.map((l) => l.amount));
  const discount = Math.min(sum(lines.map((l) => l.discount ?? 0)), gross);
  const subtotal = cents(Math.max(0, gross - discount));
  const rate = vatRate || VAT_RATE;
  if (vatMode === 'exclude') { const vat = Math.round(subtotal * rate); return { subtotal, net_amount: subtotal, vat_amount: vat, total: cents(subtotal + vat) }; }
  if (vatMode === 'include') { const net = Math.round(subtotal / (1 + rate)); return { subtotal, net_amount: net, vat_amount: cents(subtotal - net), total: subtotal }; }
  return { subtotal, net_amount: subtotal, vat_amount: 0, total: subtotal };
}

/** Payments that count: a deleted one stays on record but out of every total. */
export const livePayments = (payments: readonly StoredPayment[]): StoredPayment[] => payments.filter((p) => !p.deleted_at);
export const paidOf = (payments: readonly StoredPayment[]): number => sum(livePayments(payments).map((p) => p.amount));
/** What refunds and credits took back from an invoice. */
export const returnedOf = (refunds: readonly Pick<StoredRefund, 'amount'>[]): number => sum(refunds.map((r) => r.amount));

/**
 * `acctInvoiceState`: void; paid once the payments reach the total (WHT does not count, decided
 * 2026-10-09); partial when something is paid; issued otherwise. A void invoice owes nothing.
 */
export function invoiceState(invoice: { voided: boolean; total: number }, paid: number): { status: InvoiceStatus; balance: number } {
  if (invoice.voided) return { status: 'void', balance: 0 };
  const balance = cents(Math.max(0, invoice.total - paid));
  return { status: balance <= 0 && invoice.total > 0 ? 'paid' : paid > 0 ? 'partial' : 'issued', balance };
}

export type PaymentView = Omit<StoredPayment, 'slips'> & { slips: AttachmentRef[] };
export type InvoiceView = StoredInvoice & {
  /** `paid` is every live payment; `status` and `balance` count it less `refunded` and `credited`. */
  status: InvoiceStatus; paid: number; balance: number; refunded: number; credited: number;
  refunds: StoredRefund[];
  /** What the document asks to be paid: the total less withholding tax (legacy's "Payment Amount"). */
  payment_amount: number;
  booking_ids: string[];
  payments: PaymentView[];
};

const fileRef = (files: ReadonlyMap<string, AttachmentRef>, id: string): AttachmentRef =>
  files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 };
export const bookingIdsOf = (invoice: Pick<StoredInvoice, 'lines'>): string[] =>
  [...new Set(invoice.lines.map((l) => l.booking_id).filter((id): id is string => !!id))];

export function invoiceView(invoice: StoredInvoice, payments: readonly StoredPayment[], files: ReadonlyMap<string, AttachmentRef> = new Map(),
  refunds: readonly StoredRefund[] = []): InvoiceView {
  const paid = paidOf(payments);
  const refunded = returnedOf(refunds.filter((r) => r.kind === 'refund')), credited = returnedOf(refunds.filter((r) => r.kind === 'credit'));
  return {
    ...invoice, lines: invoice.lines.map((l) => ({ ...l })), ...invoiceState(invoice, cents(paid - refunded - credited)), paid, refunded, credited,
    refunds: refunds.map((r) => ({ ...r })),
    payment_amount: cents(invoice.total - (invoice.wht_amount ?? 0)), booking_ids: bookingIdsOf(invoice),
    payments: payments.map((p) => ({ ...p, slips: p.slips.map((id) => fileRef(files, id)) })),
  };
}

// ── A booking's invoice and payment state ────────────────────────────────────────────────────────

/**
 * What a booking read needs of each invoice that names it on a live line (a line a weather cancel
 * took off does not count). `returned` is what refunds and credits took back from it.
 */
export type InvoiceBrief = { id: string; number: string; kind: InvoiceKind; fee_type: FeeType | null; total: number; issued_at: string; voided: boolean; paid: number[]; returned: number };
export type BookingInvoice = { id: string; number: string; kind: InvoiceKind; fee_type: FeeType | null; status: InvoiceStatus; total: number; paid: number; balance: number };
export type PaymentState = 'none' | 'invoiced' | 'partial' | 'paid';

/**
 * The booking's invoice (`acctBookingInvoice`): its live booking or prepay invoice, else its newest
 * live fee invoice (a cancelled booking's cancellation fee). `payment_state` counts every live
 * invoice, a reschedule fee's too: `paid` once all are paid, `partial` once anything is. It replaces
 * legacy's stored `paymentStatus`, a copy that went wrong whenever a fee invoice was involved.
 */
export function bookingInvoice(briefs: readonly InvoiceBrief[]): { invoice: BookingInvoice | null; payment_state: PaymentState } {
  const live = briefs.filter((b) => !b.voided).sort((a, b) => (a.issued_at === b.issued_at ? (a.id < b.id ? -1 : 1) : a.issued_at < b.issued_at ? -1 : 1));
  if (!live.length) return { invoice: null, payment_state: 'none' };
  const states = live.map((b) => ({ b, paid: sum(b.paid), ...invoiceState({ voided: false, total: b.total }, cents(sum(b.paid) - b.returned)) }));
  const main = [...states].reverse().find((s) => s.b.kind !== 'fee') ?? states[states.length - 1];
  return {
    invoice: { id: main.b.id, number: main.b.number, kind: main.b.kind, fee_type: main.b.fee_type, status: main.status, total: main.b.total, paid: main.paid, balance: main.balance },
    payment_state: states.every((s) => s.status === 'paid') ? 'paid' : states.some((s) => s.paid - s.b.returned > 0) ? 'partial' : 'invoiced',
  };
}

/** The booking fields a booking `PATCH` may echo but never change: the server works them out. */
const COMPUTED_ON_BOOKING = ['invoice', 'invoice_id', 'invoiceId', 'payment_state', 'paymentStatus'] as const;
export function assertPaymentEcho(body: Record<string, unknown>, stored: { invoice: BookingInvoice | null; payment_state: PaymentState }): void {
  for (const key of COMPUTED_ON_BOOKING) {
    const sent = body[key];
    if (sent === undefined) continue;
    const empty = sent === null || sent === '';
    const same = key === 'invoice' ? JSON.stringify(sent) === JSON.stringify(stored.invoice)
      : key === 'invoice_id' || key === 'invoiceId' ? (empty ? stored.invoice === null : sent === stored.invoice?.id)
      : (empty ? stored.payment_state === 'none' : sent === stored.payment_state || (stored.payment_state === 'none' && sent === 'unpaid'));
    if (!same) badRequest(`${key} cannot be changed here: the server works it out from the booking's invoice and payments (POST /v1/invoices, POST /v1/invoices/{id}/payments)`);
  }
}

// ── Credit ───────────────────────────────────────────────────────────────────────────────────────

const RELEASED: readonly BookingStatus[] = ['cancelled', 'rejected', 'cancelled_weather'];
export type Credit = { limit: number; used: number; available: number; pct: number; over: boolean };

/**
 * `agCreditState`: what an `invoice` agent owes on its committed bookings not yet paid (a booking is
 * paid when its live invoice owes nothing). Over the limit is a warning only, as in legacy.
 */
export function creditOf(agent: Pick<Agent, 'pay_type' | 'credit_limit'>,
  bookings: readonly { status: BookingStatus; total?: number; fee_items: readonly { amount: number }[]; invoice: BookingInvoice | null }[]): Credit {
  const limit = agent.credit_limit ?? 0;
  const used = agent.pay_type !== 'invoice' ? 0 : sum(bookings
    .filter((b) => !RELEASED.includes(b.status) && b.status !== 'quote' && b.status !== 'draft' && !(b.invoice && b.invoice.balance <= 0))
    .map((b) => amountOwed(b)));
  return { limit, used, available: cents(limit - used), pct: limit > 0 ? Math.round((used / limit) * 100) : 0, over: limit > 0 && used > limit };
}

// ── Issuing ──────────────────────────────────────────────────────────────────────────────────────

/** `INV-YYMM-NNNN` for the month the invoice is issued in, Bangkok time (`acctNextInvoiceNo`). */
export const invoiceMonth = (now: Date): string => todayInThailand(now).slice(2, 7).replace('-', '');
export const invoiceNumber = (month: string, n: number): string => `INV-${month}-${String(n).padStart(4, '0')}`;

/**
 * Days to pay (`acctNewInvoiceCreate`): the agent's credit days, else 30 for an `invoice` agent. A
 * proforma or a prepay invoice is due when issued, as the Daily PFM screen issues them.
 */
export function dueDays(agent: Pick<Agent, 'pay_type' | 'credit_days'> | undefined, kind: InvoiceKind): number {
  if (kind !== 'booking' || !agent || agent.pay_type === 'proforma') return 0;
  return agent.credit_days || (agent.pay_type === 'invoice' ? 30 : 0);
}
const plusDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

type Header = Partial<Record<HeaderField, string | null>>;
export type NewInvoiceRequest = { agent_id: string; booking_ids: string[]; kind: 'booking' | 'prepay'; header: Header };

const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return badRequest(`${name} must be a string`);
  return value.trim() === '' ? null : value.trim();
};
const isoDay = (value: unknown, name: string): string | null => {
  const t = text(value, name);
  if (t === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)) && new Date(`${t}T00:00:00Z`).toISOString().startsWith(t) ? t : badRequest(`${name} must be a YYYY-MM-DD date`);
};
function parseHeader(body: Record<string, unknown>): Header {
  const out: Header = {};
  for (const field of HEADER_FIELDS) {
    const raw = body[field] ?? (field === 'accept_at' ? body.acceptAt : undefined);
    if (raw !== undefined) out[field] = field === 'accept_at' ? isoDay(raw, field) : text(raw, field);
  }
  return out;
}

export function parseNewInvoice(body: Record<string, unknown>): NewInvoiceRequest {
  const agent_id = typeof (body.agent_id ?? body.agentId) === 'string' && (body.agent_id ?? body.agentId) ? String(body.agent_id ?? body.agentId) : badRequest('agent_id is required');
  const raw = body.booking_ids ?? body.bookingIds;
  if (!Array.isArray(raw) || raw.length === 0) badRequest('booking_ids must list at least one booking');
  const ids = (raw as unknown[]).map((id, i) => (typeof id === 'string' && id ? id : badRequest(`booking_ids[${i}] must be a booking id`)));
  if (new Set(ids).size !== ids.length) badRequest('booking_ids names a booking twice');
  const kind = body.kind ?? 'booking';
  if (kind !== 'booking' && kind !== 'prepay') badRequest('kind must be booking or prepay; a fee invoice is issued by /cancel');
  if (kind === 'prepay' && ids.length !== 1) badRequest('A prepay invoice is for one booking');
  return { agent_id, booking_ids: ids, kind: kind as 'booking' | 'prepay', header: parseHeader(body) };
}

export type IssuableBooking = {
  id: string; agent_id?: string; status: BookingStatus; voucher_ref?: string; route_id: string; service_date: string;
  total?: number; fee_items: readonly { label: string | null; amount: number }[]; invoice: BookingInvoice | null;
};

/**
 * Who may be invoiced (`acctNewInvoiceRender`): the agent's own bookings, not cancelled, with no
 * live invoice. One line per booking at today's price, then one per fee item (`acctDocLineItems`).
 */
export function invoiceLines(agentId: string, bookings: readonly IssuableBooking[], routeName: (id: string) => string | undefined): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  for (const b of bookings) {
    if (b.agent_id !== agentId) refuse(`Booking ${b.id} is not agent ${agentId}'s`, 400, 'booking_not_agents');
    if (RELEASED.includes(b.status)) refuse(`Booking ${b.id} is ${b.status}`, 409, 'booking_cancelled');
    if (b.invoice) refuse(`Booking ${b.id} is already on invoice ${b.invoice.number}`, 409, 'booking_already_invoiced');
    lines.push({ seq: lines.length, booking_id: b.id, label: [b.voucher_ref ?? b.id, routeName(b.route_id) ?? b.route_id, b.service_date].filter(Boolean).join(' · '), amount: b.total ?? 0, discount: null, ...NOT_REMOVED });
    for (const f of b.fee_items) lines.push({ seq: lines.length, booking_id: b.id, label: f.label || 'Fee', amount: f.amount, discount: null, ...NOT_REMOVED });
  }
  return lines;
}

export function issueInvoice(input: {
  id: string; number: string; request: NewInvoiceRequest; agent: Pick<Agent, 'pay_type' | 'credit_days' | 'vat_mode'>; lines: InvoiceLine[]; now: string; by: string | null;
}): StoredInvoice {
  const vatMode = input.agent.vat_mode ?? 'none';
  return {
    id: input.id, number: input.number, agent_id: input.request.agent_id, kind: input.request.kind, fee_type: null,
    vat_mode: vatMode, vat_rate: VAT_RATE, ...invoiceAmounts(input.lines, vatMode, VAT_RATE), wht_amount: null,
    issued_at: input.now, due_at: plusDays(input.now, dueDays(input.agent, input.request.kind)),
    note: null, ref: null, dear: null, accept_at: null, remark: null, ...input.request.header,
    voided: false, voided_at: null, voided_by: null, void_reason: null, created_by: input.by, lines: input.lines,
  };
}

/** `acctCreateFeeInvoice`: one line, no VAT, due now, whole baht. Nothing to issue for a charge of 0. */
export function feeInvoice(input: { id: string; number: string; agent_id: string; booking_id: string; fee_type: FeeType; label: string; amount: number; now: string; by: string | null }): StoredInvoice | undefined {
  const amount = Math.max(0, Math.round(input.amount));
  if (amount <= 0) return undefined;
  return {
    id: input.id, number: input.number, agent_id: input.agent_id, kind: 'fee', fee_type: input.fee_type, vat_mode: 'none', vat_rate: 0,
    subtotal: amount, net_amount: amount, vat_amount: 0, total: amount, wht_amount: null, issued_at: input.now, due_at: input.now,
    note: input.label, ref: null, dear: null, accept_at: null, remark: null,
    voided: false, voided_at: null, voided_by: null, void_reason: null, created_by: input.by,
    lines: [{ seq: 0, booking_id: input.booking_id, label: input.label, amount, discount: null, ...NOT_REMOVED }],
  };
}

export const issuedLine = (by: string | null, inv: StoredInvoice): HistoryLine =>
  ({ by, kind: 'invoice', tag: 'Invoice', text: `Invoice ${inv.number} issued · ${baht(inv.total)}${(inv.vat_amount ?? 0) > 0 ? ' (incl. VAT)' : ''}` });

// ── Changing an invoice ──────────────────────────────────────────────────────────────────────────

/** What `PATCH` may change: the header text and the withholding tax. Anything the server works out is refused. */
const OWNED: Record<string, string> = {
  number: 'it is numbered by the server', agent_id: 'void the invoice and issue another', agentId: 'void the invoice and issue another',
  kind: 'void the invoice and issue another', fee_type: 'it is set by /cancel', booking_ids: 'void the invoice and issue another', bookingIds: 'void the invoice and issue another',
  lines: 'use PUT /v1/invoices/{id}/discounts for a discount', subtotal: 'it is worked out from the lines', net_amount: 'it is worked out from the lines',
  vat_amount: 'it is worked out from the lines', total: 'it is worked out from the lines', vat_mode: 'it is the agent\'s, copied at issue', vat_rate: 'it is the agent\'s, copied at issue',
  status: 'use POST /v1/invoices/{id}/void, or record a payment', paid: 'record a payment', balance: 'record a payment', payment_amount: 'it is the total less WHT',
  payments: 'use POST /v1/invoices/{id}/payments or /payment-corrections', refunded: 'a weather cancel records it (POST /v1/bookings/{id}/cancel-weather)',
  credited: 'a weather cancel records it (POST /v1/bookings/{id}/cancel-weather)', refunds: 'a weather cancel records them (POST /v1/bookings/{id}/cancel-weather)', issued_at: 'it is the time the invoice was issued', due_at: 'it follows from the agent\'s credit days',
  voided: 'use POST /v1/invoices/{id}/void', voided_at: 'use POST /v1/invoices/{id}/void', voided_by: 'use POST /v1/invoices/{id}/void', void_reason: 'use POST /v1/invoices/{id}/void',
  created_by: 'it is the user who issued the invoice',
};
const echoes = (sent: unknown, stored: unknown): boolean =>
  (sent === null || sent === undefined) && (stored === null || stored === undefined) ? true
    : typeof stored === 'number' && typeof sent === 'number' ? Math.abs(sent - stored) < 0.005
      : typeof stored === 'object' ? JSON.stringify(sent) === JSON.stringify(stored) : String(sent) === String(stored);

export type InvoicePatch = Header & { wht_amount?: number | null };
export function parseInvoicePatch(body: Record<string, unknown>, current: InvoiceView): InvoicePatch {
  for (const [key, why] of Object.entries(OWNED)) {
    if (body[key] !== undefined && !echoes(body[key], (current as unknown as Record<string, unknown>)[key])) badRequest(`${key} cannot be changed: ${why}`);
  }
  const patch: InvoicePatch = parseHeader(body);
  const wht = body.wht_amount ?? body.whtAmount;
  if (wht !== undefined) {
    if (wht !== null && !(typeof wht === 'number' && Number.isFinite(wht) && wht >= 0)) badRequest('wht_amount must be a number, 0 or more');
    patch.wht_amount = wht === null || wht === 0 ? null : cents(wht as number);
  }
  return patch;
}

/**
 * `acctInvDisc`: a discount per line, once nothing is paid ("void and re-issue" otherwise). Lines not
 * named keep theirs; 0 or null clears one.
 */
export function withDiscounts(invoice: StoredInvoice, payments: readonly StoredPayment[], body: Record<string, unknown>): StoredInvoice {
  if (invoice.voided) refuse(`Invoice ${invoice.number} is void`, 409, 'invoice_void');
  if (paidOf(payments) > 0) refuse(`Invoice ${invoice.number} has a payment: void it and issue another to change a discount`, 409, 'invoice_has_payments');
  if (!(sum(invoice.lines.map((l) => l.amount)) > 0)) refuse(`Invoice ${invoice.number} has no amount to discount`, 409, 'invoice_no_amount');
  const raw = body.lines;
  if (!Array.isArray(raw) || raw.length === 0) badRequest('lines must list at least one { seq, discount }');
  const next = new Map(invoice.lines.map((l) => [l.seq, { ...l }]));
  (raw as unknown[]).forEach((item, i) => {
    const r = item !== null && typeof item === 'object' ? item as Record<string, unknown> : badRequest(`lines[${i}] must be an object`);
    const line = next.get(r.seq as number) ?? badRequest(`lines[${i}].seq must be one of the invoice's lines (${invoice.lines.map((l) => l.seq).join(', ')})`);
    const d = r.discount;
    if (d !== null && !(typeof d === 'number' && Number.isFinite(d) && d >= 0)) badRequest(`lines[${i}].discount must be a number, 0 or more`);
    line.discount = d === null || d === 0 ? null : cents(d as number);
  });
  const lines = [...next.values()].sort((a, b) => a.seq - b.seq);
  return { ...invoice, lines, ...invoiceAmounts(lines, invoice.vat_mode, invoice.vat_rate) };
}

/** `acctVoidInvoice`: allowed with payments, which stay on it (decided 2026-10-09). */
export function voided(invoice: StoredInvoice, reason: string | null, now: string, by: string | null): StoredInvoice {
  if (invoice.voided) refuse(`Invoice ${invoice.number} is already void`, 409, 'invoice_void');
  return { ...invoice, voided: true, voided_at: now, voided_by: by, void_reason: reason };
}
export const voidedLine = (by: string | null, inv: StoredInvoice, reason: string | null): HistoryLine =>
  ({ by, kind: 'invoice', tag: 'Invoice', text: `Invoice ${inv.number} voided${reason ? ` · reason: ${reason}` : ''}` });
export const parseVoid = (body: Record<string, unknown>): { reason: string | null } => ({ reason: text(body.reason, 'reason') });

// ── Payments ─────────────────────────────────────────────────────────────────────────────────────

const amountOf = (value: unknown, name: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? cents(value) : badRequest(`${name} must be more than 0`);
const methodOf = (value: unknown, name: string): PaymentMethod =>
  (PAYMENT_METHODS as readonly unknown[]).includes(value) ? value as PaymentMethod : badRequest(`${name} must be one of ${PAYMENT_METHODS.join(', ')}`);
const flag = (value: unknown, name: string): boolean => {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return badRequest(`${name} must be true or false`);
};
const slipIds = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return badRequest('slip_ids must be a list of attachment ids');
  return value.map((id, i) => (typeof id === 'string' && id ? id : badRequest(`slip_ids[${i}] must be an attachment id`)));
};

export type NewPayment = { amount: number; method: PaymentMethod; paid_on: string; ref: string | null; slips: string[]; overpay_anyway: boolean };
export function parsePayment(body: Record<string, unknown>, now: Date): NewPayment {
  return {
    amount: amountOf(body.amount, 'amount'), method: methodOf(body.method ?? 'transfer', 'method'),
    paid_on: isoDay(body.paid_on ?? body.date, 'paid_on') ?? todayInThailand(now), ref: text(body.ref, 'ref'),
    slips: slipIds(body.slip_ids ?? body.slips), overpay_anyway: flag(body.overpay_anyway, 'overpay_anyway'),
  };
}

const assertNotOverpaid = (invoice: StoredInvoice, paid: number, anyway: boolean): void => {
  if (!anyway && paid > invoice.total + 0.005) {
    refuse(`Total received ${baht(paid)} is more than invoice ${invoice.number}'s ${baht(invoice.total)} by ${baht(paid - invoice.total)}: send overpay_anyway to save anyway`, 409, 'overpayment');
  }
};

/**
 * `acctRecordPayment`: on a live invoice; more than it owes needs `overpay_anyway` (legacy's "Save
 * anyway?"). `returned` is what refunds and credits took back from it, so it no longer counts as paid.
 * A `credit` payment is checked against the agent's balance by the caller (`assertCreditCovers`).
 */
export function recordPayment(invoice: StoredInvoice, payments: readonly StoredPayment[], p: NewPayment, id: string, now: string, by: string | null, returned = 0):
  { payment: StoredPayment; history: HistoryLine } {
  if (invoice.voided) refuse(`Invoice ${invoice.number} is void: record the payment on its live invoice`, 409, 'invoice_void');
  const paid = cents(paidOf(payments) - returned + p.amount);
  assertNotOverpaid(invoice, paid, p.overpay_anyway);
  const full = invoiceState(invoice, paid).status === 'paid';
  return {
    payment: { id, invoice_id: invoice.id, amount: p.amount, method: p.method, paid_on: p.paid_on, ref: p.ref, recorded_by: by, recorded_at: now,
      deleted_at: null, deleted_by: null, delete_reason: null, slips: p.slips },
    history: { by, kind: 'payment', tag: 'Payment', text: `Payment ${baht(p.amount)} (${p.method})${full ? ' · paid in full' : ' · partial'}` },
  };
}

/**
 * `pfmEditSubmit`: several payments changed or deleted at once, with one reason and one history line.
 * A deleted payment stays on record (decided 2026-10-09). Nothing changed is not a write.
 */
export function correctPayments(invoice: StoredInvoice, payments: readonly StoredPayment[], body: Record<string, unknown>, now: string, by: string | null, returned = 0):
  { changed: StoredPayment[]; history?: HistoryLine } {
  const raw = body.payments;
  if (!Array.isArray(raw) || raw.length === 0) badRequest('payments must list at least one { id, … }');
  const byId = new Map(payments.map((p) => [p.id, p]));
  const reason = text(body.reason, 'reason');
  const thb = (n: number) => `THB ${Math.round(n).toLocaleString('en-US')}`;
  const changed: StoredPayment[] = [];
  const log: string[] = [];
  const seen = new Set<string>();
  (raw as unknown[]).forEach((item, i) => {
    const r = item !== null && typeof item === 'object' ? item as Record<string, unknown> : badRequest(`payments[${i}] must be an object`);
    const p = byId.get(r.id as string) ?? badRequest(`payments[${i}].id must be one of invoice ${invoice.number}'s payments`);
    if (seen.has(p.id)) badRequest(`payments[${i}] names payment ${p.id} twice`);
    seen.add(p.id);
    if (p.deleted_at) refuse(`Payment ${p.id} is deleted`, 409, 'payment_deleted');
    if (flag(r.deleted ?? r.delete, `payments[${i}].deleted`)) {
      changed.push({ ...p, deleted_at: now, deleted_by: by, delete_reason: reason });
      log.push(`deleted ${thb(p.amount)} (${p.method}, ${p.paid_on})`);
      return;
    }
    const amount = r.amount === undefined ? p.amount : amountOf(r.amount, `payments[${i}].amount`);
    const method = r.method === undefined ? p.method : methodOf(r.method, `payments[${i}].method`);
    // The balance a credit payment spent was checked when it was recorded: deleting it gives it back, editing it would skip the check.
    if ((p.method === 'credit' || method === 'credit') && (amount !== p.amount || method !== p.method)) {
      refuse(`Payment ${p.id}: a credit payment cannot be edited, and a payment cannot become one: delete it and record it again`, 409, 'credit_payment');
    }
    const paidOn = r.paid_on === undefined && r.date === undefined ? p.paid_on : isoDay(r.paid_on ?? r.date, `payments[${i}].paid_on`) ?? p.paid_on;
    const ch: string[] = [];
    if (amount !== p.amount) ch.push(`${thb(p.amount)} -> ${thb(amount)}`);
    if (method !== p.method) ch.push(`${p.method} -> ${method}`);
    if (paidOn !== p.paid_on) ch.push(`${p.paid_on} -> ${paidOn}`);
    if (ch.length) { changed.push({ ...p, amount, method, paid_on: paidOn }); log.push(`edited ${ch.join(', ')}`); }
  });
  if (!changed.length) return { changed };
  const after = payments.map((p) => changed.find((c) => c.id === p.id) ?? p);
  if (!invoice.voided) assertNotOverpaid(invoice, cents(paidOf(after) - returned), flag(body.overpay_anyway, 'overpay_anyway'));
  return { changed, history: { by, kind: 'payment', tag: 'Payment', text: `Payment correction · ${log.join(' · ')}${reason ? ` · reason: ${reason}` : ''}` } };
}

// ── Lists ────────────────────────────────────────────────────────────────────────────────────────

/** The day an instant falls on in Bangkok, the day legacy's screens show. */
export const bangkokDay = (iso: string): string => todayInThailand(new Date(iso));
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['issued', 'partial', 'paid', 'void'];
export type InvoiceListQuery = { agent_id?: string; booking_id?: string; status?: InvoiceStatus[]; from?: string; to?: string };
export function parseInvoiceListQuery(query: Record<string, unknown>): InvoiceListQuery {
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const status = str(query.status)?.split(',').map((s) => ((INVOICE_STATUSES as readonly string[]).includes(s) ? s as InvoiceStatus : badRequest(`status must be one or more of ${INVOICE_STATUSES.join(', ')}`)));
  const from = isoDay(query.from, 'from') ?? undefined, to = isoDay(query.to, 'to') ?? undefined;
  return { agent_id: str(query.agent_id), booking_id: str(query.booking_id), ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) };
}
