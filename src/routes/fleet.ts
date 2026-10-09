/**
 * Fleet maintenance, part B (todo/fleet-maintenance-model.md, "Design — part B", decided 2026-10-09):
 * stock and its movements, consumables, purchase memos, projects, the Daily Fleet Log, safety
 * equipment and the memo spend report.
 *
 * The rules are in `src/domain/fleet-*.ts`. A handler reads what the rule needs, asks it, checks the
 * links it names, and only then writes, all in one transaction: the in-process store does not roll
 * back, so nothing is written before every refusal has had its chance. Who may write is the
 * `preHandler` hook's (`writeNeed` in `users.ts`): `fleet`, and for the Daily Log's extras `fleet` or
 * `operations`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import { actorOf } from '../domain/booking-actions.js';
import { todayInThailand } from '../domain/calendar.js';
import { withoutServerOwned } from '../domain/server-owned.js';
import { addDays, bad, isoDate, notFound, parsePier, record, WAREHOUSES } from '../domain/fleet-common.js';
import type { FleetRepo } from '../domain/fleet-store.js';
import {
  balances, ITEM_SERVER_OWNED, matchesItem, parseConsumableQuery, parseItemListQuery, parseMergeIds, planAdjust, planConsumable, planConsumableVoid, planItemCreate,
  planItemDelete, planItemPatch, planMerge, planReceive as planItemReceive, planTransfer, selectConsumables, sortItems, stockView, supplierList, type Movement, type StockItem,
} from '../domain/fleet-stock.js';
import {
  defaultWarehouse, duplicateNos, MEMO_SERVER_OWNED, memoSpend, memoView, parseMemoListQuery, planApprove, planCancel, planMemoCreate, planMemoPatch, planOrder, planPay,
  planReceive, planShortClose, selectMemos, type Memo, type MemoPlan,
} from '../domain/fleet-memos.js';
import {
  parseProjectListQuery, planBillBack, planCancel as planProjectCancel, planComplete, planDocAdd, planDocDelete, planDocSet, planHold, planPlanAdd, planPlanDelete,
  planPlanSet, planProjectCreate, planProjectPatch, planReopen, planResume, planStart, planVisitAdd, planVisitDelete, planWorkDone, PROJECT_SERVER_OWNED,
  projectView, sortProjects, type Project, type ProjectPlan,
} from '../domain/fleet-projects.js';
import {
  assertDayOpen, dailyLogView, parseBoatDay, parseDate, parseIssues, parsePrices, parseRange, parseWater, pierOfBoat, planExtra, planIssueItemAdd, planIssueItemPatch,
  planRequest, type BoatPier,
} from '../domain/fleet-daily.js';
import {
  planInspectionAdd, planInspectionDelete, planInspectionPatch, planSafetyCreate, planSafetyPatch, SAFETY_CATEGORIES, safetyView,
} from '../domain/fleet-safety.js';

type Request = FastifyRequest;
const param = (request: Request, name = 'id'): string => (request.params as Record<string, string>)[name];
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;

export function registerFleetRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const fleet = (): FleetRepo => store.fleet as FleetRepo;
  const ctx = (request: Request) => ({ now: new Date().toISOString(), today: todayInThailand(), by: actorOf(request.user) ?? null });
  const boatExists = async (id: string): Promise<boolean> => (await store.boatRecord(id)) !== undefined;
  const assertBoat = async (id: string | null | undefined, field = 'boat_id'): Promise<void> => {
    if (id && !(await boatExists(id))) bad(`${field} ${id} is not a boat (GET /v1/boats)`);
  };
  const boatPiers = async (): Promise<BoatPier[]> => (await store.listBoats()).map((b) => ({ id: b.id, pier: b.pier ?? null }));

  // ── Stock ──

  const movementsOf = async (ids: readonly string[]): Promise<Map<string, Movement[]>> => {
    const out = new Map<string, Movement[]>(ids.map((id) => [id, []]));
    for (const m of await fleet().movements({ itemIds: ids })) out.get(m.item_id)?.push(m);
    return out;
  };
  const liveItem = async (id: string): Promise<StockItem> => (await fleet().item(id)) ?? notFound(`Stock item ${id} not found`);
  /** One item as read: its stock, and its movements with those of the items merged into it. */
  const itemDetail = async (id: string) => {
    const item = await liveItem(id);
    const merged = (await fleet().items()).filter((i) => i.merged_into === id).map((i) => i.id);
    const moves = await fleet().movements({ itemIds: [id, ...merged] });
    return { ...stockView(item, moves.filter((m) => m.item_id === id)), movements: moves };
  };

  app.get('/v1/fleet/warehouses', async () => ({ warehouses: WAREHOUSES }));
  app.get('/v1/fleet/stock-items', async (request) => {
    const q = parseItemListQuery(query(request));
    const items = await fleet().items();
    const moves = await movementsOf(items.map((i) => i.id));
    return { items: sortItems(items.map((i) => stockView(i, moves.get(i.id) ?? [])).filter((v) => matchesItem(v, q))) };
  });
  app.get('/v1/fleet/stock-items/:id', async (request) => itemDetail(param(request)));
  app.post('/v1/fleet/stock-items', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const plan = planItemCreate(await fleet().items(), request.body, ctx(request));
    await fleet().putItems([plan.item]);
    await fleet().addMovements(plan.movements);
    return itemDetail(plan.item.id);
  })));
  app.patch('/v1/fleet/stock-items/:id', async (request) => store.transaction(async () => {
    const id = param(request);
    const current = await itemDetail(id);
    const body = withoutServerOwned(record(request.body), current as unknown as Record<string, unknown>, ITEM_SERVER_OWNED);
    const plan = planItemPatch(await liveItem(id), await fleet().items(), body, ctx(request));
    if (plan.movement) { await fleet().putItems([plan.item]); await fleet().addMovements([plan.movement]); }
    return itemDetail(id);
  }));
  app.post('/v1/fleet/stock-items/:id/receive', async (request) => store.transaction(async () => {
    const item = await liveItem(param(request));
    await fleet().addMovements([planItemReceive(item, request.body, ctx(request))]);
    return itemDetail(item.id);
  }));
  app.post('/v1/fleet/stock-items/:id/transfer', async (request) => store.transaction(async () => {
    const item = await liveItem(param(request));
    await fleet().addMovements(planTransfer(item, await fleet().movements({ itemIds: [item.id] }), request.body, ctx(request)));
    return itemDetail(item.id);
  }));
  app.post('/v1/fleet/stock-items/:id/adjust', async (request) => store.transaction(async () => {
    const item = await liveItem(param(request));
    await fleet().addMovements([planAdjust(item, await fleet().movements({ itemIds: [item.id] }), request.body, ctx(request))]);
    return itemDetail(item.id);
  }));
  app.post('/v1/fleet/stock-items/:id/merge', async (request) => store.transaction(async () => {
    const keep = await liveItem(param(request));
    const ids = parseMergeIds(request.body);
    const drops = await Promise.all(ids.map(async (id) => (await fleet().item(id)) ?? bad(`from_ids: stock item ${id} not found`)));
    const moves = await movementsOf(ids);
    const plan = planMerge(keep, drops, (id) => moves.get(id) ?? [], ctx(request));
    await fleet().putItems([plan.keep, ...plan.drops]);
    await fleet().addMovements(plan.movements);
    await fleet().repointMemoLines(ids, keep.id);
    return itemDetail(keep.id);
  }));
  app.delete('/v1/fleet/stock-items/:id', async (request, reply) => {
    await store.transaction(async () => {
      const item = await liveItem(param(request));
      await fleet().putItems([planItemDelete(item, await fleet().movements({ itemIds: [item.id] }), ctx(request))]);
    });
    return reply.code(204).send();
  });
  app.get('/v1/fleet/suppliers', async () => ({
    suppliers: supplierList([...(await fleet().memos()).map((m) => m.supplier), ...(await fleet().items()).map((i) => i.supplier)]),
  }));

  // ── Consumables ──

  app.get('/v1/fleet/consumables', async (request) => {
    const q = parseConsumableQuery(query(request));
    const list = selectConsumables(await fleet().consumables(), q);
    return { consumables: list, total_cost: Math.round(list.reduce((s, c) => s + c.cost, 0) * 100) / 100 };
  });
  app.post('/v1/fleet/consumables', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const body = record(request.body);
    const itemId = typeof (body.item_id ?? body.itemId) === 'string' ? String(body.item_id ?? body.itemId) : '';
    const item = itemId ? await fleet().item(itemId) : undefined;
    const boatId = typeof (body.boat_id ?? body.boatId) === 'string' ? String(body.boat_id ?? body.boatId) : '';
    const boatKnown = boatId ? await boatExists(boatId) : false;
    const plan = planConsumable(item, item ? await fleet().movements({ itemIds: [item.id] }) : [], body, ctx(request), () => boatKnown);
    await fleet().putConsumable(plan.consumable);
    await fleet().addMovements([plan.movement]);
    return plan.consumable;
  })));
  app.delete('/v1/fleet/consumables/:id', async (request, reply) => {
    await store.transaction(async () => {
      const c = (await fleet().consumable(param(request))) ?? notFound(`Consumable ${param(request)} not found`);
      const plan = planConsumableVoid(c, ctx(request));
      await fleet().putConsumable(plan.consumable);
      await fleet().addMovements([plan.movement]);
    });
    return reply.code(204).send();
  });

  // ── Memos ──

  const memoOf = async (id: string): Promise<Memo> => (await fleet().memo(id)) ?? notFound(`Memo ${id} not found`);
  const costs = async () => new Map((await fleet().items()).map((i) => [i.id, i]));
  const memoDetail = async (id: string) => {
    const memo = await memoOf(id);
    const all = await fleet().memos();
    const boat = memo.boat_id ? await store.boatRecord(memo.boat_id) : undefined;
    return {
      ...memoView(memo, { items: await costs(), duplicate: all.filter((m) => m.no === memo.no).length > 1 }),
      default_warehouse: defaultWarehouse(boat && { name: boat.name, pier: boat.pier }),
      history: await fleet().memoHistory(id), receipts: await fleet().memoReceipts(id),
    };
  };
  /** The boat, project and stock items a memo names must exist (new items the plan registers aside). */
  const assertMemoLinks = async (plan: MemoPlan): Promise<void> => {
    await assertBoat(plan.memo.boat_id);
    if (plan.memo.project_id && !(await fleet().project(plan.memo.project_id))) bad(`project_id ${plan.memo.project_id} is not a project (GET /v1/fleet/projects)`);
    const fresh = new Set(plan.items.map((i) => i.id));
    for (const l of plan.memo.lines) if (l.item_id && !fresh.has(l.item_id) && !(await fleet().item(l.item_id))) bad(`lines: stock item ${l.item_id} not found`);
  };
  const saveMemo = async (plan: MemoPlan): Promise<void> => {
    await fleet().putItems(plan.items);
    await fleet().putMemo(plan.memo);
    await fleet().addMovements(plan.movements);
    await fleet().addMemoHistory(plan.history);
    if (plan.receipt) await fleet().addMemoReceipt(plan.receipt);
  };

  app.get('/v1/fleet/memos', async (request) => {
    const q = parseMemoListQuery(query(request));
    const all = await fleet().memos();
    const dups = duplicateNos(all);
    const items = await costs();
    return { memos: selectMemos(all, q).map((m) => memoView(m, { items, duplicate: dups.has(m.no) })) };
  });
  app.get('/v1/fleet/memos/:id', async (request) => memoDetail(param(request)));
  app.post('/v1/fleet/memos', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const memos = await fleet().memos();
    const plan = planMemoCreate(record(request.body), { ...ctx(request), items: await fleet().items(), noTaken: (no) => memos.some((m) => m.no === no) });
    await assertMemoLinks(plan);
    await saveMemo(plan);
    return memoDetail(plan.memo.id);
  })));
  app.patch('/v1/fleet/memos/:id', async (request) => store.transaction(async () => {
    const id = param(request);
    const body = withoutServerOwned(record(request.body), await memoDetail(id) as unknown as Record<string, unknown>, MEMO_SERVER_OWNED);
    const plan = planMemoPatch(await memoOf(id), body, ctx(request));
    await assertMemoLinks(plan);
    await saveMemo(plan);
    return memoDetail(id);
  }));
  const memoCommand = (name: string, run: (memo: Memo, request: Request) => Promise<MemoPlan> | MemoPlan) =>
    app.post(`/v1/fleet/memos/:id/${name}`, async (request) => store.transaction(async () => {
      const plan = await run(await memoOf(param(request)), request);
      await saveMemo(plan);
      return memoDetail(plan.memo.id);
    }));
  memoCommand('approve', (m, r) => planApprove(m, r.body ?? {}, ctx(r)));
  memoCommand('order', (m, r) => planOrder(m, r.body ?? {}, ctx(r)));
  memoCommand('receive', async (m, r) => {
    const boat = m.boat_id ? await store.boatRecord(m.boat_id) : undefined;
    return planReceive(m, r.body ?? {}, { ...ctx(r), items: await fleet().items(), boat: boat && { name: boat.name, pier: boat.pier } });
  });
  memoCommand('short-close', (m, r) => planShortClose(m, ctx(r)));
  memoCommand('pay', (m, r) => planPay(m, r.body ?? {}, ctx(r)));
  memoCommand('cancel', async (m, r) => {
    const memoMovements = await fleet().movements({ memoId: m.id });
    const byItem = await movementsOf([...new Set(memoMovements.map((x) => x.item_id))]);
    return planCancel(m, r.body ?? {}, { ...ctx(r), memoMovements, balanceOf: (id) => balances(byItem.get(id) ?? []), items: await fleet().items() });
  });

  // ── Projects ──

  const projectOf = async (id: string): Promise<Project> => (await fleet().project(id)) ?? notFound(`Project ${id} not found`);
  const projectRead = async (p: Project, memos?: readonly Memo[]) => projectView(p, {
    jobs: await fleet().projectJobs(p.id), memos: (memos ?? await fleet().memos()).filter((m) => m.project_id === p.id), today: todayInThailand(),
  });
  const projectDetail = async (id: string) => {
    const p = await projectOf(id);
    const memos = (await fleet().memos()).filter((m) => m.project_id === id);
    const items = await costs();
    return { ...(await projectRead(p, memos)), log: await fleet().projectLog(id), memos: selectMemos(memos, {}).map((m) => memoView(m, { items, duplicate: false })) };
  };
  const saveProject = async (plan: ProjectPlan, now: string): Promise<void> => {
    await fleet().putProject(plan.project);
    await fleet().addProjectLog(plan.log);
    if (plan.boat) await store.writeBoat(plan.boat, now);
  };
  const boatOf = async (p: Project) => (p.boat_id ? await store.boatRecord(p.boat_id) : undefined);
  const fileRef = async (id: unknown) => {
    if (id === undefined || id === null || id === '') return undefined;
    if (typeof id !== 'string') bad('attachment_id must be an attachment id');
    const ref = (await store.attachmentRefs([id as string])).get(id as string);
    return ref ?? bad(`attachment_id: no attachment ${String(id)}; upload it with POST /v1/attachments first`);
  };

  app.get('/v1/fleet/projects', async (request) => {
    const q = parseProjectListQuery(query(request));
    const memos = await fleet().memos();
    const list = sortProjects((await fleet().projects()).filter((p) => (q.status === undefined || p.status === q.status) && (q.boat_id === undefined || p.boat_id === q.boat_id)));
    return { projects: await Promise.all(list.map((p) => projectRead(p, memos))) };
  });
  app.get('/v1/fleet/projects/:id', async (request) => projectDetail(param(request)));
  app.post('/v1/fleet/projects', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const c = ctx(request);
    const plan = planProjectCreate(record(request.body), c);
    await assertBoat(plan.project.boat_id);
    await saveProject(plan, c.now);
    return projectDetail(plan.project.id);
  })));
  app.patch('/v1/fleet/projects/:id', async (request) => store.transaction(async () => {
    const c = ctx(request);
    const id = param(request);
    const body = withoutServerOwned(record(request.body), await projectDetail(id) as unknown as Record<string, unknown>, PROJECT_SERVER_OWNED);
    const plan = planProjectPatch(await projectOf(id), body, c);
    await assertBoat(plan.project.boat_id);
    await saveProject(plan, c.now);
    return projectDetail(id);
  }));
  const projectCommand = (path: string, run: (p: Project, request: Request, c: ReturnType<typeof ctx>) => Promise<ProjectPlan> | ProjectPlan) =>
    app.post(`/v1/fleet/projects/:id/${path}`, async (request) => store.transaction(async () => {
      const c = ctx(request);
      const plan = await run(await projectOf(param(request)), request, c);
      await saveProject(plan, c.now);
      return projectDetail(plan.project.id);
    }));
  projectCommand('start', async (p, _r, c) => planStart(p, await boatOf(p), c));
  projectCommand('hold', (p, r, c) => planHold(p, r.body, c));
  projectCommand('resume', (p, _r, c) => planResume(p, c));
  projectCommand('cancel', async (p, r, c) => planProjectCancel(p, r.body, await boatOf(p), c));
  projectCommand('reopen', (p, _r, c) => planReopen(p, c));
  projectCommand('work-done', async (p, r, c) => planWorkDone(p, r.body, await boatOf(p), await fleet().projectJobs(p.id), c));
  projectCommand('bill-back', async (p, _r, c) => planBillBack(p, await boatOf(p), c));
  projectCommand('complete', async (p, r, c) => planComplete(p, r.body, await boatOf(p), await fleet().projectJobs(p.id), c));
  projectCommand('plan', (p, r, c) => planPlanAdd(p, r.body, c));
  projectCommand('vendor-visits', (p, r, c) => planVisitAdd(p, r.body, c));
  projectCommand('documents', async (p, r, c) => {
    const body = record(r.body);
    return planDocAdd(p, body, await fileRef(body.attachment_id ?? body.attId), c);
  });
  const projectSub = (method: 'patch' | 'delete', path: string, run: (p: Project, request: Request, c: ReturnType<typeof ctx>) => Promise<ProjectPlan> | ProjectPlan) =>
    app[method](`/v1/fleet/projects/:id/${path}`, async (request) => store.transaction(async () => {
      const c = ctx(request);
      const plan = await run(await projectOf(param(request)), request, c);
      await saveProject(plan, c.now);
      return projectDetail(plan.project.id);
    }));
  projectSub('patch', 'plan/:item_id', (p, r, c) => planPlanSet(p, param(r, 'item_id'), r.body, c));
  projectSub('delete', 'plan/:item_id', (p, r, c) => planPlanDelete(p, param(r, 'item_id'), c));
  projectSub('delete', 'vendor-visits/:visit_id', (p, r, c) => planVisitDelete(p, param(r, 'visit_id'), c));
  projectSub('patch', 'documents/:doc_id', async (p, r, c) => {
    const body = record(r.body);
    return planDocSet(p, param(r, 'doc_id'), body, await fileRef(body.attachment_id ?? body.attId), c);
  });
  /**
   * Taking a document off also deletes its uploaded file, as legacy's `flProjDeleteDoc` does, unless
   * a booking or another project still names it.
   */
  app.delete('/v1/fleet/projects/:id/documents/:doc_id', async (request) => store.transaction(async () => {
    const c = ctx(request);
    const plan = planDocDelete(await projectOf(param(request)), param(request, 'doc_id'), c);
    await saveProject(plan, c.now);
    const file = plan.removed.attachment_id;
    if (file && !(await fleet().attachmentProjects(file)).length && !(await store.attachmentBookings(file)).length) await store.deleteAttachment(file);
    return projectDetail(plan.project.id);
  }));

  // ── Daily Fleet Log ──

  /** One day as `GET /v1/fleet/daily-log` shows it. */
  const dayRead = async (date: string) => {
    const boats = await boatPiers();
    const view = dailyLogView({ from: date, to: date }, await fleet().daily(date, date), await fleet().fuelPrices(addDays(date, -31), date), boats, await fleet().issueItems());
    return (view.days[0] as object | undefined) ?? { date, boats: [], fuel_prices: {}, locks: {}, requests: {} };
  };
  const openDay = async (date: string, pier: string | null): Promise<void> => assertDayOpen((await fleet().daily(date, date)).locks, date, pier);
  /** A boat's row: the boat must exist; its pier's day must not be locked. */
  const boatDay = async (request: Request): Promise<{ date: string; boatId: string }> => {
    const date = parseDate(param(request, 'date'));
    const boatId = param(request, 'boat_id');
    if (!(await boatExists(boatId))) notFound(`Boat ${boatId} not found`);
    await openDay(date, pierOfBoat(await boatPiers(), boatId));
    return { date, boatId };
  };
  const pierDay = async (request: Request): Promise<{ date: string; pier: string }> => {
    const date = parseDate(param(request, 'date'));
    const pier = parsePier(param(request, 'pier'));
    return { date, pier };
  };

  app.get('/v1/fleet/daily-log', async (request) => {
    const range = parseRange(query(request));
    return dailyLogView(range, await fleet().daily(range.from, range.to), await fleet().fuelPrices(addDays(range.from, -31), range.to), await boatPiers(), await fleet().issueItems());
  });
  app.patch('/v1/fleet/daily-log/:date/boats/:boat_id', async (request) => store.transaction(async () => {
    const input = parseBoatDay(request.body);
    const { date, boatId } = await boatDay(request);
    const c = ctx(request);
    if (input.fuel_litres !== undefined || input.pax_actual !== undefined) {
      const was = (await fleet().daily(date, date)).boats.find((b) => b.boat_id === boatId);
      await fleet().putDailyBoat({
        date, boat_id: boatId, fuel_litres: input.fuel_litres !== undefined ? input.fuel_litres : was?.fuel_litres ?? null,
        pax_actual: input.pax_actual !== undefined ? input.pax_actual : was?.pax_actual ?? null, updated_at: c.now, updated_by: c.by,
      });
    }
    for (const m of input.meters ?? []) await fleet().putMeter({ date, boat_id: boatId, ...m });
    return dayRead(date);
  }));
  app.put('/v1/fleet/daily-log/:date/boats/:boat_id/water', async (request) => store.transaction(async () => {
    const w = parseWater(request.body);
    const { date, boatId } = await boatDay(request);
    const c = ctx(request);
    await fleet().putWater({ date, boat_id: boatId, ...w, by: c.by, at: c.now });
    return dayRead(date);
  }));
  app.put('/v1/fleet/daily-log/:date/boats/:boat_id/issues', async (request) => store.transaction(async () => {
    const rows = parseIssues(request.body, await fleet().issueItems());
    const { date, boatId } = await boatDay(request);
    for (const r of rows) await fleet().putIssue({ date, boat_id: boatId, ...r });
    return dayRead(date);
  }));
  app.post('/v1/fleet/daily-log/:date/boats/:boat_id/extras', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const { date, boatId } = await boatDay(request);
    await fleet().putExtra(planExtra(request.body, date, boatId));
    return dayRead(date);
  })));
  const extraOf = async (request: Request) => {
    const { date, boatId } = await boatDay(request);
    const x = await fleet().extra(param(request, 'extra_id'));
    if (!x || x.date !== date || x.boat_id !== boatId) notFound(`Extra item ${param(request, 'extra_id')} not found on ${boatId} ${date}`);
    return x!;
  };
  app.put('/v1/fleet/daily-log/:date/boats/:boat_id/extras/:extra_id', async (request) => store.transaction(async () => {
    const x = await extraOf(request);
    await fleet().putExtra(planExtra(request.body, x.date, x.boat_id, x.id));
    return dayRead(x.date);
  }));
  app.delete('/v1/fleet/daily-log/:date/boats/:boat_id/extras/:extra_id', async (request) => store.transaction(async () => {
    const x = await extraOf(request);
    await fleet().deleteExtra(x.id);
    return dayRead(x.date);
  }));
  app.post('/v1/fleet/daily-log/:date/piers/:pier/requests', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const { date, pier } = await pierDay(request);
    await openDay(date, pier);
    await fleet().putRequest(planRequest(request.body, date, pier, await fleet().issueItems()));
    return dayRead(date);
  })));
  const requestOf = async (request: Request) => {
    const { date, pier } = await pierDay(request);
    await openDay(date, pier);
    const x = await fleet().request(param(request, 'request_id'));
    if (!x || x.date !== date || x.pier !== pier) notFound(`Request ${param(request, 'request_id')} not found on ${pier} ${date}`);
    return x!;
  };
  app.put('/v1/fleet/daily-log/:date/piers/:pier/requests/:request_id', async (request) => store.transaction(async () => {
    const x = await requestOf(request);
    await fleet().putRequest(planRequest(request.body, x.date, x.pier, await fleet().issueItems(), x.id));
    return dayRead(x.date);
  }));
  app.delete('/v1/fleet/daily-log/:date/piers/:pier/requests/:request_id', async (request) => store.transaction(async () => {
    const x = await requestOf(request);
    await fleet().deleteRequest(x.id);
    return dayRead(x.date);
  }));
  app.put('/v1/fleet/daily-log/:date/fuel-prices', async (request) => store.transaction(async () => {
    const date = parseDate(param(request, 'date'));
    const boats = await boatPiers();
    const prices = parsePrices(request.body, new Set(boats.map((b) => b.id)));
    const locks = (await fleet().daily(date, date)).locks;
    for (const p of prices) assertDayOpen(locks, date, boats.some((b) => b.id === p.key) ? pierOfBoat(boats, p.key) : p.key);
    for (const p of prices) await fleet().putFuelPrice(date, p.key, p.price);
    return dayRead(date);
  }));
  app.post('/v1/fleet/daily-log/:date/piers/:pier/lock', async (request) => store.transaction(async () => {
    const { date, pier } = await pierDay(request);
    const c = ctx(request);
    await fleet().putLock({ date, pier, locked_at: c.now, locked_by: c.by });
    return dayRead(date);
  }));
  app.post('/v1/fleet/daily-log/:date/piers/:pier/unlock', async (request) => store.transaction(async () => {
    const { date, pier } = await pierDay(request);
    await fleet().deleteLock(date, pier);
    return dayRead(date);
  }));
  app.get('/v1/fleet/issue-items', async () => ({ items: await fleet().issueItems() }));
  app.post('/v1/fleet/issue-items', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const item = planIssueItemAdd(await fleet().issueItems(), request.body);
    await fleet().putIssueItem(item);
    return item;
  })));
  app.patch('/v1/fleet/issue-items/:id', async (request) => store.transaction(async () => {
    const item = planIssueItemPatch(await fleet().issueItems(), param(request), request.body);
    await fleet().putIssueItem(item);
    return item;
  }));

  // ── Safety equipment ──

  const safetyOf = async (id: string) => (await fleet().safetyItem(id)) ?? notFound(`Safety item ${id} not found`);
  const safetyDetail = async (id: string) => safetyView(await safetyOf(id), todayInThailand(), await fleet().safetyLog(id));
  app.get('/v1/fleet/safety-categories', async () => ({ categories: Object.entries(SAFETY_CATEGORIES).map(([id, c]) => ({ id, ...c })) }));
  app.get('/v1/fleet/safety', async (request) => {
    const q = query(request);
    const today = todayInThailand();
    const list = (await fleet().safetyItems()).filter((i) => (typeof q.boat_id !== 'string' || i.boat_id === q.boat_id) && (typeof q.category !== 'string' || i.category === q.category))
      .sort((a, b) => a.boat_id.localeCompare(b.boat_id, 'en', { numeric: true }) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    return { items: list.map((i) => safetyView(i, today)) };
  });
  app.get('/v1/fleet/safety/:id', async (request) => safetyDetail(param(request)));
  app.post('/v1/fleet/safety', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const plan = planSafetyCreate(record(request.body), ctx(request));
    await assertBoat(plan.item.boat_id);
    await fleet().putSafety(plan.item);
    await fleet().addSafetyLog([plan.log]);
    return safetyDetail(plan.item.id);
  })));
  app.patch('/v1/fleet/safety/:id', async (request) => store.transaction(async () => {
    const id = param(request);
    const body = withoutServerOwned(record(request.body), await safetyDetail(id) as unknown as Record<string, unknown>,
      { id: 'a safety item keeps its id', state: 'it is computed', inspections: 'use /v1/fleet/safety/{id}/inspections', log: 'it is written by every change', created_at: 'it is set at creation', updated_at: 'it is set by every write' });
    const plan = planSafetyPatch(await safetyOf(id), body, ctx(request));
    await assertBoat(plan.item.boat_id);
    await fleet().putSafety(plan.item);
    await fleet().addSafetyLog([plan.log]);
    return safetyDetail(id);
  }));
  app.delete('/v1/fleet/safety/:id', async (request, reply) => {
    await store.transaction(async () => { await safetyOf(param(request)); await fleet().deleteSafety(param(request)); });
    return reply.code(204).send();
  });
  app.post('/v1/fleet/safety/:id/inspections', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const plan = planInspectionAdd(await safetyOf(param(request)), request.body, ctx(request));
    await fleet().putSafety(plan.item);
    await fleet().addSafetyLog([plan.log]);
    return safetyDetail(plan.item.id);
  })));
  app.patch('/v1/fleet/safety/:id/inspections/:insp_id', async (request) => store.transaction(async () => {
    await fleet().putSafety(planInspectionPatch(await safetyOf(param(request)), param(request, 'insp_id'), request.body, ctx(request)));
    return safetyDetail(param(request));
  }));
  app.delete('/v1/fleet/safety/:id/inspections/:insp_id', async (request) => store.transaction(async () => {
    await fleet().putSafety(planInspectionDelete(await safetyOf(param(request)), param(request, 'insp_id'), ctx(request)));
    return safetyDetail(param(request));
  }));

  // ── Reports ──

  app.get('/v1/fleet/reports/memo-spend', async (request) => {
    const q = query(request);
    const from = isoDate(q.from, 'from') ?? undefined;
    const to = isoDate(q.to, 'to') ?? undefined;
    if (from && to && to < from) bad('to must not precede from');
    return memoSpend(await fleet().memos(), from, to);
  });
}
