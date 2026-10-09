/**
 * Fleet maintenance, the extras (todo/fleet-maintenance-model.md, "Design — extras"): a boat's pier
 * assignments, its certificates' expiry and renewal, the safety replace wizard, the monthly fuel budget,
 * the reports (cost analytics, upkeep, fuel intelligence, the dashboard) and the repair history.
 *
 * The rules are in `src/domain/fleet-assignments.ts`, `fleet-certificates.ts`, `fleet-replace.ts` and
 * `fleet-reports.ts`. Writes on a boat (`/v1/boats/{id}/assignments`, `/documents/renew`) need `fleet` or
 * `config`; the rest under `/v1/fleet/` `fleet` (`writeNeed` in `users.ts`). Reads are any login's.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import { actorOf } from '../domain/booking-actions.js';
import { eachDate, todayInThailand } from '../domain/calendar.js';
import type { BoatRecord } from '../domain/catalogue.js';
import { bad, isoDate, notFound, number, record } from '../domain/fleet-common.js';
import { assignmentPanels, assignmentView, planAssignment, planAssignmentCancel, sortAssignments, pierOn } from '../domain/fleet-assignments.js';
import { certificateMatrix, documentsView, renewedDocuments } from '../domain/fleet-certificates.js';
import { planReplace } from '../domain/fleet-replace.js';
import { safetyView } from '../domain/fleet-safety.js';
import { stockView, type Movement } from '../domain/fleet-stock.js';
import { bookedOn, prevMeters, type Booked } from '../domain/fleet-daily.js';
import { availability } from '../domain/fleet-availability.js';
import { COST_PERIODS, costReport, dashboard, fuelReport, monthsEnding, repairHistory, revenueByFamily, upkeepReport, type CostPeriod } from '../domain/fleet-reports.js';
import type { FleetRepo } from '../domain/fleet-store.js';
import { hoursLoader, memosLoader, openWork } from './fleet.js';

type Request = FastifyRequest;
const param = (request: Request, name = 'id'): string => (request.params as Record<string, string>)[name];
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthParam = (v: unknown, today: string): string => (v === undefined || v === '' ? today.slice(0, 7) : typeof v === 'string' && MONTH.test(v) ? v : bad('month must be YYYY-MM'));
const lastDay = (month: string): string => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

export function registerFleetExtrasRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const fleet = (): FleetRepo => store.fleetRepo as FleetRepo;
  const ctx = (request: Request) => ({ now: new Date().toISOString(), today: todayInThailand(), by: actorOf(request.user) ?? null });
  const boatOf = async (id: string): Promise<BoatRecord> => (await store.boatRecord(id)) ?? notFound('Boat not found');
  const boatLite = (b: BoatRecord) => ({ id: b.id, name: b.name, pier: b.pier, ownership: b.ownership, retired: b.retired, capacity: b.capacity });

  // ── Pier assignments (legacy `flSaveAssignment`, `flCancelAssignment`) ──

  const assignmentsRead = async (boat: BoatRecord) => {
    const today = todayInThailand();
    const list = await fleet().assignments(boat.id);
    return { assignments: sortAssignments(list).reverse().map((a) => assignmentView(a, today)), ...assignmentPanels(list, boat.id, today), pier_today: pierOn(boat, today, list) };
  };
  app.get('/v1/boats/:id/assignments', async (request) => assignmentsRead(await boatOf(param(request))));
  app.post('/v1/boats/:id/assignments', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const c = ctx(request);
    const boat = await boatOf(param(request));
    const plan = planAssignment(boat, request.body, c);
    await fleet().putAssignment(plan.assignment);
    // A permanent move active today changes the home pier, as legacy's form does.
    if (plan.boat_pier !== boat.pier) await store.writeBoat({ ...boat, pier: plan.boat_pier }, c.now);
    return { assignment: assignmentView(plan.assignment, c.today), boat_pier: plan.boat_pier };
  })));
  app.post('/v1/boats/:id/assignments/:asn_id/cancel', async (request) => store.transaction(async () => {
    const c = ctx(request);
    const boat = await boatOf(param(request));
    const a = await fleet().assignment(param(request, 'asn_id'));
    if (!a || a.boat_id !== boat.id) notFound(`Assignment ${param(request, 'asn_id')} not found on ${boat.name}`);
    const next = planAssignmentCancel(a!, c);
    await fleet().putAssignment(next);
    return assignmentView(next, c.today);
  }));

  // ── Certificates (legacy `flRenderDocsList`, `depSave`) ──

  app.get('/v1/fleet/certificates', async () => certificateMatrix(await store.boatRecords(), todayInThailand()));
  app.get('/v1/boats/:id/documents', async (request) => ({ documents: documentsView((await boatOf(param(request))).documents, todayInThailand()) }));
  app.post('/v1/boats/:id/documents/renew', async (request) => store.transaction(async () => {
    const c = ctx(request);
    const boat = await boatOf(param(request));
    const documents = renewedDocuments(boat.documents, request.body);
    const saved = await store.writeBoat({ ...boat, documents }, c.now);
    return { documents: documentsView(saved.documents, c.today) };
  }));

  // ── The safety replace wizard (legacy `swapDocExecute`) ──

  app.post('/v1/fleet/safety/:id/replace', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const c = ctx(request);
    const old = (await fleet().safetyItem(param(request))) ?? notFound(`Safety item ${param(request)} not found`);
    const boat = await store.boatRecord(old.boat_id) ?? bad(`${old.name} is on boat ${old.boat_id}, which is not a boat`);
    const b = record(request.body);
    const found = typeof b.item_id === 'string' && b.item_id ? await fleet().item(b.item_id) : undefined;
    const item = found && !found.deleted_at && !found.merged_into ? found : undefined;
    const memos = await fleet().memos();
    const plan = planReplace(old, b, {
      ...c, boat: { id: boat.id, name: boat.name, pier: boat.pier }, stock: { item, movements: item ? await fleet().movements({ itemIds: [item.id] }) : [] },
      incidents: await store.fleetNumbers('incidents'), jobs: await store.fleetNumbers('jobs'), memoNoTaken: (no) => memos.some((m) => m.no === no), items: await fleet().items(),
    });
    await fleet().putItems([...plan.items, ...(plan.memo?.items ?? [])]);
    if (plan.memo) { await fleet().putMemo(plan.memo.memo); await fleet().addMemoHistory(plan.memo.history); }
    await fleet().addMovements([...plan.movements, ...(plan.memo?.movements ?? [])]);
    await store.putFleetIncident(plan.incident);
    await store.putFleetJob(plan.job);
    await fleet().putSafety(plan.old_item);
    await fleet().putSafety(plan.new_item);
    await fleet().addSafetyLog(plan.logs);
    const withdrawn = item ? stockView(item, await fleet().movements({ itemIds: [item.id] })) : null;
    return {
      incident: plan.incident, job: plan.job, memo: plan.memo?.memo ?? null, withdrawn_item: withdrawn,
      old_item: safetyView(plan.old_item, c.today, await fleet().safetyLog(plan.old_item.id)), new_item: safetyView(plan.new_item, c.today, await fleet().safetyLog(plan.new_item.id)),
    };
  })));

  // ── The monthly fuel budget (legacy `fuelSetBudget`, kept in one browser) ──

  app.get('/v1/fleet/fuel-budgets', async () => ({ budgets: (await fleet().fuelBudgets()).sort((a, b) => b.month.localeCompare(a.month)) }));
  app.put('/v1/fleet/fuel-budgets/:month', async (request) => store.transaction(async () => {
    const c = ctx(request);
    const month = param(request, 'month');
    if (!MONTH.test(month)) bad('month must be YYYY-MM');
    const b = request.body === undefined || request.body === null ? {} : record(request.body);
    const raw = number(b.amount, 'amount');
    if (raw !== null && raw <= 0) bad('amount must be more than 0, or null to remove the budget');
    const budget = raw === null ? null : { month, amount: Math.round(raw * 100) / 100, set_at: c.now, set_by: c.by };
    await fleet().putFuelBudget(month, budget);
    return { month, amount: budget?.amount ?? null, set_at: budget?.set_at ?? null, set_by: budget?.set_by ?? null };
  }));

  // ── Reports ──

  app.get('/v1/fleet/reports/cost', async (request) => {
    const p = query(request).period ?? 'all';
    if (!(COST_PERIODS as readonly unknown[]).includes(p)) bad(`period must be one of ${COST_PERIODS.join(', ')}`);
    return costReport({
      jobs: await store.fleetJobs({}), memos: await fleet().memos(), memosOf: await memosLoader(store), boats: (await store.boatRecords()).map(boatLite),
      today: todayInThailand(), period: p as CostPeriod,
    });
  });
  app.get('/v1/fleet/reports/upkeep', async (request) => upkeepReport({
    month: monthParam(query(request).month, todayInThailand()), consumables: await fleet().consumables(), jobs: await store.fleetJobs({}),
    memosOf: await memosLoader(store), boats: (await store.boatRecords()).map(boatLite),
  }));
  app.get('/v1/fleet/reports/fuel', async (request) => {
    const today = todayInThailand();
    const month = monthParam(query(request).month, today);
    const from = `${monthsEnding(month, 6)[0]}-01`, to = lastDay(month);
    const daily = await fleet().daily(from, to);
    // Booked pax for every day the log has a boat, and the month's bookings for revenue.
    const dates = new Set([...daily.boats.map((d) => d.date), ...eachDate(`${month}-01`, to)]);
    const bookings = new Map<string, Awaited<ReturnType<typeof store.bookingsOnDate>>>();
    for (const date of [...dates].sort()) bookings.set(date, await store.bookingsOnDate(date));
    const booked = new Map<string, Map<string, Booked>>([...bookings].map(([date, list]) => [date, bookedOn(list, date)]));
    const monthBookings = new Map([...bookings].filter(([d]) => d.startsWith(month)).flatMap(([, list]) => list.map((b) => [b.id, b] as const)));
    const routes = new Map((await store.listRoutes()).map((r) => [r.id, r]));
    const families = new Map((await store.listRouteFamilies()).map((f) => [f.id, f]));
    const familyOf = (rid: string) => {
      const r = routes.get(rid);
      const f = r?.family_id ? families.get(r.family_id) : undefined;
      return f ? { id: f.id, name: f.name } : { id: rid, name: r?.name ?? rid };
    };
    const budget = (await fleet().fuelBudgets()).find((b) => b.month === month)?.amount ?? null;
    return fuelReport({
      month, today, boats: (await store.boatRecords()).map(boatLite), daily: daily.boats, meters: daily.meters, prices: await fleet().fuelPrices(from, to),
      prevMeter: prevMeters(await fleet().engineMeters()), engines: (await store.fleetAssets('engine')).map((e) => ({ id: e.id, boat_id: e.boat_id })),
      booked: (date) => booked.get(date) ?? new Map(), familyOf, routeName: (rid) => routes.get(rid)?.name ?? rid,
      revenue: revenueByFamily([...monthBookings.values()], month, familyOf), budget,
    });
  });
  app.get('/v1/fleet/dashboard', async (request) => {
    const today = todayInThailand();
    const date = isoDate(query(request).date, 'date') ?? today;
    const boats = await store.boatRecords();
    const assignments = await fleet().assignments();
    const work = await openWork(store);
    const hoursOf = await hoursLoader(store);
    const items = await fleet().items();
    const moves = new Map<string, Movement[]>(items.map((i) => [i.id, []]));
    for (const m of await fleet().movements({ itemIds: items.map((i) => i.id) })) moves.get(m.item_id)?.push(m);
    return dashboard({
      date, today,
      boats: boats.map((b) => {
        const s = availability(b, today, work).status;
        return { ...boatLite(b), pier_on_date: pierOn(b, date, assignments), blocked: s === 'fixing' || s === 'unavailable' };
      }),
      jobs: await store.fleetJobs({}), incidents: await store.fleetIncidents({}), memos: await fleet().memos(), memosOf: await memosLoader(store),
      engines: (await store.fleetAssets('engine')).map((e) => ({ id: e.id, boat_id: e.boat_id, model: e.model, brand: e.brand, hours: hoursOf(e) })),
      gearboxes: await store.fleetAssets('gearbox'), propellers: await store.fleetAssets('propeller'),
      stock: items.map((i) => stockView(i, moves.get(i.id) ?? [])),
    });
  });

  // ── Repair history: computed from the boat's done jobs (legacy `boats.repairHistory`) ──

  app.get('/v1/fleet/repair-history', async (request) => {
    const boatId = query(request).boat_id;
    if (typeof boatId !== 'string' || !boatId) bad('boat_id is required');
    const boat = await boatOf(boatId as string);
    return { boat_id: boat.id, repairs: repairHistory(await store.fleetJobs({ boatId: boat.id }), await memosLoader(store), boat.id) };
  });
}
