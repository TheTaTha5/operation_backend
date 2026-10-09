/**
 * The pier office (todo/pier-office-model.md; migrations 170–171): petty cash per pier (legacy
 * §poCash) and the office lists (equipment kinds and items, roster codes and groups, staff, licence
 * types and classes).
 *
 * The rules are in `src/domain/pier-cash.ts` and `pier-office.ts`. A handler reads what a rule needs,
 * asks it, and only then writes, all in one transaction: the in-process store does not roll back, so
 * nothing is written before every refusal has had its chance. Who may write is the `preHandler`
 * hook's (`writeNeed` in `users.ts`): `pier` or `operations`, as legacy's `poCanEdit`. Reads are for
 * staff logins; a login tied to an agent sees none of it.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import { actorOf, refuse } from '../domain/booking-actions.js';
import {
  applyLongtail, applyPark, certificate, dayBefore, dayTotals, deleteCashRow, ledgerDay, longtailSheet, longtailView, monthRange, monthTable, newCashRow, openingOf,
  parkSheet, parkView, parseCashRow, parseDate, parseMonth, parsePier, parseSettings, planPull, type BoatOfDay, type Ctx,
} from '../domain/pier-cash.js';
import { LIST_KEYS, listsView, newListId, parseList, planCreate, planDelete, planOrder, planPatch, sortLists, type PierList, type PierLists } from '../domain/pier-office.js';
import type { PierOfficeRepo } from '../domain/pier-office-store.js';

type Request = FastifyRequest;
const bad = (message: string): never => refuse(message, 400);
const notFound = (message: string): never => refuse(message, 404);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('Request body must be an object'));
const params = (request: Request): Record<string, string> => (request.params ?? {}) as Record<string, string>;
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const yes = (value: unknown): boolean => value === true || value === 'true';

export function registerPierOfficeRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const repo = (): PierOfficeRepo => store.pierOfficeRepo as PierOfficeRepo;
  const ctx = (request: Request): Ctx => ({ now: new Date().toISOString(), by: actorOf(request.user) ?? null });
  const notForAgents = (request: Request): void => {
    if (request.user?.user?.agent_id) refuse('This login books for its agent and sees nothing of the pier office', 403, 'forbidden');
  };
  const pierDay = (request: Request): { pier: string; date: string } => ({ pier: parsePier(params(request).pier), date: parseDate(params(request).date) });

  // ── Petty cash ──

  /** The ledger for one day: the balance carried in, the day's rows and the sheets' figures. */
  const ledger = async (pier: string, date: string, withDeleted = false) => {
    const r = repo();
    const day = { pier, from: date, to: date };
    return ledgerDay(pier, date, openingOf(await r.cashRows({ pier, to: dayBefore(date) })), await r.cashRows(day), await r.longtail(day), await r.park(day), withDeleted);
  };
  /** The boats running from the pier in a range: deployed on one of its routes. */
  const boatsBetween = async (pier: string, from: string, to: string): Promise<{ boats: BoatOfDay[]; names: Map<string, string> }> => {
    const routes = new Map((await store.listRoutes()).map((r) => [r.id, r]));
    const names = new Map((await store.listBoats()).map((b) => [b.id, b.name]));
    const boats = (await store.listDeployments(from, to)).filter((d) => routes.get(d.route_id)?.pier === pier).map((d) => {
      const route = routes.get(d.route_id)!;
      return { date: d.service_date, boat_id: d.boat_id, boat_name: names.get(d.boat_id) ?? d.boat_id, route_id: route.id, route_name: route.name, route_color: route.color ?? null };
    });
    return { boats, names };
  };
  const assertBoat = async (id: string): Promise<void> => {
    if (!(await store.boatRecord(id))) notFound(`Boat ${id} not found (GET /v1/boats)`);
  };

  app.get('/v1/pier-cash/settings', async (request) => { notForAgents(request); return repo().cashSettings(); });
  app.put('/v1/pier-cash/settings', async (request) => {
    const input = parseSettings(record(request.body));
    const c = ctx(request);
    return store.transaction(async () => {
      const next = { ...input, updated_at: c.now, updated_by: c.by };
      await repo().putCashSettings(next);
      return next;
    });
  });

  app.get('/v1/pier-cash/:pier/days/:date', async (request) => {
    notForAgents(request);
    const { pier, date } = pierDay(request);
    return ledger(pier, date, yes(query(request).deleted));
  });
  app.post('/v1/pier-cash/:pier/days/:date/rows', async (request, reply) => {
    const { pier, date } = pierDay(request);
    const input = parseCashRow(record(request.body));
    const out = await store.transaction(async () => {
      const row = newCashRow(pier, date, input, `pc_${randomUUID()}`, ctx(request));
      await repo().putCashRow(row);
      return { row, day: await ledger(pier, date) };
    });
    return reply.code(201).send(out);
  });
  app.delete('/v1/pier-cash/rows/:id', async (request) => store.transaction(async () => {
    const current = (await repo().cashRow(params(request).id)) ?? notFound(`Petty cash row ${params(request).id} not found`);
    const reason = typeof query(request).reason === 'string' && (query(request).reason as string).trim() ? (query(request).reason as string).trim() : null;
    const row = deleteCashRow(current!, reason, ctx(request));
    await repo().putCashRow(row);
    return { row, day: await ledger(row.pier, row.date) };
  }));
  app.post('/v1/pier-cash/:pier/days/:date/pull', async (request, reply) => {
    const { pier, date } = pierDay(request);
    const out = await store.transaction(async () => {
      const r = repo();
      const day = { pier, from: date, to: date };
      const rows = await r.cashRows(day);
      const pulled = planPull(pier, date, dayTotals(rows, await r.longtail(day), await r.park(day)), rows, () => `pc_${randomUUID()}`, ctx(request));
      for (const row of pulled) await r.putCashRow(row);
      return { rows: pulled, day: await ledger(pier, date) };
    });
    return reply.code(201).send(out);
  });
  app.get('/v1/pier-cash/:pier/days/:date/certificate', async (request) => {
    notForAgents(request);
    const { pier, date } = pierDay(request);
    const raw = query(request).ids;
    const ids = raw === undefined || raw === '' ? undefined : String(raw).split(',').map((x) => x.trim()).filter(Boolean);
    return certificate(pier, date, (await repo().cashSettings()).company_name, await repo().cashRows({ pier, from: date, to: date }), ids);
  });

  app.get('/v1/pier-cash/:pier/months/:month', async (request) => {
    notForAgents(request);
    const pier = parsePier(params(request).pier), month = parseMonth(params(request).month);
    const { from, to } = monthRange(month);
    const r = repo();
    const span = { pier, from, to };
    const { boats } = await boatsBetween(pier, from, to);
    return monthTable(pier, month, openingOf(await r.cashRows({ pier, to: dayBefore(from) })), await r.cashRows(span), await r.longtail(span), await r.park(span),
      boats.map((b) => b.date));
  });
  for (const sheet of ['longtail', 'park'] as const) {
    app.get(`/v1/pier-cash/:pier/months/:month/${sheet}`, async (request) => {
      notForAgents(request);
      const pier = parsePier(params(request).pier), month = parseMonth(params(request).month);
      const only = query(request).date === undefined || query(request).date === '' ? undefined : parseDate(query(request).date);
      if (only && !only.startsWith(month)) bad(`date ${only} is not in ${month}`);
      const { from, to } = only ? { from: only, to: only } : monthRange(month);
      const { boats, names } = await boatsBetween(pier, from, to);
      return sheet === 'longtail'
        ? longtailSheet(pier, month, only, boats, await repo().longtail({ pier, from, to }), names)
        : parkSheet(pier, month, only, boats, await repo().park({ pier, from, to }), names);
    });
  }
  app.patch('/v1/pier-cash/:pier/days/:date/longtail/:boat_id', async (request) => {
    const { pier, date } = pierDay(request);
    const boatId = params(request).boat_id;
    const body = record(request.body);
    return store.transaction(async () => {
      await assertBoat(boatId);
      const key = { pier, date, boat_id: boatId };
      const current = (await repo().longtail({ pier, from: date, to: date })).find((c) => c.boat_id === boatId);
      const next = applyLongtail(current, key, body, ctx(request));
      if (next) await repo().putLongtail(next); else if (current) await repo().deleteLongtail(pier, date, boatId);
      return { ...key, cell: next && longtailView(next) };
    });
  });
  app.patch('/v1/pier-cash/:pier/days/:date/park/:boat_id', async (request) => {
    const { pier, date } = pierDay(request);
    const boatId = params(request).boat_id;
    const body = record(request.body);
    return store.transaction(async () => {
      await assertBoat(boatId);
      const key = { pier, date, boat_id: boatId };
      const current = (await repo().park({ pier, from: date, to: date })).find((c) => c.boat_id === boatId);
      const next = applyPark(current, key, body, ctx(request));
      if (next) await repo().putPark(next); else if (current) await repo().deletePark(pier, date, boatId);
      return { ...key, cell: next && parkView(next) };
    });
  });

  // ── The office lists ──

  app.get('/v1/pier-office', async (request) => {
    notForAgents(request);
    const q = query(request);
    return listsView(await repo().lists(), q.pier === undefined || q.pier === '' ? undefined : parsePier(q.pier));
  });
  const rowOf = <K extends PierList>(lists: { [L in PierList]: PierLists[L][] }, list: K, id: string): PierLists[K] =>
    (lists[list] as PierLists[K][]).find((r) => r.id === id) ?? notFound(`${list} ${id} not found`);
  app.post('/v1/pier-office/:list', async (request, reply) => {
    const list = parseList(params(request).list);
    const body = record(request.body);
    const row = await store.transaction(async () => {
      const made = planCreate(list, body, await repo().lists(), newListId(list, randomUUID().replace(/-/g, '').slice(0, 12)));
      await repo().putListRows(list, [made]);
      return made;
    });
    return reply.code(201).send(row);
  });
  app.patch('/v1/pier-office/:list/:id', async (request) => {
    const list = parseList(params(request).list);
    const body = record(request.body);
    return store.transaction(async () => {
      const lists = await repo().lists();
      const next = planPatch(list, rowOf(lists, list, params(request).id), body, lists);
      await repo().putListRows(list, [next]);
      return next;
    });
  });
  app.delete('/v1/pier-office/:list/:id', async (request) => {
    const list = parseList(params(request).list);
    return store.transaction(async () => {
      const lists = await repo().lists();
      const { id } = rowOf(lists, list, params(request).id);
      const { updates } = planDelete(list, id, lists, { unassignAnyway: yes(query(request).unassign_anyway) });
      if (updates.length) await repo().putListRows('staff', updates);
      await repo().deleteListRow(list, id);
      return { deleted: id, unassigned: updates.map((s) => s.id) };
    });
  });
  app.post('/v1/pier-office/:list/order', async (request) => {
    const list = parseList(params(request).list);
    const body = record(request.body);
    return store.transaction(async () => {
      const lists = await repo().lists();
      const sorts = planOrder(list, body, lists);
      const rows = (lists[list] as { id: string; sort: number }[]).filter((r) => sorts.has(r.id)).map((r) => ({ ...r, sort: sorts.get(r.id)! }));
      await repo().putListRows(list, rows as PierLists[typeof list][]);
      const after = sortLists(await repo().lists());
      const pier = typeof body.pier === 'string' ? body.pier : undefined;
      return { [LIST_KEYS[list]]: (after[list] as { pier?: string }[]).filter((r) => !pier || r.pier === pier) };
    });
  });
}
