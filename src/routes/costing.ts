/**
 * The cost model, trip actuals and Trip P&L (todo/money-model.md, "Design: the rest of Money",
 * decided 2026-10-10): legacy's costing menu (template, plans, rented boats, restaurants), the pier's
 * meal order, and the computed P&L of each boat's day with close and "ran empty".
 *
 * The rules are in `src/domain/costing.ts` and `src/domain/trip-pl.ts`; rows live in `store.moneyRepo`.
 * A handler reads what the rule needs, asks it, and writes what it answers in one transaction. Who may
 * write is the `preHandler` hook's (`writeNeed` in `users.ts`).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import type { Booking } from '../domain/operations.js';
import { actorOf, refuse } from '../domain/booking-actions.js';
import { isIsoDate, todayInThailand } from '../domain/calendar.js';
import { addDays } from '../domain/fleet-common.js';
import { effectiveFuelPrice } from '../domain/fleet-daily.js';
import {
  applyPlanFields, applyRentFields, applyVenueFields, blankPlan, blankRent, blankVenue, droppedOf, effectiveTemplate, parseTemplate, planView, rentBook, rentView,
  templateView, type CostPlan,
} from '../domain/costing.js';
import {
  blankActual, bundleApplies, closeTrip, dailyLongtail, dayPL, markRan, mealPreview, reopenTrip, sendMealOrder, setOvernightMeal, tripPL, unmarkRan,
  type BoatInfo, type BundleOf, type PlDay, type TripActual,
} from '../domain/trip-pl.js';

type Request = FastifyRequest;
const bad = (message: string): never => refuse(message, 400);
const notFound = (message: string): never => refuse(message, 404);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad('Request body must be an object'));
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
const params = (request: Request): Record<string, string> => (request.params ?? {}) as Record<string, string>;
const dateOf = (v: unknown, name = 'date'): string => (typeof v === 'string' && isIsoDate(v) ? v : bad(`${name} must be YYYY-MM-DD`));
const shortId = (prefix: string): string => `${prefix}${randomBytes(4).toString('hex')}`;

/** Whether each booking's rate type bundles a longtail on a route (legacy `bkV2AddOnFlags`'s last step). */
export async function bundleOf(store: Store, bookings: readonly Booking[]): Promise<BundleOf> {
  const agents = new Map((await store.agentRecords()).map((a) => [a.id, a.rate_type_id]));
  const ids = new Set<string>();
  const rtOf = (b: Booking) => b.rate_type_ref || (b.agent_id ? agents.get(b.agent_id) : null) || null;
  for (const b of bookings) { const id = rtOf(b); if (id) ids.add(id); }
  const bundles = new Map<string, Map<string, string | null>>();
  for (const id of ids) {
    const rt = await store.rateType(id);
    if (rt) bundles.set(id, new Map(rt.routes.filter((r) => r.longtail_bundle).map((r) => [r.route_id, r.longtail_bundle!.applies_to])));
  }
  return (b, routeId, charterTrip) => {
    const id = rtOf(b), m = id ? bundles.get(id) : undefined;
    return !!m && m.has(routeId) && bundleApplies(m.get(routeId), charterTrip);
  };
}

/** The Daily Report's longtail cost (legacy `drData` §drReal), for `GET /v1/reports/daily`. */
export async function dailyLongtailFor(store: Store, date: string, bookings: readonly Booking[]) {
  const stored = await store.moneyRepo.template();
  return dailyLongtail(date, bookings, {
    sales: await store.tourSales(bookings.map((b) => b.id)), bundle: await bundleOf(store, bookings), template: effectiveTemplate(stored, stored ? droppedOf(stored.lines) : []),
    plans: await store.moneyRepo.plans(), routes: new Map((await store.listRoutes()).map((r) => [r.id, r])),
  });
}

export function registerCostingRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const repo = () => store.moneyRepo;
  const by = (request: Request): string | null => actorOf(request.user) ?? null;
  const now = () => new Date().toISOString();
  /** Costing and P&L are staff screens: a login tied to one agent reads none of them. */
  const staffOnly = (request: Request): void => {
    if (request.user?.user?.agent_id) refuse('This login books for its agent and sees no costing', 403, 'forbidden');
  };

  // ── Reading what the rules need ──
  const template = async () => { const t = await repo().template(); return effectiveTemplate(t, t ? droppedOf(t.lines) : []); };
  const boatList = async () => (await store.boatRecords()).map((b): BoatInfo => ({ id: b.id, name: b.name, pier: b.pier, engine_count: b.engine_count, capacity: b.capacity }));
  const rentsBook = async (boats?: BoatInfo[]) => rentBook(await repo().rents(), boats ?? await boatList());
  const routeKeys = async () => new Set([...(await store.listRoutes()).flatMap((r) => [r.id, ...(r.family_id ? [r.family_id] : [])]), ...(await store.listRouteFamilies()).map((f) => f.id)]);

  /** What one day's P&L reads; `shared` is what a month's days have in common. */
  const shared = async () => {
    const boats = await boatList();
    return {
      boats, boatMap: new Map(boats.map((b) => [b.id, b])), routes: new Map((await store.listRoutes()).map((r) => [r.id, r])),
      template: await template(), plans: await repo().plans(), rents: await rentsBook(boats), venues: new Map((await repo().venues()).map((v) => [v.id, v])),
      vans: new Map((await store.listVans()).map((v) => [v.id, v])), rates: await store.vanRates(), areas: new Map((await store.listPickupAreas()).map((a) => [a.id, a])),
    };
  };
  type Shared = Awaited<ReturnType<typeof shared>>;
  const plDay = async (date: string, s: Shared, prices?: Awaited<ReturnType<typeof store.fleetRepo.fuelPrices>>): Promise<PlDay> => {
    const bookings = await store.bookingsOnDate(date);
    const fleet = await store.fleetRepo.daily(date, date);
    const allPrices = prices ?? await store.fleetRepo.fuelPrices(addDays(date, -31), date);
    const boatPiers = s.boats.map((b) => ({ id: b.id, pier: b.pier }));
    return {
      date, deployments: await store.listDeployments(date, date), routes: s.routes, boats: s.boatMap, bookings, sales: await store.tourSales(bookings.map((b) => b.id)),
      template: s.template, plans: s.plans, rents: s.rents, venues: s.venues,
      actuals: new Map((await repo().tripActuals(date, date)).map((a) => [a.boat_id, a])),
      fuelLitres: (boatId) => fleet.boats.find((r) => r.boat_id === boatId)?.fuel_litres ?? null,
      fuelPrice: (boatId) => effectiveFuelPrice(allPrices, { id: boatId, pier: s.boatMap.get(boatId)?.pier ?? null }, boatPiers, date),
      vans: s.vans, rates: s.rates, areas: s.areas, bundle: await bundleOf(store, bookings),
    };
  };
  const boatParam = async (request: Request): Promise<{ date: string; boatId: string }> => {
    const date = dateOf(params(request).date), boatId = params(request).boat_id;
    if (!(await store.boatRecords()).some((b) => b.id === boatId)) notFound(`Boat ${boatId} not found`);
    return { date, boatId };
  };

  // ── The cost template (legacy `cost_template`) ──
  app.get('/v1/costing/template', async (request) => { staffOnly(request); return templateView(await repo().template()); });
  app.put('/v1/costing/template', async (request) => {
    const t = parseTemplate(request.body);
    await store.transaction(async () => { await repo().putTemplate({ ...t, updated_at: now(), updated_by: by(request) }); });
    return templateView(await repo().template());
  });

  // ── Plans (legacy `cost_plans`) ──
  const plansView = async (pax?: number) => {
    const T = await template(), boats = await boatList(), rents = await rentsBook(boats), seats = new Map(boats.map((b) => [b.id, b]));
    return (await repo().plans()).map((p) => planView(p, T, rents, seats, pax));
  };
  const planOf = async (id: string): Promise<CostPlan> => (await repo().plan(id)) ?? notFound(`Cost plan ${id} not found`);
  const onePlan = async (id: string, pax?: number) => {
    const p = await planOf(id), boats = await boatList();
    return planView(p, await template(), await rentsBook(boats), new Map(boats.map((b) => [b.id, b])), pax);
  };
  app.get('/v1/costing/plans', async (request) => { staffOnly(request); return { plans: await plansView() }; });
  app.get('/v1/costing/plans/:id', async (request) => {
    staffOnly(request);
    const raw = query(request).pax;
    const pax = raw === undefined || raw === '' ? undefined : Number(raw);
    if (pax !== undefined && (!Number.isInteger(pax) || pax < 0 || pax > 1000)) bad('pax must be a whole number from 0 to 1000');
    return onePlan(params(request).id, pax);
  });
  app.post('/v1/costing/plans', async (request, reply) => {
    const body = record(request.body ?? {});
    const id = await store.transaction(async () => {
      const plans = await repo().plans();
      const sort = plans.reduce((m, p) => Math.max(m, p.sort), -1) + 1;
      let plan: CostPlan;
      const { copy_of: copyOf, ...fields } = body;
      if (copyOf !== undefined) {
        const src = plans.find((p) => p.id === copyOf) ?? notFound(`Cost plan ${String(copyOf)} not found`);
        plan = { ...structuredClone(src), id: shortId('p'), sort, name: `${src.name} (คัดลอก)`, updated_at: now(), updated_by: by(request) };
      } else plan = blankPlan(shortId('p'), 'แผนใหม่', sort, now(), by(request));
      plan = applyPlanFields(plan, fields, { routeKeys: await routeKeys(), boats: new Set((await store.boatRecords()).map((b) => b.id)) });
      await repo().putPlan(plan);
      return plan.id;
    });
    reply.code(201);
    return onePlan(id);
  });
  app.patch('/v1/costing/plans/:id', async (request) => {
    const id = params(request).id;
    await store.transaction(async () => {
      const next = applyPlanFields(await planOf(id), request.body, { routeKeys: await routeKeys(), boats: new Set((await store.boatRecords()).map((b) => b.id)) });
      await repo().putPlan({ ...next, updated_at: now(), updated_by: by(request) });
    });
    return onePlan(id);
  });
  app.delete('/v1/costing/plans/:id', async (request, reply) => {
    const id = params(request).id;
    await store.transaction(async () => { if (!(await repo().deletePlan(id))) notFound(`Cost plan ${id} not found`); });
    return reply.code(204).send();
  });

  // ── Rented boats (legacy `boat_rent`) ──
  const rentsView = async () => {
    const boats = new Map((await boatList()).map((b) => [b.id, b]));
    return { rents: (await repo().rents()).map((r) => rentView(r, boats.get(r.boat_id))) };
  };
  app.get('/v1/costing/boat-rents', async (request) => { staffOnly(request); return rentsView(); });
  app.put('/v1/costing/boat-rents/:boat_id', async (request) => {
    const boatId = params(request).boat_id;
    await store.transaction(async () => {
      if (!(await store.boatRecords()).some((b) => b.id === boatId)) notFound(`Boat ${boatId} not found`);
      const cur = (await repo().rents()).find((r) => r.boat_id === boatId) ?? blankRent(boatId, now(), by(request));
      await repo().putRent({ ...applyRentFields(cur, request.body), updated_at: now(), updated_by: by(request) });
    });
    return rentsView();
  });
  app.delete('/v1/costing/boat-rents/:boat_id', async (request, reply) => {
    const boatId = params(request).boat_id;
    await store.transaction(async () => { if (!(await repo().deleteRent(boatId))) notFound(`Boat ${boatId} has no rent record`); });
    return reply.code(204).send();
  });

  // ── Restaurants (legacy `meal_venues`, `routes.mealVenueId`) ──
  const venuesView = async () => ({
    venues: await repo().venues(),
    routes: Object.fromEntries((await store.listRoutes()).filter((r) => r.meal_venue_id).map((r) => [r.id, r.meal_venue_id!])),
  });
  app.get('/v1/meal-venues', async (request) => { staffOnly(request); return venuesView(); });
  app.post('/v1/meal-venues', async (request, reply) => {
    const v = applyVenueFields(blankVenue(shortId('mv')), request.body ?? {});
    await store.transaction(async () => { await repo().putVenue(v); });
    reply.code(201);
    return v;
  });
  app.patch('/v1/meal-venues/:id', async (request) => {
    const id = params(request).id;
    return store.transaction(async () => {
      const cur = (await repo().venues()).find((v) => v.id === id) ?? notFound(`Meal venue ${id} not found`);
      const next = applyVenueFields(cur, request.body);
      await repo().putVenue(next);
      return next;
    });
  });
  app.put('/v1/routes/:id/meal-venue', async (request) => {
    const id = params(request).id;
    const body = record(request.body);
    const raw = body.meal_venue_id ?? body.mealVenueId;
    if (raw !== null && raw !== undefined && raw !== '' && typeof raw !== 'string') bad('meal_venue_id must be a venue id, or null');
    const venueId = typeof raw === 'string' && raw ? raw : null;
    await store.transaction(async () => {
      if (!(await store.route(id))) notFound(`Route ${id} not found`);
      if (venueId && !(await repo().venues()).some((v) => v.id === venueId)) bad(`meal_venue_id ${venueId} is not a meal venue (GET /v1/meal-venues)`);
      await store.setRouteMealVenue(id, venueId);
    });
    return store.route(id);
  });

  // ── Trip actuals: the pier's meal order, its note and choices, the day's restaurant ──
  const actualOf = async (date: string, boatId: string): Promise<TripActual> => (await repo().tripActual(date, boatId)) ?? blankActual(date, boatId);
  const actualView = async (date: string, boatId: string) => {
    const s = await shared();
    const bookings = await store.bookingsOnDate(date);
    const actual = await repo().tripActual(date, boatId);
    return { ...(actual ?? blankActual(date, boatId)), saved: !!actual,
      meal_preview: mealPreview(date, boatId, { deployments: await store.listDeployments(date, date), bookings, routes: s.routes, venues: s.venues, actual }) };
  };
  app.get('/v1/trip-actuals', async (request) => {
    staffOnly(request);
    const q = query(request);
    const from = dateOf(q.from, 'from'), to = q.to === undefined ? from : dateOf(q.to, 'to');
    if (to < from) bad('to must not precede from');
    return { trip_actuals: await repo().tripActuals(from, to) };
  });
  app.get('/v1/trip-actuals/:date/:boat_id', async (request) => {
    staffOnly(request);
    const { date, boatId } = await boatParam(request);
    return actualView(date, boatId);
  });
  /** A write to one boat's day: the rule gets the stored row (or a blank) and answers the next one. */
  const actualWrite = (method: 'put' | 'post', path: string, step: (a: TripActual, request: Request, date: string, boatId: string) => Promise<TripActual> | TripActual) => {
    app[method](`/v1/trip-actuals/:date/:boat_id/${path}`, async (request) => {
      const { date, boatId } = await boatParam(request);
      await store.transaction(async () => { await repo().putTripActual(await step(await actualOf(date, boatId), request, date, boatId)); });
      return actualView(date, boatId);
    });
  };
  /** Legacy `pjMvSet`: this day's restaurant; `none` = no meal; null = the route's. */
  actualWrite('put', 'venue', async (a, request) => {
    const body = record(request.body);
    const v = body.venue ?? body.venue_id;
    if (v === null || v === undefined || v === '') return { ...a, venue_id: null, no_meal: false };
    if (v === 'none' || v === '-') return { ...a, venue_id: null, no_meal: true };
    if (typeof v !== 'string' || !(await repo().venues()).some((x) => x.id === v)) bad('venue must be a meal venue id, none, or null (the route\'s)');
    return { ...a, venue_id: v as string, no_meal: false };
  });
  /** Legacy `pckMealSend`: the order counted and priced here, then frozen. Sending again replaces it. */
  actualWrite('post', 'meal-order', async (a, request, date, boatId) => {
    const s = await shared();
    const p = mealPreview(date, boatId, { deployments: await store.listDeployments(date, date), bookings: await store.bookingsOnDate(date), routes: s.routes, venues: s.venues, actual: a });
    return sendMealOrder(p, a, now(), by(request));
  });
  /** Legacy `pckMealNoteSave`: empty clears it. */
  actualWrite('put', 'meal-note', (a, request) => {
    const body = record(request.body);
    const t = body.text ?? body.t;
    if (t !== null && t !== undefined && typeof t !== 'string') bad('text must be a string, or null to clear the note');
    const text = typeof t === 'string' ? t.trim() : '';
    return { ...a, meal_note: text ? { text, at: now(), by: by(request) } : null };
  });
  app.put('/v1/trip-actuals/:date/:boat_id/meal-overnight/:booking_id', async (request) => {
    const { date, boatId } = await boatParam(request);
    const body = record(request.body);
    await store.transaction(async () => {
      const b = (await store.booking(params(request).booking_id)) ?? notFound(`Booking ${params(request).booking_id} not found`);
      await repo().putTripActual(setOvernightMeal(await actualOf(date, boatId), b, boatId, body.include === undefined ? null : body.include));
    });
    return actualView(date, boatId);
  });

  // ── Trip P&L ──
  const deployed = async (date: string, boatId: string) => {
    if (!(await store.listDeployments(date, date)).some((d) => d.boat_id === boatId)) notFound(`${boatId} has no deployment on ${date}: it is not on the Trip P&L`);
  };
  const tripNow = async (date: string, boatId: string) => tripPL(boatId, await plDay(date, await shared()));
  app.get('/v1/reports/trip-pl', async (request) => {
    staffOnly(request);
    const q = query(request);
    const date = dateOf(q.date ?? todayInThailand());
    const pier = typeof q.pier === 'string' && q.pier ? q.pier : null;
    return dayPL(await plDay(date, await shared()), pier);
  });
  app.get('/v1/reports/trip-pl/month', async (request) => {
    staffOnly(request);
    const q = query(request);
    const month = typeof q.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month) ? q.month : bad('month must be YYYY-MM');
    const pier = typeof q.pier === 'string' && q.pier ? q.pier : null;
    const first = `${month}-01`;
    const last = addDays(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
    // Legacy `pxDaysOf`: the month's days up to today.
    const today = todayInThailand(), end = last < today ? last : today;
    const s = await shared();
    const prices = first <= end ? await store.fleetRepo.fuelPrices(addDays(first, -31), end) : [];
    const days = [];
    const totals = { trips: 0, revenue: 0, cost: 0, profit: 0, pax: 0, bookings: 0, loss_trips: 0, capacity: 0, did_not_sail: 0 };
    for (let d = first; d <= end; d = addDays(d, 1)) {
      const day = dayPL(await plDay(d, s, prices), pier);
      days.push({ date: d, ...day.totals });
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += day.totals[k];
    }
    return { month, pier, days, totals };
  });
  app.get('/v1/reports/trip-pl/:date/:boat_id', async (request) => {
    staffOnly(request);
    const { date, boatId } = await boatParam(request);
    return tripNow(date, boatId);
  });
  const plCommand = (path: string, step: (a: TripActual, request: Request, date: string, boatId: string) => Promise<TripActual>) => {
    app.post(`/v1/trip-actuals/:date/:boat_id/${path}`, async (request) => {
      const { date, boatId } = await boatParam(request);
      await store.transaction(async () => {
        await deployed(date, boatId);
        await repo().putTripActual(await step(await actualOf(date, boatId), request, date, boatId));
      });
      return tripNow(date, boatId);
    });
  };
  plCommand('close', async (a, request, date, boatId) => closeTrip(await tripNow(date, boatId), a, now(), by(request)));
  plCommand('reopen', async (a) => reopenTrip(a));
  plCommand('ran', async (a, request, date, boatId) => markRan(await tripNow(date, boatId), a, now(), by(request)));
  plCommand('not-ran', async (a) => unmarkRan(a));
}
