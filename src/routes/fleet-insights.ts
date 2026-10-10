/**
 * Fleet Insights and the Fleet Report (todo/fleet-maintenance-model.md, "Design — insights"): two
 * computed reads. The figures are `src/domain/fleet-insights.ts`'s; these gather the rows. Any staff
 * login reads them; a login tied to an agent is refused, as the money reports refuse it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from './operations.js';
import { refuse } from '../domain/booking-actions.js';
import { todayInThailand } from '../domain/calendar.js';
import { bad, dayGap, isoDate } from '../domain/fleet-common.js';
import { pierOn, shopOf } from '../domain/fleet-assignments.js';
import { availability } from '../domain/fleet-availability.js';
import { linkedMemos } from '../domain/fleet-seams.js';
import { stockView, type Movement } from '../domain/fleet-stock.js';
import { fleetReport, INSIGHT_PERIODS, insights, MAX_REPORT_DAYS, previousRange, type InsightPeriod } from '../domain/fleet-insights.js';
import type { FleetRepo } from '../domain/fleet-store.js';
import { hoursLoader, openWork } from './fleet.js';

type Request = FastifyRequest;
const query = (request: Request): Record<string, unknown> => (request.query ?? {}) as Record<string, unknown>;
/** Fleet costs are staff's: a login tied to an agent books and reads its own bookings only. */
const staffOnly = (request: Request): void => {
  const agent = request.user?.user?.agent_id;
  if (agent) refuse(`This login books for agent ${agent}; fleet reports are for staff`, 403, 'forbidden');
};

export function registerFleetInsightsRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;
  const fleet = (): FleetRepo => store.fleetRepo as FleetRepo;

  // ── Fleet Insights (legacy `flRenderInsights`) ──

  app.get('/v1/fleet/insights', async (request) => {
    staffOnly(request);
    const period = query(request).period ?? 'month';
    if (!(INSIGHT_PERIODS as readonly unknown[]).includes(period)) bad(`period must be one of ${INSIGHT_PERIODS.join(', ')}`);
    const today = todayInThailand();
    const work = await openWork(store);
    const assignments = await fleet().assignments();
    const started = await store.fleetJobs({ status: 'inprogress' });
    const hoursOf = await hoursLoader(store);
    const memos = await fleet().memos();
    return insights({
      today, period: period as InsightPeriod,
      boats: (await store.boatRecords()).map((b) => {
        const status = availability(b, today, work).status;
        // Legacy `getBoatCurrentPier`: a boat held at a shop is at none of the piers.
        const pier = shopOf(started, b.id, status !== 'available') ? 'shop' : pierOn(b, today, assignments);
        return { id: b.id, name: b.name, pier: b.pier, ownership: b.ownership, retired: b.retired, status, pier_today: pier, documents: b.documents };
      }),
      jobs: await store.fleetJobs({}), incidents: await store.fleetIncidents({}), memos, memosOf: linkedMemos(memos), items: await fleet().items(),
      engines: (await store.fleetAssets('engine')).filter((e) => !e.retired).map((e) => ({
        id: e.id, boat_id: e.boat_id, serial: e.serial, model: e.model, brand: e.brand, hours: hoursOf(e),
        service_interval: e.service_interval, last_service_hours: e.last_service_hours, base_hours: e.base_hours,
      })),
    });
  });

  // ── The Fleet Report (legacy `rep-fleet`, `repFleetGather`) ──

  app.get('/v1/fleet/reports/fleet', async (request) => {
    staffOnly(request);
    const q = query(request);
    const from = isoDate(q.from, 'from') ?? bad('from is required (YYYY-MM-DD)');
    const to = isoDate(q.to, 'to') ?? bad('to is required (YYYY-MM-DD)');
    if (to < from) bad('to must not precede from');
    if (dayGap(from, to) + 1 > MAX_REPORT_DAYS) bad(`A report covers at most ${MAX_REPORT_DAYS} days; ${from} to ${to} is ${dayGap(from, to) + 1}`);
    const boats = await store.boatRecords();
    const byId = new Map(boats.map((b) => [b.id, b]));
    const work = await openWork(store);
    const memos = await fleet().memos();
    const items = await fleet().items();
    const moves = new Map<string, Movement[]>(items.map((i) => [i.id, []]));
    for (const m of await fleet().movements({ itemIds: items.map((i) => i.id) })) moves.get(m.item_id)?.push(m);
    return fleetReport({
      from, to, boats: boats.map((b) => ({ id: b.id, name: b.name, retired: b.retired })),
      statusOn: (id, date) => availability(byId.get(id)!, date, work).status,
      jobs: await store.fleetJobs({}), incidents: await store.fleetIncidents({}), memos, memosOf: linkedMemos(memos), projects: await fleet().projects(),
      meters: (await fleet().daily(previousRange(from, to).from, to)).meters,
      stock: items.map((i) => stockView(i, moves.get(i.id) ?? [])), safety: await fleet().safetyItems(),
      consumables: (await fleet().consumables()).filter((c) => !c.voided_at).length,
    });
  });
}
