/**
 * Deposits into an agent's credit and refund payouts (todo/money-model.md, "Design: the rest of
 * Money", decided 2026-10-10). The rules are in `src/domain/credit.ts`; the balance is `creditBalance`
 * (`refunds.ts`), which every `credit` payment spends. Who may write is `writeNeed`'s (accounting).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import { actorOf, refuse } from '../domain/booking-actions.js';
import { assertKnownFiles, type AttachmentRef } from '../domain/attachments.js';
import { creditBalance, type CreditBalance } from '../domain/refunds.js';
import { depositView, parseDeposit, payoutView, planPayout, voidDeposit, type StoredDeposit } from '../domain/credit.js';

type Request = FastifyRequest;
const bad = (message: string): never => refuse(message, 400);
const notFound = (message: string): never => refuse(message, 404);
const params = (request: Request): Record<string, string> => (request.params ?? {}) as Record<string, string>;
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;

/** An agent's credit balance: weather credits and live deposits, less its live `credit` payments. */
export async function agentCreditOf(store: Store, agentId: string): Promise<CreditBalance> {
  const invoices = await store.listInvoices({ agentId });
  return creditBalance(await store.listRefunds({ agentId }), await store.paymentsOf(invoices.map((i) => i.id)), await store.moneyRepo.deposits({ agentId }));
}

export function registerCreditRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const repo = () => store.moneyRepo;
  const by = (request: Request): string | null => actorOf(request.user) ?? null;
  const own = (request: Request): string | null => request.user?.user?.agent_id ?? null;
  const files = async (ids: readonly string[]): Promise<Map<string, AttachmentRef>> => (ids.length ? store.attachmentRefs([...new Set(ids)]) : new Map());
  const assertSlips = async (ids: readonly string[]) => { if (ids.length) assertKnownFiles(ids, new Set((await files(ids)).keys()), 'slip_ids'); };
  const view = async (d: StoredDeposit) => ({ ...depositView(d, await files(d.slips)), credit_balance: await agentCreditOf(store, d.agent_id) });
  /** A login tied to an agent sees its own deposits; another's is not found. */
  const depositOf = async (request: Request): Promise<StoredDeposit> => {
    const d = await repo().deposit(params(request).id);
    if (!d || (own(request) && own(request) !== d.agent_id)) notFound('Deposit not found');
    return d!;
  };

  // ── Deposits (legacy "รับมัดจำ", `acctCreateDeposit`) ──
  app.get('/v1/deposits', async (request) => {
    const q = query(request);
    const agentId = own(request) ?? (typeof q.agent_id === 'string' && q.agent_id ? q.agent_id : undefined);
    const withVoid = q.include_voided === 'true' || q.include_voided === true;
    const list = (await repo().deposits({ agentId })).filter((d) => withVoid || !d.voided_at);
    const refs = await files(list.flatMap((d) => d.slips));
    return { deposits: list.map((d) => depositView(d, refs)) };
  });
  app.get('/v1/deposits/:id', async (request) => view(await depositOf(request)));
  app.post('/v1/deposits', async (request, reply) => {
    const input = parseDeposit(request.body, new Date());
    const id = `dep_${randomUUID()}`;
    await store.transaction(async () => {
      if (!(await store.agentRecord(input.agent_id))) bad(`agent_id ${input.agent_id} is not an agent`);
      await assertSlips(input.slips);
      await repo().putDeposit({ ...input, id, recorded_by: by(request), recorded_at: new Date().toISOString(), voided_at: null, voided_by: null, void_reason: null });
    });
    reply.code(201);
    return view((await repo().deposit(id))!);
  });
  app.post('/v1/deposits/:id/void', async (request) => {
    const id = params(request).id;
    await store.transaction(async () => {
      const d = (await repo().deposit(id)) ?? notFound('Deposit not found');
      const balance = await agentCreditOf(store, d.agent_id);
      await repo().putDeposit(voidDeposit(d, request.body, balance.available, new Date().toISOString(), by(request)));
    });
    return view((await repo().deposit(id))!);
  });

  // ── Refund payouts ──
  const refundOf = async (id: string) => (await store.listRefunds()).find((r) => r.id === id) ?? notFound(`Refund ${id} not found`);
  const refundView = async (id: string) => {
    const r = await refundOf(id);
    const [p] = await repo().payouts([id]);
    return { ...r, invoice_number: (await store.invoice(r.invoice_id))?.number ?? r.invoice_id, payout: payoutView(p, await files(p?.slips ?? [])) };
  };
  app.post('/v1/refunds/:id/payout', async (request) => {
    const id = params(request).id;
    await store.transaction(async () => {
      const r = await refundOf(id);
      const [existing] = await repo().payouts([id]);
      const p = planPayout(r, existing, request.body, new Date(), by(request));
      await assertSlips(p.slips);
      await repo().putPayout(p);
    });
    return refundView(id);
  });
  app.delete('/v1/refunds/:id/payout', async (request) => {
    const id = params(request).id;
    await store.transaction(async () => {
      await refundOf(id);
      if (!(await repo().deletePayout(id))) refuse(`Refund ${id} is not paid out`, 409, 'refund_not_paid_out');
    });
    return refundView(id);
  });
}
