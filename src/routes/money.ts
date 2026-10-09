/**
 * Money slices 2–4 (todo/money-model.md, decided 2026-10-09): proforma (Daily PFM), pier money (pier
 * payments, on-tour sales, the amount owed at the pier, the hand-over at day close, commission
 * payouts) and the decisions after the trip (cash on tour, no-show charges).
 *
 * The rules are in `src/domain/` (`pfm.ts`, `pier-money.ts`, `after-trip.ts`). A handler reads what a
 * rule needs from the store, asks it, and writes what it answers, all in one transaction. Who may
 * write is the `preHandler` hook's (`writeNeed` in `users.ts`). A command on a booking needs the
 * version the caller read (`If-Match`) and moves it on, as every booking command does.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import type { Booking } from '../domain/operations.js';
import { actorOf, refuse } from '../domain/booking-actions.js';
import { holdsSeats } from '../domain/booking-status.js';
import { todayInThailand } from '../domain/calendar.js';
import { assertKnownFiles, type AttachmentRef } from '../domain/attachments.js';
import { invoiceView, type InvoiceView, type StoredInvoice } from '../domain/invoices.js';
import { approverOf, pfmKind, pfmRow, pfmTotals, planDecision, remindedLine, toRemind, type PfmAgent, type PfmRow } from '../domain/pfm.js';
import {
  acceptHandover, assertLive, assertOnTrip, collectTourSale, commissionItems, dayOf, deletePierPayment, handoverView, noteOf, parseHandover, parsePayout, parsePierPayment,
  parseRange, parseTourSale, pierMoney, pierOf, pierPaymentView, planHandover, planPayout, planTourSale, recordPierPayments, slipIdsOf, takings, tourSaleView, voidHandover,
  voidPayout, type CommissionItem, type MoneyBooking, type StoredHandover, type StoredPierPayment, type StoredTourSale,
} from '../domain/pier-money.js';
import {
  cotAmount, cotDecisionView, cotDeductions, cotInvoiceLine, planCotDecision, planNoshowCharge, suggestedCotMode, syncCotLines, tripAmount, type StoredCotDecision,
} from '../domain/after-trip.js';
import { collectUpgrade, upgradeStored } from '../domain/upgrades.js';

type Request = FastifyRequest;
const fail = (message: string, statusCode: number, code?: string): never => refuse(message, statusCode, code);
const notFound = (message: string): never => fail(message, 404);
const bad = (message: string): never => fail(message, 400);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('Request body must be an object'));
const param = (request: Request, name = 'id'): string => (request.params as Record<string, string>)[name];
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const nowIso = (): string => new Date().toISOString();
const MAX_RANGE_DAYS = 400;
const days = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;

export function registerMoneyRoutes(app: FastifyInstance, deps: {
  store: Store;
  /** The booking write guard (`If-Match`), as every booking write uses it. */
  assertBookingFresh: (request: Request) => Promise<void>;
}): void {
  const { store, assertBookingFresh } = deps;
  const by = (request: Request): string | null => actorOf(request.user) ?? null;
  /** A login tied to one agent (Love Kingdom's) sees its own bookings only. */
  const agentOf = (request: Request): string | null => request.user?.user?.agent_id ?? null;
  const notForAgents = (request: Request): void => { if (agentOf(request)) fail('This login books for its agent and sees nothing of the pier\'s money', 403, 'forbidden'); };
  const bookingOf = async (request: Request): Promise<Booking> => (await store.booking(param(request))) ?? notFound('Booking not found');
  const files = async (ids: readonly string[]): Promise<Map<string, AttachmentRef>> => (ids.length ? store.attachmentRefs([...new Set(ids)]) : new Map());
  const assertSlips = async (ids: readonly string[], label = 'slip_ids'): Promise<void> => {
    if (ids.length) assertKnownFiles(ids, new Set((await store.attachmentRefs([...new Set(ids)])).keys()), label);
  };
  /** Every booking with a trip in the range, page by page. */
  const bookingsBetween = async (from: string, to: string, agentId?: string | null): Promise<Booking[]> => {
    const out: Booking[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listBookings({ from, to, limit: 1000, ...(agentId ? { agentId } : {}), ...(cursor ? { cursor } : {}) });
      out.push(...page.bookings);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  };
  const range = (q: Record<string, unknown>): { from: string; to: string } => {
    const r = parseRange(q, true) as { from: string; to: string };
    if (days(r.from, r.to) > MAX_RANGE_DAYS) bad(`from and to may span at most ${MAX_RANGE_DAYS} days`);
    return r;
  };
  const routePiers = async (): Promise<Map<string, string>> => new Map((await store.listRoutes()).map((r) => [r.id, pierOf(r)]));

  // ── Proforma (Daily PFM) ──
  const agentCache = async (ids: readonly string[]): Promise<Map<string, PfmAgent>> => {
    const out = new Map<string, PfmAgent>();
    for (const id of new Set(ids)) { const a = await store.agent(id); if (a) out.set(id, { id: a.id, name: a.name, pay_type: a.pay_type, sales_id: a.sales_id }); }
    return out;
  };
  /** The PFM rows of these bookings, as legacy's Daily PFM lists them for the range. */
  const pfmRowsOf = async (bookings: readonly Booking[], r: { from: string; to: string }): Promise<PfmRow[]> => {
    const agents = await agentCache(bookings.map((b) => b.agent_id).filter((x): x is string => !!x));
    const scoped = bookings.map((b) => ({ b, agent: b.agent_id ? agents.get(b.agent_id) : undefined })).map((x) => ({ ...x, kind: pfmKind(x.b, x.agent) }))
      .filter((x): x is { b: Booking; agent: PfmAgent; kind: 'proforma' | 'prepay' } => x.kind !== null && !!x.agent);
    if (!scoped.length) return [];
    const ids = scoped.map((x) => x.b.id);
    const events = await store.pfmEvents(ids);
    const cot = await store.cotDecisions(ids);
    const sales = new Map((await store.listSalesPeople()).map((s) => [s.id, s.name]));
    const now = new Date();
    return scoped.map(({ b, agent, kind }) => {
      const salesId = b.sold_by || agent.sales_id;
      const deduct = cotDeductions(cot.filter((d) => d.booking_id === b.id)).reduce((s, d) => s + d.deduct, 0);
      return pfmRow(b, agent, salesId ? sales.get(salesId) ?? null : null, kind, events.filter((e) => e.booking_id === b.id), deduct, r, now);
    }).sort((x, y) => (x.travel_date === y.travel_date ? (x.booking_id < y.booking_id ? -1 : 1) : x.travel_date < y.travel_date ? 1 : -1));
  };
  /** One booking's row, over all its trips. */
  const pfmRowFor = async (b: Booking): Promise<PfmRow | null> => {
    const dates = b.trips.map((t) => t.service_date).sort();
    return (await pfmRowsOf([b], { from: dates[0] ?? '0000-01-01', to: dates[dates.length - 1] ?? '9999-12-31' }))[0] ?? null;
  };

  app.get('/v1/pfm', async (request) => {
    const r = range(query(request));
    const rows = await pfmRowsOf(await bookingsBetween(r.from, r.to, agentOf(request)), r);
    return { ...r, rows, totals: pfmTotals(rows) };
  });
  for (const [path, decision] of [['approve-travel', 'approved'], ['hold', 'hold']] as const) {
    app.post(`/v1/bookings/:id/pfm/${path}`, async (request) => {
      const body = record(request.body ?? {});
      return store.transaction(async () => {
        await assertBookingFresh(request);
        const b = await bookingOf(request);
        if (!holdsSeats(b.status)) fail(`Booking ${b.id} is ${b.status}`, 409, 'booking_cancelled');
        const row = await pfmRowFor(b);
        const { event, history } = planDecision(row, b.id, decision, decision === 'approved' ? approverOf(body) ?? row?.sales_name ?? null : null, nowIso(), by(request));
        await store.addPfmEvent(event);
        await store.addHistory(b.id, history);
        await store.bumpBooking(b.id, actorOf(request.user));
        return (await pfmRowFor((await store.booking(b.id))!))!;
      });
    });
  }
  app.post('/v1/pfm/remind', async (request) => {
    const r = range(record(request.body ?? {}));
    return store.transaction(async () => {
      const rows = toRemind(await pfmRowsOf(await bookingsBetween(r.from, r.to), r));
      const at = nowIso(), who = by(request);
      for (const row of rows) {
        await store.addPfmEvent({ booking_id: row.booking_id, kind: 'reminded', approver: null, by: who, at });
        await store.addHistory(row.booking_id, remindedLine(who));
      }
      return { reminded: rows.map((x) => x.booking_id) };
    });
  });

  // ── Pier money ──
  const agentPayType = async (b: Booking): Promise<string | null> => (b.agent_id ? (await store.agent(b.agent_id))?.pay_type ?? null : null);
  /** The amount owed at the pier for one booking and day, with its payments and sales. */
  const pierRow = async (b: Booking, date: string) => {
    const [sales, payments] = [await store.tourSales([b.id]), await store.pierPayments([b.id])];
    const refs = await files([...payments.flatMap((p) => p.slips), ...sales.flatMap((s) => s.slips)]);
    return {
      ...pierMoney(b as MoneyBooking, date, sales, payments, await agentPayType(b)),
      payments: payments.filter((p) => p.service_date === date).map((p) => pierPaymentView(p, refs)),
      tour_sales: sales.map((s) => tourSaleView(s, refs)),
    };
  };
  app.get('/v1/pier-money', async (request) => {
    const q = query(request);
    const date = dayOf(q.date ?? q.service_date, 'date');
    const routeId = typeof q.route_id === 'string' && q.route_id ? q.route_id : undefined;
    const pier = typeof q.pier === 'string' && q.pier ? q.pier : undefined;
    const piers = await routePiers();
    const agent = agentOf(request);
    const bookings = (await store.bookingsOnDate(date)).filter((b) => holdsSeats(b.status) && (!agent || b.agent_id === agent))
      .filter((b) => b.trips.some((t) => t.service_date === date && (!routeId || t.route_id === routeId) && (!pier || (piers.get(t.route_id) ?? 'other') === pier)));
    const ids = bookings.map((b) => b.id);
    const [sales, payments] = [await store.tourSales(ids), await store.pierPayments(ids)];
    const types = new Map<string, string | null>();
    for (const id of new Set(bookings.map((b) => b.agent_id).filter((x): x is string => !!x))) types.set(id, (await store.agent(id))?.pay_type ?? null);
    return {
      service_date: date,
      rows: bookings.map((b) => pierMoney(b as MoneyBooking, date, sales.filter((s) => s.booking_id === b.id), payments.filter((p) => p.booking_id === b.id), b.agent_id ? types.get(b.agent_id) ?? null : null))
        .sort((x, y) => (x.route_id === y.route_id ? (x.booking_id < y.booking_id ? -1 : 1) : x.route_id < y.route_id ? -1 : 1)),
    };
  });
  app.get('/v1/bookings/:id/pier-money', async (request) => {
    const b = await bookingOf(request);
    const date = dayOf(query(request).date ?? query(request).service_date, 'date');
    assertOnTrip(b, date);
    return pierRow(b, date);
  });
  /** Legacy `pckPaySave`: one payment per method, more than owed only with `overpay_anyway`. */
  app.post('/v1/bookings/:id/pier-payments', async (request, reply) => {
    const req = parsePierPayment(record(request.body));
    const out = await store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      assertLive(b);
      assertOnTrip(b, req.service_date);
      await assertSlips(req.lines.flatMap((l) => l.slips));
      const before = await pierRow(b, req.service_date);
      // One instant for every line, so the ids keep the lines' order (`ORDER BY at, id`).
      const base = randomUUID();
      let line = 0;
      const { payments, history } = recordPierPayments(b.id, req, before.due, () => `pp_${base}_${String(line++).padStart(2, '0')}`, nowIso(), by(request));
      for (const p of payments) await store.putPierPayment(p);
      await store.addHistory(b.id, history);
      await store.bumpBooking(b.id, actorOf(request.user));
      return pierRow((await store.booking(b.id))!, req.service_date);
    });
    return reply.code(201).send(out);
  });
  const pierPaymentOf = async (b: Booking, id: string): Promise<StoredPierPayment> =>
    (await store.pierPayments([b.id])).find((p) => p.id === id) ?? notFound(`Pier payment ${id} is not on booking ${b.id}`);
  /** Legacy `pckPayAddSlip`: a slip attached after the payment was saved. */
  app.post('/v1/bookings/:id/pier-payments/:payment_id/slips', async (request) => {
    const ids = slipIdsOf(record(request.body).slip_ids ?? record(request.body).slips);
    if (!ids.length) bad('slip_ids must name at least one uploaded file');
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      const p = await pierPaymentOf(b, param(request, 'payment_id'));
      if (p.deleted_at) fail(`Pier payment ${p.id} is deleted`, 409, 'payment_deleted');
      await assertSlips(ids);
      await store.putPierPayment({ ...p, slips: [...p.slips, ...ids.filter((id) => !p.slips.includes(id))] });
      await store.bumpBooking(b.id, actorOf(request.user));
      return pierRow((await store.booking(b.id))!, p.service_date);
    });
  });
  app.delete('/v1/bookings/:id/pier-payments/:payment_id', async (request) => store.transaction(async () => {
    await assertBookingFresh(request);
    const b = await bookingOf(request);
    const reason = typeof query(request).reason === 'string' && (query(request).reason as string).trim() ? (query(request).reason as string).trim() : null;
    const { payment, history } = deletePierPayment(await pierPaymentOf(b, param(request, 'payment_id')), reason, nowIso(), by(request));
    await store.putPierPayment(payment);
    await store.addHistory(b.id, history);
    await store.bumpBooking(b.id, actorOf(request.user));
    return pierRow((await store.booking(b.id))!, payment.service_date);
  }));

  // ── On-tour sales (legacy SB_EXTRAS) ──
  const saleOf = async (b: Booking, id: string): Promise<StoredTourSale> =>
    (await store.tourSales([b.id])).find((s) => s.id === id) ?? notFound(`Sale ${id} is not on booking ${b.id}`);
  const saleView = async (s: StoredTourSale) => tourSaleView(s, await files(s.slips));
  /** A sale whose commission was paid out keeps what it was paid on. */
  const assertNotPaidOut = async (bookingId: string, kind: 'tour_sale' | 'upgrade', id: string, what: string): Promise<void> => {
    const live = (await store.payouts()).find((p) => !p.voided_at && p.items.some((i) => i.kind === kind && i.booking_id === bookingId && i.item_id === id));
    if (live) fail(`${what}: its commission was paid out (payout ${live.id}); void the payout first`, 409, 'commission_paid');
  };
  app.get('/v1/bookings/:id/tour-sales', async (request) => {
    const b = await bookingOf(request);
    const sales = await store.tourSales([b.id]);
    const refs = await files(sales.flatMap((s) => s.slips));
    return { tour_sales: sales.map((s) => tourSaleView(s, refs)) };
  });
  app.post('/v1/bookings/:id/tour-sales', async (request, reply) => {
    const body = record(request.body);
    const sale = await store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      assertLive(b);
      const input = parseTourSale(body, b);
      await assertSlips(input.slips);
      const { sale: next, history } = planTourSale(input, body, undefined, `ex_${randomUUID()}`, b.id, nowIso(), by(request));
      await store.putTourSale(next);
      await store.addHistory(b.id, history);
      await store.bumpBooking(b.id, actorOf(request.user));
      return next;
    });
    return reply.code(201).send(await saleView(sale));
  });
  app.patch('/v1/bookings/:id/tour-sales/:sale_id', async (request) => {
    const body = record(request.body);
    const sale = await store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      const current = await saleOf(b, param(request, 'sale_id'));
      const input = parseTourSale(body, b, current);
      await assertSlips(input.slips);
      const { sale: next, history } = planTourSale(input, body, current, current.id, b.id, nowIso(), by(request));
      const was = tourSaleView(current), now = tourSaleView(next);
      if (was.commission !== now.commission || current.seller !== next.seller) await assertNotPaidOut(b.id, 'tour_sale', current.id, `Sale ${current.id}`);
      await store.putTourSale(next);
      await store.addHistory(b.id, history);
      await store.bumpBooking(b.id, actorOf(request.user));
      return next;
    });
    return saleView(sale);
  });
  app.post('/v1/bookings/:id/tour-sales/:sale_id/collect', async (request) => {
    const body = record(request.body ?? {});
    const sale = await store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      const { sale: next, history } = collectTourSale(await saleOf(b, param(request, 'sale_id')), body, nowIso(), by(request));
      await assertSlips(next.slips);
      await store.putTourSale(next);
      await store.addHistory(b.id, history);
      await store.bumpBooking(b.id, actorOf(request.user));
      return next;
    });
    return saleView(sale);
  });
  /** Legacy `bkV2ExtraDelete`: gone, and not logged, as legacy. */
  app.delete('/v1/bookings/:id/tour-sales/:sale_id', async (request, reply) => {
    await store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      const sale = await saleOf(b, param(request, 'sale_id'));
      await assertNotPaidOut(b.id, 'tour_sale', sale.id, `Sale ${sale.id}`);
      await store.deleteTourSale(sale.id);
      await store.bumpBooking(b.id, actorOf(request.user));
    });
    return reply.code(204).send();
  });
  /** An upgrade's money collected (todo/money-model.md slice 3: `collected` under the same rule as a sale). */
  app.post('/v1/bookings/:id/upgrades/:upgrade_id/collect', async (request) => {
    const body = record(request.body ?? {});
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      const { upgrades, history } = collectUpgrade(b.upgrades.map(upgradeStored), param(request, 'upgrade_id'), body, by(request));
      await assertSlips(upgrades.flatMap((u) => u.slips));
      await store.setUpgrades(b.id, upgrades);
      await store.addHistory(b.id, history);
      await store.bumpBooking(b.id, actorOf(request.user));
      return (await store.booking(b.id))!;
    });
  });

  // ── The pier's cash handed over at day close ──
  const takingsOf = async (date: string, pier: string) => {
    const bookings = await store.bookingsOnDate(date);
    const ids = bookings.map((b) => b.id);
    const [sales, payments] = [await store.tourSales(ids), await store.pierPayments(ids)];
    const piers = await routePiers();
    return takings(date, pier, bookings.map((b) => ({ booking: b as MoneyBooking, sales: sales.filter((s) => s.booking_id === b.id), payments: payments.filter((p) => p.booking_id === b.id) })),
      (routeId) => piers.get(routeId) ?? 'other');
  };
  const handoverRead = async (h: StoredHandover) => handoverView(h, await takingsOf(h.service_date, h.pier));
  const handoverOf = async (request: Request): Promise<StoredHandover> =>
    (await store.handovers({ ids: [param(request)] }))[0] ?? notFound(`Hand-over ${param(request)} not found`);
  app.get('/v1/pier-handovers', async (request) => {
    notForAgents(request);
    const q = query(request);
    const r = parseRange(q);
    const pier = typeof q.pier === 'string' && q.pier ? q.pier : undefined;
    const out = [];
    for (const h of await store.handovers({ ...r, ...(pier ? { pier } : {}) })) out.push(await handoverRead(h));
    return { handovers: out };
  });
  app.get('/v1/pier-handovers/preview', async (request) => {
    notForAgents(request);
    const q = query(request);
    const date = dayOf(q.date ?? q.service_date, 'date');
    const pier = typeof q.pier === 'string' && q.pier ? q.pier : bad('pier is required');
    const live = (await store.handovers({ from: date, to: date, pier: pier! })).find((h) => !h.voided_at);
    return { service_date: date, pier, expected: await takingsOf(date, pier!), handover: live ? await handoverRead(live) : null };
  });
  app.get('/v1/pier-handovers/:id', async (request) => { notForAgents(request); return handoverRead(await handoverOf(request)); });
  app.post('/v1/pier-handovers', async (request, reply) => {
    const input = parseHandover(record(request.body));
    const h = await store.transaction(async () => {
      const live = (await store.handovers({ from: input.service_date, to: input.service_date, pier: input.pier })).find((x) => !x.voided_at);
      const next = planHandover(input, live, await takingsOf(input.service_date, input.pier), `ho_${randomUUID()}`, nowIso(), by(request));
      await store.putHandover(next);
      return next;
    });
    return reply.code(201).send(await handoverRead(h));
  });
  app.post('/v1/pier-handovers/:id/accept', async (request) => {
    const note = noteOf(record(request.body ?? {}), 'note');
    const h = await store.transaction(async () => {
      const next = acceptHandover(await handoverOf(request), note, nowIso(), by(request));
      await store.putHandover(next);
      return next;
    });
    return handoverRead(h);
  });
  app.post('/v1/pier-handovers/:id/void', async (request) => {
    const reason = noteOf(record(request.body ?? {}), 'reason');
    const h = await store.transaction(async () => {
      const next = voidHandover(await handoverOf(request), reason, nowIso(), by(request));
      await store.putHandover(next);
      return next;
    });
    return handoverRead(h);
  });

  // ── Commission payouts ──
  const itemsOf = async (bookings: readonly Booking[]): Promise<CommissionItem[]> => {
    const sales = await store.tourSales(bookings.map((b) => b.id));
    return commissionItems(bookings.map((b) => ({ booking: b, sales: sales.filter((s) => s.booking_id === b.id) })), await store.payouts());
  };
  app.get('/v1/commissions', async (request) => {
    notForAgents(request);
    const q = query(request);
    const r = range(q);
    const seller = typeof q.seller === 'string' && q.seller ? q.seller : undefined;
    const paid = q.paid === undefined ? undefined : q.paid === 'true' ? true : q.paid === 'false' ? false : bad('paid must be true or false');
    const items = (await itemsOf(await bookingsBetween(r.from, r.to))).filter((i) => (!i.date || (i.date >= r.from && i.date <= r.to))
      && (!seller || i.seller === seller) && (paid === undefined || !!i.payout_id === paid));
    const totals = new Map<string, { seller: string | null; commission: number; paid: number; unpaid: number }>();
    for (const i of items) {
      const t = totals.get(i.seller ?? '') ?? { seller: i.seller, commission: 0, paid: 0, unpaid: 0 };
      t.commission = Math.round((t.commission + i.commission) * 100) / 100;
      if (i.payout_id) t.paid = Math.round((t.paid + i.commission) * 100) / 100; else t.unpaid = Math.round((t.unpaid + i.commission) * 100) / 100;
      totals.set(i.seller ?? '', t);
    }
    return { ...r, items, totals: [...totals.values()].sort((a, b) => ((a.seller ?? '') < (b.seller ?? '') ? -1 : 1)) };
  });
  const payoutOf = async (request: Request) => (await store.payouts({ ids: [param(request)] }))[0] ?? notFound(`Payout ${param(request)} not found`);
  app.get('/v1/commission-payouts', async (request) => {
    notForAgents(request);
    const q = query(request);
    const r = parseRange(q);
    return { payouts: await store.payouts({ ...r, ...(typeof q.seller === 'string' && q.seller ? { seller: q.seller } : {}) }) };
  });
  app.get('/v1/commission-payouts/:id', async (request) => { notForAgents(request); return payoutOf(request); });
  app.post('/v1/commission-payouts', async (request, reply) => {
    const input = parsePayout(record(request.body), todayInThailand());
    const payout = await store.transaction(async () => {
      const bookings: Booking[] = [];
      for (const id of new Set(input.items.map((i) => i.booking_id))) bookings.push((await store.booking(id)) ?? bad(`Booking ${id} not found`));
      const next = planPayout(input, await itemsOf(bookings), `cp_${randomUUID()}`, nowIso(), by(request));
      await store.putPayout(next);
      return next;
    });
    return reply.code(201).send(payout);
  });
  app.post('/v1/commission-payouts/:id/void', async (request) => {
    const reason = noteOf(record(request.body ?? {}), 'reason');
    return store.transaction(async () => {
      const next = voidPayout(await payoutOf(request), reason, nowIso(), by(request));
      await store.putPayout(next);
      return next;
    });
  });

  // ── After the trip ──
  const fullInvoice = async (inv: StoredInvoice): Promise<InvoiceView> => {
    const payments = await store.paymentsOf([inv.id]);
    return invoiceView(inv, payments, await files(payments.flatMap((p) => p.slips)), await store.listRefunds({ invoiceIds: [inv.id] }));
  };
  /** After a COT decision changed: the booking's invoice follows it (decided 2026-10-09). */
  const syncInvoice = async (b: Booking, request: Request): Promise<{ invoice: InvoiceView | null; warnings: { code: string; message: string }[] }> => {
    const invoices = await store.invoicesOfBookings([b.id]);
    const synced = syncCotLines(b.id, invoices, await store.cotDecisions([b.id]), nowIso(), by(request));
    const live = synced?.invoice ?? invoices.filter((i) => !i.voided && i.kind !== 'fee' && i.lines.some((l) => l.booking_id === b.id && !l.removed_at)).sort((x, y) => (x.issued_at < y.issued_at ? 1 : -1))[0];
    if (synced) {
      await store.putInvoice(synced.invoice);
      const deducted = -synced.invoice.lines.filter((l) => l.booking_id === b.id && l.cot_date && !l.removed_at).reduce((s, l) => s + l.amount, 0);
      await store.addHistory(b.id, cotInvoiceLine(by(request), synced.invoice, deducted));
    }
    if (!live) return { invoice: null, warnings: [] };
    const view = await fullInvoice(live);
    return {
      invoice: view,
      warnings: view.overpaid > 0 ? [{ code: 'invoice_overpaid', message: `Invoice ${view.number} is now paid ฿${view.overpaid.toLocaleString('en-US')} above its total: refund or credit the agent` }] : [],
    };
  };
  const cotRead = async (b: Booking, list: readonly StoredCotDecision[]) => {
    const refs = await files(list.flatMap((d) => d.slips));
    return list.map((d) => cotDecisionView(d, cotAmount(b), refs));
  };
  app.get('/v1/after-trip', async (request) => {
    const date = dayOf(query(request).date ?? query(request).service_date, 'date');
    const agent = agentOf(request);
    const bookings = (await store.bookingsOnDate(date)).filter((b) => holdsSeats(b.status) && (!agent || b.agent_id === agent));
    const ids = bookings.map((b) => b.id);
    const [cot, noshow] = [await store.cotDecisions(ids), await store.noshowCharges(ids)];
    const refs = await files(cot.flatMap((d) => d.slips));
    return {
      service_date: date,
      rows: bookings.map((b) => {
        const trip = b.trips.find((t) => t.service_date === date)!;
        const d = cot.find((x) => x.booking_id === b.id && x.service_date === date);
        return {
          booking_id: b.id, version: b.version, voucher_ref: b.voucher_ref ?? null, agent_id: b.agent_id ?? null, lead_pax: b.lead_pax ?? null, route_id: trip.route_id,
          overnight_return: trip.ovn_leg, trip_amount: tripAmount(b, date),
          cot: { amount: cotAmount(b), currency: b.cash_on_tour_currency ?? 'THB', handling: b.cash_on_tour_handling ?? null, suggested_mode: suggestedCotMode(b.cash_on_tour_handling),
            decision: d ? cotDecisionView(d, cotAmount(b), refs) : null },
          noshow: noshow.find((x) => x.booking_id === b.id && x.service_date === date) ?? null,
        };
      }).sort((x, y) => (x.route_id === y.route_id ? (x.booking_id < y.booking_id ? -1 : 1) : x.route_id < y.route_id ? -1 : 1)),
    };
  });
  app.get('/v1/bookings/:id/after-trip', async (request) => {
    const b = await bookingOf(request);
    return { cot_decisions: await cotRead(b, await store.cotDecisions([b.id])), noshow_charges: await store.noshowCharges([b.id]) };
  });
  app.put('/v1/bookings/:id/cot-decisions/:date', async (request) => {
    const body = record(request.body);
    const date = dayOf(param(request, 'date'), 'date');
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      assertLive(b);
      const current = (await store.cotDecisions([b.id])).find((d) => d.service_date === date);
      const { decision, warnings } = planCotDecision(b, date, body, current, nowIso(), by(request));
      await assertSlips(decision.slips);
      await store.putCotDecision(decision);
      const money = await syncInvoice(b, request);
      await store.bumpBooking(b.id, actorOf(request.user));
      return { decision: (await cotRead(b, [decision]))[0], invoice: money.invoice, warnings: [...warnings, ...money.warnings] };
    });
  });
  app.delete('/v1/bookings/:id/cot-decisions/:date', async (request) => {
    const date = dayOf(param(request, 'date'), 'date');
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      if (!(await store.deleteCotDecision(b.id, date))) notFound(`Booking ${b.id} has no cash-on-tour decision on ${date}`);
      const money = await syncInvoice(b, request);
      await store.bumpBooking(b.id, actorOf(request.user));
      return { decision: null, invoice: money.invoice, warnings: money.warnings };
    });
  });
  app.put('/v1/bookings/:id/noshow-charges/:date', async (request) => {
    const body = record(request.body);
    const date = dayOf(param(request, 'date'), 'date');
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      assertLive(b);
      const charge = planNoshowCharge(b, date, body, nowIso(), by(request));
      await store.putNoshowCharge(charge);
      await store.bumpBooking(b.id, actorOf(request.user));
      return charge;
    });
  });
  app.delete('/v1/bookings/:id/noshow-charges/:date', async (request, reply) => {
    const date = dayOf(param(request, 'date'), 'date');
    await store.transaction(async () => {
      await assertBookingFresh(request);
      const b = await bookingOf(request);
      if (!(await store.deleteNoshowCharge(b.id, date))) notFound(`Booking ${b.id} has no no-show decision on ${date}`);
      await store.bumpBooking(b.id, actorOf(request.user));
    });
    return reply.code(204).send();
  });
}
