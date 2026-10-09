/**
 * Money slices 5 and 6 (todo/money-model.md, decided 2026-10-09): partner van bills with their sent and
 * paid state, Transfer Fleet's van rates, and the money reports (accounting dashboard, agent
 * statement, Travel Summary totals, the Daily Report's money pane and its settings). The reports read
 * the pier's money and the decisions after the trip (Money slices 3 and 4) as well.
 *
 * The rules are in `src/domain/van-bills.ts` and `src/domain/money-reports.ts`. A handler reads what the
 * rule needs from the store, asks the rule, and writes what it answers in one transaction. Who may
 * write is the `preHandler` hook's (`writeNeed` in `users.ts`).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import type { Booking } from '../domain/operations.js';
import { actorOf, refuse } from '../domain/booking-actions.js';
import { eachDate, isIsoDate, todayInThailand } from '../domain/calendar.js';
import { creditOf, invoiceView, type InvoiceView, type StoredInvoice } from '../domain/invoices.js';
import { creditBalance } from '../domain/refunds.js';
import { assertAgentInScope, salesScopeOf } from '../domain/agent-writes.js';
import {
  applyPatch, billPeriod, billRows, billView, blankBill, overviewLine, parseBillAddress, parseBillPatch, parseMonthPeriod, parsePay, parseVanRate, partnersOf,
  partnerVans, pay, pullRates, send, sortOverview, unpay, unsend, vanRateGroups, VAN_RATE_DEFAULT, assertEditable, type BillAddress, type StoredVanBill,
} from '../domain/van-bills.js';
import { accountingDashboard, agentStatement, dailyMoney, dailySettingsView, parseDailySettings, travelSummary, type DayMoneyInput } from '../domain/money-reports.js';

type Request = FastifyRequest;
const bad = (message: string): never => refuse(message, 400);
const notFound = (message: string): never => refuse(message, 404);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('Request body must be an object'));
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const params = (request: Request): Record<string, unknown> => (request.params ?? {}) as Record<string, unknown>;
const dateParam = (v: unknown): string => (typeof v === 'string' && isIsoDate(v) ? v : bad('date must be YYYY-MM-DD'));

export function registerMoneyReportRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const by = (request: Request): string | null => actorOf(request.user) ?? null;
  /** The reports are staff screens: a login tied to one agent sees its own statement only. */
  const staffOnly = (request: Request): void => {
    if (request.user?.user?.agent_id) refuse('This report is for staff; an agent login sees its own statement (GET /v1/agents/{id}/statement)', 403, 'forbidden');
  };

  // ── Reading what the rules need ──
  /** Every booking with a trip in `from..to`, each once. */
  const bookingsBetween = async (from: string, to: string): Promise<Booking[]> => {
    const seen = new Map<string, Booking>();
    for (const date of eachDate(from, to)) for (const b of await store.bookingsOnDate(date)) if (!seen.has(b.id)) seen.set(b.id, b);
    return [...seen.values()];
  };
  const allBookings = async (agentId?: string): Promise<Booking[]> => {
    const out: Booking[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listBookings({ limit: 1000, ...(agentId ? { agentId } : {}), ...(cursor ? { cursor } : {}) });
      out.push(...page.bookings);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  };
  const views = async (invoices: readonly StoredInvoice[]): Promise<InvoiceView[]> => {
    const ids = invoices.map((i) => i.id);
    const payments = await store.paymentsOf(ids), refunds = await store.listRefunds({ invoiceIds: ids });
    return invoices.map((i) => invoiceView(i, payments.filter((p) => p.invoice_id === i.id), new Map(), refunds.filter((r) => r.invoice_id === i.id)));
  };
  /** A day's pier payments, on-tour sales and decisions after the trip, for these bookings. */
  const dayMoney = async (bookings: readonly Booking[]): Promise<DayMoneyInput> => {
    const ids = bookings.map((b) => b.id);
    return { sales: await store.tourSales(ids), payments: await store.pierPayments(ids), cot: await store.cotDecisions(ids), noshow: await store.noshowCharges(ids) };
  };
  const areaNames = async () => ({ areas: new Map((await store.listPickupAreas()).map((a) => [a.id, a])) });

  // ── Van bills ──
  /** The bill and what prices it: its stored inputs (or a blank), the partner's vans and the rows. */
  const loadBill = async (a: BillAddress, vanId?: string) => {
    const vans = partnerVans(await store.listVans(), a.partner);
    const stored = await store.vanBill(a.partner, a.month, a.period);
    if (!vans.length && !stored) notFound(`No partner van belongs to "${a.partner}" (GET /operations/vans)`);
    if (vanId && !vans.some((v) => v.id === vanId)) bad(`van_id ${vanId} is not one of ${a.partner}'s vans`);
    const { from, to } = billPeriod(a.month, a.period);
    const bookings = await bookingsBetween(from, to);
    const ctx = await areaNames();
    const rows = billRows({ from, to, vans, bookings, vanId }, ctx);
    const allRows = vanId ? billRows({ from, to, vans, bookings }, ctx) : rows;
    const bill = stored ?? blankBill(a);
    return { vans, stored, bill, rows, allRows, view: billView(bill, rows, vans, { saved: !!stored, vanId }), full: () => billView(bill, allRows, vans, { saved: !!stored }) };
  };
  const address = (request: Request): BillAddress => parseBillAddress(params(request));
  const answer = async (a: BillAddress) => (await loadBill(a)).view;

  /** The overview (legacy `vbAgg`): every partner with work in the period, most runs first. */
  app.get('/v1/van-bills', async (request) => {
    const q = query(request);
    const { month, period } = parseMonthPeriod(q.month, q.period);
    const { from, to, label } = billPeriod(month, period);
    const allVans = await store.listVans();
    const bookings = await bookingsBetween(from, to);
    const stored = new Map((await store.vanBillsOf(month, period)).map((b) => [b.partner, b]));
    const ctx = await areaNames();
    const lines = partnersOf(allVans).map((partner) => {
      const vans = partnerVans(allVans, partner);
      const bill = stored.get(partner) ?? blankBill({ partner, month, period });
      return overviewLine(billView(bill, billRows({ from, to, vans, bookings }, ctx), vans, { saved: stored.has(partner) }));
    });
    const partners = sortOverview(lines);
    const total = (k: 'trips' | 'pax' | 'bill' | 'sale' | 'pl') => Math.round(partners.reduce((s, l) => s + l[k], 0) * 100) / 100;
    return { month, period, from, to, label, partners, totals: { trips: total('trips'), pax: total('pax'), bill: total('bill'), sale: total('sale'), pl: total('pl') } };
  });
  app.get('/v1/van-bills/:partner/:month/:period', async (request) => {
    const vanId = typeof query(request).van_id === 'string' && query(request).van_id !== '' ? String(query(request).van_id) : undefined;
    return (await loadBill(address(request), vanId)).view;
  });
  /** The staff inputs (legacy `vbSet`, `vbSetRateC`, `vbSetRow`, `vbAddExtra`, `vbSave`). */
  app.patch('/v1/van-bills/:partner/:month/:period', async (request) => {
    const body = record(request.body);
    const a = address(request);
    await store.transaction(async () => {
      const cur = await loadBill(a);
      const patch = parseBillPatch(body, cur.full());
      await store.putVanBill(applyPatch(cur.bill, patch, cur.allRows.map((r) => r.key), new Date().toISOString(), by(request)));
    });
    return answer(a);
  });
  /** Legacy `vbPullRates`: the route rates from Transfer Fleet's table, to check and change. */
  app.post('/v1/van-bills/:partner/:month/:period/pull-rates', async (request) => {
    const a = address(request);
    const pulled = await store.transaction(async () => {
      const cur = await loadBill(a);
      assertEditable(cur.bill);
      const p = pullRates(cur.allRows, cur.vans, await store.vanRates());
      if (!p.got.length) refuse(`ยังไม่ได้ตั้งเรตของ "${a.partner}" ไว้ในหน้า Transfer Fleet`, 409, 'no_van_rates');
      const next: StoredVanBill = { ...cur.bill, route_rates: { ...cur.bill.route_rates, ...p.route_rates }, updated_at: new Date().toISOString(), updated_by: by(request) };
      await store.putVanBill(next);
      return p;
    });
    return { ...(await answer(a)), pulled: { got: pulled.got, none: pulled.none } };
  });
  const settle = (path: string, step: (cur: Awaited<ReturnType<typeof loadBill>>, request: Request) => StoredVanBill) => {
    app.post(`/v1/van-bills/:partner/:month/:period/${path}`, async (request) => {
      const a = address(request);
      await store.transaction(async () => { await store.putVanBill(step(await loadBill(a), request)); });
      return answer(a);
    });
  };
  settle('send', (cur, request) => send(cur.bill, cur.full().totals.bill, new Date().toISOString(), by(request)));
  settle('unsend', (cur) => unsend(cur.bill));
  settle('pay', (cur, request) => pay(cur.bill, parsePay(record(request.body ?? {}), new Date()), cur.full().totals.bill, new Date().toISOString(), by(request)));
  settle('unpay', (cur) => unpay(cur.bill));

  // ── Van rates (Transfer Fleet, legacy `van_rates`) ──
  const ratesView = async () => ({ groups: vanRateGroups(await store.listVans()), rates: await store.vanRates(), defaults: VAN_RATE_DEFAULT });
  app.get('/v1/van-rates', async () => ratesView());
  /** Legacy `vanRateSet`: one cell; `rate: null` (or empty) clears it. */
  app.put('/v1/van-rates', async (request) => {
    const body = record(request.body);
    await store.transaction(async () => {
      const input = parseVanRate(body, new Set((await store.listRoutes()).map((r) => r.id)));
      if (input.rate === null) await store.deleteVanRate(input.group_key, input.route_id, input.field);
      else await store.putVanRate({ group_key: input.group_key, route_id: input.route_id, field: input.field, rate: input.rate, updated_at: new Date().toISOString(), updated_by: by(request) });
    });
    return ratesView();
  });

  // ── Reports ──
  /** Legacy `renderAccounting` + `acctDashboardHtml`. */
  app.get('/v1/reports/accounting', async (request) => {
    staffOnly(request);
    const invoices = await views(await store.listInvoices());
    const payments = await store.paymentsOf(invoices.map((i) => i.id));
    const agents = await store.agentRecords();
    const bookings = await allBookings();
    const byAgent = new Map<string, Booking[]>();
    for (const b of bookings) if (b.agent_id) byAgent.set(b.agent_id, [...(byAgent.get(b.agent_id) ?? []), b]);
    const refunds = await store.listRefunds();
    const agentOf = new Map(invoices.map((i) => [i.id, i.agent_id]));
    let exposure = 0, held = 0;
    for (const a of agents) {
      exposure += creditOf(a, byAgent.get(a.id) ?? []).used;
      held += creditBalance(refunds.filter((r) => r.agent_id === a.id), payments.filter((p) => agentOf.get(p.invoice_id) === a.id)).available;
    }
    const sales = await store.tourSales(bookings.map((b) => b.id));
    return accountingDashboard({ invoices, payments, agents, credit_exposure: exposure, deposits_held: held, now: new Date(), sales });
  });
  /** Legacy `acctStatementOpen`. A login tied to an agent reads its own; a salesperson their agents'. */
  app.get('/v1/agents/:id/statement', async (request) => {
    const id = String(params(request).id);
    const agent = (await store.agentRecord(id)) ?? notFound('Agent not found');
    const own = request.user?.user?.agent_id;
    if (own && own !== id) notFound('Agent not found');
    assertAgentInScope(agent, salesScopeOf(request.user?.user));
    const stored = await store.listInvoices({ agentId: id });
    const invoices = await views(stored);
    const refunds = await store.listRefunds({ agentId: id });
    const bookings = await allBookings(id);
    return agentStatement(agent, invoices, refunds, creditBalance(refunds, await store.paymentsOf(stored.map((i) => i.id))), creditOf(agent, bookings));
  });
  app.get('/v1/reports/travel-summary', async (request) => {
    staffOnly(request);
    const date = dateParam(query(request).date ?? todayInThailand());
    const bookings = await store.bookingsOnDate(date);
    return travelSummary(date, bookings, await dayMoney(bookings));
  });
  app.get('/v1/reports/daily', async (request) => {
    staffOnly(request);
    const date = dateParam(query(request).date ?? todayInThailand());
    const bookings = await store.bookingsOnDate(date);
    return {
      ...dailyMoney(date, bookings, await dayMoney(bookings), {
        agents: await store.agentRecords(), markets: await store.listMarkets(), routes: await store.listRoutes(), vans: await store.listVans(),
        rates: await store.vanRates(), areas: await store.listPickupAreas(), settings: await store.dailyReportSettings(),
      }),
      settings: dailySettingsView(await store.dailyReportSettings()),
    };
  });
  app.get('/v1/reports/daily/settings', async () => dailySettingsView(await store.dailyReportSettings()));
  /** Legacy `drCfgSet`: whole numbers; 0 or null goes back to the default. */
  app.put('/v1/reports/daily/settings', async (request) => {
    const body = record(request.body);
    await store.transaction(async () => {
      const values = parseDailySettings(body, await store.dailyReportSettings());
      await store.putDailyReportSettings({ ...values, updated_at: new Date().toISOString(), updated_by: by(request) });
    });
    return dailySettingsView(await store.dailyReportSettings());
  });
}
