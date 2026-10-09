/**
 * An agent's money held with us (todo/money-model.md, "Design: the rest of Money", decided
 * 2026-10-10): deposits and refund payouts. Legacy `acctCreateDeposit`, `acctApplyDeposit`,
 * `acctDepositRemaining`, `acctAgentDepositAvail`, `acctDepositHeldTotal`.
 *
 * - A **deposit** is money an agent paid with no invoice ("รับมัดจำ"). It adds to the agent's credit
 *   balance, the same one weather credits fill (`refunds.ts`), and is spent as a payment with method
 *   `credit`. Legacy tracked which deposit each payment used; the balance is one pool here, so a
 *   deposit has no "remaining" of its own. A deposit is voided (with a reason), never deleted, and
 *   not while the balance would go below 0.
 * - A **refund payout** records that a refund owed to an agent was paid (how, when, the slip). Legacy
 *   had no such step. A credit is never paid out: it is spent.
 *
 * Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { todayInThailand } from './calendar.js';
import { assertKnown, isoDate, record, round2, text } from './fleet-common.js';
import type { AttachmentRef } from './attachments.js';
import type { StoredRefund } from './invoices.js';

const bad = (message: string): never => refuse(message, 400);

export const DEPOSIT_METHODS = ['transfer', 'cash', 'card'] as const;
export type DepositMethod = typeof DEPOSIT_METHODS[number];
export type StoredDeposit = {
  id: string; agent_id: string; amount: number; method: DepositMethod; received_on: string; ref: string | null; note: string | null;
  recorded_by: string | null; recorded_at: string; voided_at: string | null; voided_by: string | null; void_reason: string | null;
  /** Slip attachment ids, in order. */
  slips: string[];
};
export const PAYOUT_METHODS = ['transfer', 'cash', 'cheque'] as const;
export type PayoutMethod = typeof PAYOUT_METHODS[number];
export type RefundPayout = { refund_id: string; paid_on: string; method: PayoutMethod; ref: string | null; paid_out_by: string | null; recorded_at: string; slips: string[] };

const slipIds = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return bad('slip_ids must be a list of attachment ids');
  return value.map((id, i) => (typeof id === 'string' && id ? id : bad(`slip_ids[${i}] must be an attachment id`)));
};
const amountOf = (v: unknown): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? round2(n) : bad('amount must be more than 0');
};

// ── Deposits ─────────────────────────────────────────────────────────────────────────────────────

/** `POST /v1/deposits` (legacy `acctDepositSubmit`: an agent and an amount are required). */
export function parseDeposit(raw: unknown, now: Date): Pick<StoredDeposit, 'agent_id' | 'amount' | 'method' | 'received_on' | 'ref' | 'note' | 'slips'> {
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [({ agentId: 'agent_id', date: 'received_on', slips: 'slip_ids' } as Record<string, string>)[k] ?? k, v]));
  for (const k of ['id', 'recorded_by', 'recorded_at', 'voided_at', 'voided_by', 'void_reason']) if (b[k] !== undefined) bad(`${k} is the server's`);
  assertKnown(b, ['agent_id', 'amount', 'method', 'received_on', 'ref', 'note', 'slip_ids'], 'A deposit');
  const agent = text(b.agent_id, 'agent_id') ?? bad('agent_id is required (เลือก agent)');
  const method = b.method === undefined || b.method === null || b.method === '' ? 'transfer'
    : (DEPOSIT_METHODS as readonly unknown[]).includes(b.method) ? b.method as DepositMethod : bad(`method must be one of ${DEPOSIT_METHODS.join(', ')}`);
  return {
    agent_id: agent, amount: amountOf(b.amount), method, received_on: isoDate(b.received_on, 'received_on') ?? todayInThailand(now),
    ref: text(b.ref, 'ref'), note: text(b.note, 'note'), slips: slipIds(b.slip_ids),
  };
}
/** `POST /v1/deposits/{id}/void`: a reason; not twice; not when it would leave the balance below 0. */
export function voidDeposit(d: StoredDeposit, raw: unknown, available: number, now: string, by: string | null): StoredDeposit {
  const b = record(raw ?? {});
  assertKnown(b, ['reason'], 'A void');
  const reason = text(b.reason, 'reason') ?? bad('reason is required');
  if (d.voided_at) refuse(`Deposit ${d.id} is already void`, 409, 'deposit_void');
  if (d.amount > available + 0.005) {
    refuse(`Agent ${d.agent_id} has ฿${available.toLocaleString('en-US')} of credit left; voiding this ฿${d.amount.toLocaleString('en-US')} deposit would take it below 0: delete or correct the credit payments first`, 409, 'deposit_spent');
  }
  return { ...d, slips: [...d.slips], voided_at: now, voided_by: by, void_reason: reason };
}
export const depositView = (d: StoredDeposit, files: ReadonlyMap<string, AttachmentRef>) => ({
  ...d, status: d.voided_at ? 'void' : 'live', slips: d.slips.map((id) => files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 }),
});
export const liveDeposits = <T extends Pick<StoredDeposit, 'voided_at'>>(ds: readonly T[]): T[] => ds.filter((d) => !d.voided_at);

// ── Refund payouts ───────────────────────────────────────────────────────────────────────────────

/** `POST /v1/refunds/{id}/payout`: a refund owed to the agent, paid once. */
export function planPayout(refund: StoredRefund, existing: RefundPayout | undefined, raw: unknown, now: Date, by: string | null): RefundPayout {
  const b = Object.fromEntries(Object.entries(record(raw ?? {})).map(([k, v]) => [({ date: 'paid_on', slips: 'slip_ids' } as Record<string, string>)[k] ?? k, v]));
  for (const k of ['paid_out_by', 'recorded_at']) if (b[k] !== undefined) bad(`${k} is the server's`);
  assertKnown(b, ['paid_on', 'method', 'ref', 'slip_ids'], 'A refund payout');
  if (refund.kind !== 'refund') refuse(`${refund.id} is the agent's credit, spent as a payment: it is not paid out`, 409, 'not_a_refund');
  if (existing) refuse(`Refund ${refund.id} was paid out on ${existing.paid_on}${existing.paid_out_by ? ` by ${existing.paid_out_by}` : ''}: undo it first (DELETE …/payout)`, 409, 'refund_paid_out');
  const method = (PAYOUT_METHODS as readonly unknown[]).includes(b.method) ? b.method as PayoutMethod : bad(`method must be one of ${PAYOUT_METHODS.join(', ')}`);
  return { refund_id: refund.id, paid_on: isoDate(b.paid_on, 'paid_on') ?? todayInThailand(now), method, ref: text(b.ref, 'ref'), paid_out_by: by, recorded_at: now.toISOString(), slips: slipIds(b.slip_ids) };
}
export const payoutView = (p: RefundPayout | undefined, files: ReadonlyMap<string, AttachmentRef>) =>
  p ? { ...p, slips: p.slips.map((id) => files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 }) } : null;
/** Refunds owed and not paid out yet, oldest first: the accounting dashboard's list. */
export function refundsToPay(refunds: readonly StoredRefund[], payouts: ReadonlyMap<string, RefundPayout>, names: ReadonlyMap<string, string>, numbers: ReadonlyMap<string, string>) {
  const items = refunds.filter((r) => r.kind === 'refund' && !payouts.has(r.id)).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    .map((r) => ({ id: r.id, agent_id: r.agent_id, name: r.agent_id ? names.get(r.agent_id) ?? null : null, invoice_id: r.invoice_id, invoice_number: numbers.get(r.invoice_id) ?? r.invoice_id,
      booking_id: r.booking_id, amount: r.amount, reason: r.reason, created_at: r.created_at }));
  return { count: items.length, amount: round2(items.reduce((s, r) => s + r.amount, 0)), items };
}
