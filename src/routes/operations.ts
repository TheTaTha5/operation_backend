import type { FastifyInstance } from 'fastify';
import { OperationsStore, type BookingChanges, type BookingInput, type BookingTripInput, type Deployment, type Exclusion, type SeatLock } from '../domain/operations.js';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { OidcAuthenticator, requireAnyScope } from '../auth.js';
import { eachDate, isIsoDate, routeCalendar } from '../domain/calendar.js';
import { parsePaxGrid, paxRowsFromTotal, paxTotal, type PaxRow } from '../domain/pax.js';
import { BOOKING_STATUSES, isBookingStatus, type BookingStatus } from '../domain/booking-status.js';
import { charterCeiling } from '../domain/capacity.js';

/** A little over a year, so a client may sweep a full season but not walk the calendar forever. */
const MAX_CALENDAR_DAYS = 400;

const badRequest = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const notFound = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 404; throw error; };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest('Request body must be an object');
const string = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0 ? value : badRequest(`${name} is required`);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const pax = (value: unknown, name = 'pax'): number => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : badRequest(`${name} must be a positive integer`);
/** Seats held by the reservation currently being edited, so an availability read does not count them against it. */
const exclusion = (query: Record<string, unknown>): Exclusion => ({ bookingId: optionalString(query.exclude_booking_id), lockId: optionalString(query.exclude_lock_id) });

function deployment(body: unknown): Deployment {
  const input = record(body);
  const capacity = pax(input.capacity ?? input.cap, 'capacity');
  // `total_capacity`/`totalcap` are still accepted because that is what legacy sends, but they are
  // the registration figure (passengers + crew) and are stored as such. Nothing sells against them.
  const registered = input.registered_persons ?? input.total_capacity ?? input.totalcap;
  return { boat_id: string(input.boat_id, 'boat_id'), route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), capacity, license_pax: input.license_pax === undefined && input.licensePax === undefined ? undefined : pax(input.license_pax ?? input.licensePax, 'license_pax'), registered_persons: registered === undefined ? undefined : pax(registered, 'registered_persons') };
}
/** An unrecognised status is refused by name; the CHECK behind it would only say "constraint". */
const bookingStatus = (value: unknown): BookingStatus | undefined =>
  value === undefined || value === null ? undefined : (isBookingStatus(value) ? value : badRequest(`status must be one of ${BOOKING_STATUSES.join(', ')}`));

/** A bare count is one untiered cell; the frontend's `{ ad: 2, chd_fr: 1 }` grid is parsed as written. */
const paxOf = (value: unknown, label: string): PaxRow[] => typeof value === 'number' ? paxRowsFromTotal(pax(value, label)) : parsePaxGrid(value, label);

function tripInput(value: unknown, index: number): BookingTripInput {
  const trip = record(value);
  const label = `trips[${index}]`;
  const rows = trip.pax === undefined ? badRequest(`${label}.pax is required`) : paxOf(trip.pax, `${label}.pax`);
  if (paxTotal(rows) === 0) badRequest(`${label}.pax must carry at least one passenger`);
  return {
    route_id: string(trip.route_id ?? trip.routeId, `${label}.route_id`),
    service_date: string(trip.service_date ?? trip.date, `${label}.service_date`),
    booking_mode: optionalString(trip.booking_mode ?? trip.bookingMode),
    pax: rows,
  };
}

/** Parses an itinerary, accepting either the frontend's `trips` array or a single flat departure. */
function tripsInput(input: Record<string, unknown>): BookingTripInput[] {
  if (input.trips !== undefined) {
    if (!Array.isArray(input.trips) || input.trips.length === 0) badRequest('trips must be a non-empty array');
    return (input.trips as unknown[]).map(tripInput);
  }
  return [tripInput({ route_id: input.route_id, service_date: input.service_date ?? input.date, pax: input.pax, booking_mode: input.booking_mode }, 0)];
}

function bookingInput(body: unknown): BookingInput {
  const input = record(body);
  const trips = tripsInput(input);
  // A supplied top-level `pax` is a claim about the whole itinerary; disagreeing with the trips it
  // describes is a client bug worth reporting rather than silently resolving in favour of one side.
  if (input.trips !== undefined && input.pax !== undefined && pax(input.pax) !== trips.reduce((sum, trip) => sum + paxTotal(trip.pax), 0)) badRequest('pax must equal the sum of trip.pax');
  return {
    trips,
    status: bookingStatus(input.status),
    external_id: optionalString(input.external_id ?? input.id),
    agent_id: optionalString(input.agent_id ?? input.agentId),
    voucher_ref: optionalString(input.voucher_ref ?? input.voucherRef),
    rate_type_ref: optionalString(input.rate_type_ref ?? input.rateTypeRef),
    booking_data: input,
  };
}

/** An amendment either replaces the itinerary outright or moves the single departure it has. */
function bookingChanges(body: unknown): BookingChanges {
  const input = record(body);
  const status = bookingStatus(input.status);
  if (input.trips !== undefined) return { trips: tripsInput(input), ...(status === undefined ? {} : { status }) };
  return {
    ...(input.route_id === undefined ? {} : { route_id: string(input.route_id, 'route_id') }),
    ...(input.service_date === undefined ? {} : { service_date: string(input.service_date, 'service_date') }),
    ...(input.pax === undefined ? {} : { pax: pax(input.pax) }),
    ...(status === undefined ? {} : { status }),
  };
}
function lockInput(body: unknown): Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'> {
  const input = record(body);
  return { ...input, route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), pax: pax(input.pax), agent_id: optionalString(input.agent_id) };
}

export function registerOperationsRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const store = process.env.DATABASE_URL ? new PostgresOperationsStore(process.env.DATABASE_URL) : new OperationsStore();
  const authenticator = new OidcAuthenticator();
  if (store instanceof PostgresOperationsStore) app.addHook('onClose', async () => store.close());
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    const isOperations = path.startsWith('/operations/') || path === '/v1/manifest';
    const isWrite = request.method !== 'GET';
    const user = await authenticator.authenticate(request);
    requireAnyScope(user, [isOperations ? (isWrite ? 'operations:write' : 'operations:read') : (isWrite ? 'booking:write' : 'booking:read')]);
  });

  /**
   * The route catalogue, optionally with each route's operating calendar resolved per date.
   *
   * Without `from`/`to` this is the catalogue alone, which is what a client needs to label a
   * booking row. With them, every date carries the open/closed decision and the rule that made it,
   * so a closed day can explain itself rather than just refusing.
   */
  app.get('/v1/routes', async (request) => {
    const query = request.query as Record<string, unknown>;
    const from = optionalString(query.from), to = optionalString(query.to);
    if ((from === undefined) !== (to === undefined)) badRequest('from and to must be supplied together');
    const routes = await store.listRoutes();
    if (from === undefined || to === undefined) return { routes };

    if (!isIsoDate(from) || !isIsoDate(to)) badRequest('from and to must be YYYY-MM-DD dates');
    if (to < from) badRequest('to must not precede from');
    // A sweep is one query per table regardless of width, but the response grows with routes × days.
    const days = [...eachDate(from, to)].length;
    if (days > MAX_CALENDAR_DAYS) badRequest(`Range covers ${days} days; the maximum is ${MAX_CALENDAR_DAYS}`);

    const calendar = routeCalendar(await store.listSeasons(), await store.listDayOverrides(from, to));
    return { from, to, routes: routes.map((route) => ({ ...route, days: calendar.range(route.id, from, to) })) };
  });

  /**
   * The boat catalogue, as a static reference list.
   *
   * Deliberately not date-aware: `boat_capacity_overrides` changes a boat's seats for one day, but
   * `/v1/availability` already resolves that against the day's deployment, and answering it twice
   * invites the two answers to disagree.
   *
   * `charter_ceiling` is the resolved answer to how many passengers a charter may fill this boat to,
   * computed here so no client re-implements the fallback. `license_pax` is null for a boat with no
   * licence on file: claiming a registration the vessel does not hold would be worse than saying
   * there is none, and a missing licence is not a licence of zero.
   */
  app.get('/v1/boats', async () => ({
    boats: (await store.listBoats()).map((boat) => ({ ...boat, license_pax: boat.license_pax ?? null, charter_ceiling: charterCeiling(boat) })),
  }));

  app.get('/v1/availability', async (request) => {
    const query = request.query as Record<string, unknown>;
    const route_id = string(query.route_id, 'route_id'); const service_date = string(query.service_date ?? query.date, 'date');
    return { route_id, service_date, ...(await store.capacity(route_id, service_date, exclusion(query))) };
  });

  app.get('/v1/bookings', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { bookings: await store.listBookings(optionalString(query.route_id), optionalString(query.service_date ?? query.date)) };
  });
  app.get('/v1/bookings/:id', async (request) => (await store.booking((request.params as { id: string }).id)) ?? notFound('Booking not found'));
  app.post('/v1/bookings', async (request, reply) => {
    const result = await store.transaction(() => store.createBooking(bookingInput(request.body)));
    return reply.code(201).send(result);
  });
  app.patch('/v1/bookings/:id', async (request) => {
    const changes = bookingChanges(request.body);
    return store.transaction(async () => (await store.amendBooking((request.params as { id: string }).id, changes)) ?? notFound('Booking not found'));
  });
  app.post('/v1/bookings/:id/cancel', async (request) => {
    const body = record(request.body ?? {});
    return store.transaction(async () => (await store.cancelBooking((request.params as { id: string }).id, optionalString(body.reason))) ?? notFound('Booking not found'));
  });
  app.post('/v1/bookings/:id/partial-cancel', async (request) => {
    const body = record(request.body);
    const quantity = pax(body.pax_to_cancel ?? body.pax, 'pax_to_cancel');
    return store.transaction(async () => (await store.partialCancel((request.params as { id: string }).id, quantity)) ?? notFound('Booking not found'));
  });
  app.post('/v1/bookings/:id/reschedule', async (request) => {
    const body = record(request.body);
    const route_id = string(body.route_id, 'route_id');
    const service_date = string(body.service_date ?? body.date, 'service_date');
    return store.transaction(async () => (await store.amendBooking((request.params as { id: string }).id, { route_id, service_date, ...(body.pax === undefined ? {} : { pax: pax(body.pax) }) })) ?? notFound('Booking not found'));
  });

  app.get('/v1/manifest', async (request) => {
    const query = request.query as Record<string, unknown>;
    const route_id = string(query.route_id, 'route_id'); const service_date = string(query.date ?? query.service_date, 'date');
    return { ...(await store.allotment(route_id, service_date)), bookings: await store.listBookings(route_id, service_date) };
  });
  app.get('/operations/allotment', async (request) => {
    const query = request.query as Record<string, unknown>;
    return await store.allotment(string(query.route_id, 'route_id'), string(query.service_date, 'service_date'), exclusion(query));
  });
  app.get('/operations/deployments', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { deployments: await store.listDeployments(optionalString(query.from), optionalString(query.to), optionalString(query.route_id)) };
  });
  app.post('/operations/deployments', async (request, reply) => reply.code(201).send(await store.transaction(() => store.createDeployment(deployment(request.body)))));
  app.delete('/operations/deployments/:service_date/:boat_id', async (request, reply) => {
    const params = request.params as { service_date: string; boat_id: string };
    const removed = await store.transaction(async () => await store.deleteDeployment(params.service_date, params.boat_id));
    if (!removed) notFound('Deployment not found');
    return reply.code(204).send();
  });

  app.get('/v1/seat-locks', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { seat_locks: await store.listLocks(optionalString(query.route_id), optionalString(query.service_date ?? query.date)) };
  });
  app.post('/v1/seat-locks', async (request, reply) => reply.code(201).send(await store.transaction(() => store.createLock(lockInput(request.body)))));
  app.patch('/v1/seat-locks/:id', async (request) => {
    const body = record(request.body);
    if (body.pax !== undefined) pax(body.pax);
    if (body.agent_id !== undefined) string(body.agent_id, 'agent_id');
    return store.transaction(async () => (await store.amendLock((request.params as { id: string }).id, body as Partial<SeatLock>)) ?? notFound('Seat lock not found'));
  });
  app.post('/v1/seat-locks/:id/release', async (request) => store.transaction(async () => (await store.releaseLock((request.params as { id: string }).id)) ?? notFound('Seat lock not found')));
  done();
}
