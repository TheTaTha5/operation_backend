import type { FastifyInstance } from 'fastify';
import { assertItinerary, OperationsStore, type OvnMode, type BookingChanges, type BookingInput, type BookingListQuery, type BookingTripInput, type Deployment, type Exclusion, type LockDraw, type SeatLock } from '../domain/operations.js';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { OidcAuthenticator, requireAnyScope } from '../auth.js';
import { eachDate, isIsoDate, isIsoTime, routeCalendar } from '../domain/calendar.js';
import { parsePaxGrid, paxRowsFromTotal, paxTotal, type PaxRow } from '../domain/pax.js';
import { BOOKING_STATUSES, isBookingStatus, type BookingStatus } from '../domain/booking-status.js';
import { capacityNumbers, charterCeiling } from '../domain/capacity.js';
import { bookingHeader, bookingHeaderPatch } from '../domain/booking-header.js';
import { parseBookingPassengers } from '../domain/booking-passengers.js';
import type { AgentListQuery } from '../domain/agents.js';

/** A little over a year, so a client may sweep a full season but not walk the calendar forever. */
const MAX_CALENDAR_DAYS = 400;
/** Every route over a range grows with routes × days, so the sweep across all of them is kept to about two months. */
const MAX_ALL_ROUTES_DAYS = 62;

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

/** `{ lock_id: qty }`, the shape the frontend writes as `lockDraws`. An empty map draws nothing. */
function lockDraws(value: unknown, label: string): LockDraw[] {
  if (value === undefined || value === null) return [];
  const draws = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest(`${label} must be an object of lock id to seats`);
  return Object.entries(draws).map(([lock_id, qty]) => ({ lock_id, qty: pax(qty, `${label}.${lock_id}`) }));
}

function tripInput(value: unknown, index: number): BookingTripInput {
  const trip = record(value);
  const label = `trips[${index}]`;
  const rows = trip.pax === undefined ? badRequest(`${label}.pax is required`) : paxOf(trip.pax, `${label}.pax`);
  if (paxTotal(rows) === 0) badRequest(`${label}.pax must carry at least one passenger`);
  const booking_mode = optionalString(trip.booking_mode ?? trip.bookingMode);
  const charter_boat_id = optionalString(trip.charter_boat_id ?? trip.charterBoatId);
  const draws = lockDraws(trip.lock_draws ?? trip.lockDraws, `${label}.lock_draws`);
  // A charter takes a whole boat, so it must say which; the seat pool cannot give one up otherwise.
  if (booking_mode === 'charter') {
    if (charter_boat_id === undefined) badRequest(`${label}.charter_boat_id is required for a charter`);
    if (draws.length > 0) badRequest(`${label}.lock_draws does not apply to a charter`);
  } else if (charter_boat_id !== undefined) badRequest(`${label}.charter_boat_id applies only to a charter`);
  if (draws.reduce((sum, draw) => sum + draw.qty, 0) > paxTotal(rows)) badRequest(`${label}.lock_draws cannot exceed the trip's pax`);
  // Absent means a new trip. Present but malformed is refused: dropping it would silently turn an
  // edit of an existing trip into a new one, and remove the trip it was meant to keep.
  if (trip.id !== undefined && optionalString(trip.id) === undefined) badRequest(`${label}.id must be a trip id`);
  return {
    ...(trip.id === undefined ? {} : { id: trip.id as string }),
    route_id: string(trip.route_id ?? trip.routeId, `${label}.route_id`),
    service_date: string(trip.service_date ?? trip.date, `${label}.service_date`),
    booking_mode, pax: rows, charter_boat_id, lock_draws: draws,
    ...tripDetails(trip, label),
  };
}

/**
 * The pickup and overnight fields of one trip. An empty string or null is "not set", which is how
 * legacy writes an unset field; a value that is present and malformed is refused. The rules that
 * span trips — a leg matching its outbound — are `assertItinerary`'s.
 */
function tripDetails(trip: Record<string, unknown>, label: string): Pick<BookingTripInput, 'zone' | 'pickup_time' | 'ovn' | 'ovn_return_date' | 'ovn_leg' | 'ovn_of'> {
  const unset = (value: unknown) => value === undefined || value === null || value === '';
  const text = (value: unknown, name: string): string | undefined => unset(value) ? undefined : typeof value === 'string' ? value : badRequest(`${label}.${name} must be a string`);
  const pickup_time = text(trip.pickup_time ?? trip.pickupTime, 'pickup_time');
  if (pickup_time !== undefined && !isIsoTime(pickup_time)) badRequest(`${label}.pickup_time must be an ISO time, HH:MM`);
  const ovn = text(trip.ovn, 'ovn');
  if (ovn !== undefined && ovn !== 'return' && ovn !== 'self') badRequest(`${label}.ovn must be return or self`);
  const ovn_return_date = text(trip.ovn_return_date ?? trip.ovnReturnDate, 'ovn_return_date');
  if (ovn_return_date !== undefined && !isIsoDate(ovn_return_date)) badRequest(`${label}.ovn_return_date must be YYYY-MM-DD`);
  const leg = trip.ovn_leg ?? trip.ovnLeg;
  if (!unset(leg) && typeof leg !== 'boolean') badRequest(`${label}.ovn_leg must be true or false`);
  const of = trip.ovn_of ?? trip.ovnOf;
  if (!unset(of) && !(typeof of === 'number' && Number.isInteger(of) && of >= 0)) badRequest(`${label}.ovn_of must be the index of a trip in this list`);
  const zone = text(trip.zone, 'zone');
  return {
    ...(zone === undefined ? {} : { zone }),
    ...(pickup_time === undefined ? {} : { pickup_time }),
    ...(ovn === undefined ? {} : { ovn: ovn as OvnMode }),
    ...(ovn_return_date === undefined ? {} : { ovn_return_date }),
    ...(leg === true ? { ovn_leg: true } : {}),
    ...(unset(of) ? {} : { ovn_of: of as number }),
  };
}

/** Parses an itinerary, accepting either the frontend's `trips` array or a single flat departure. */
function tripsInput(input: Record<string, unknown>): BookingTripInput[] {
  if (input.trips !== undefined) {
    if (!Array.isArray(input.trips) || input.trips.length === 0) badRequest('trips must be a non-empty array');
    const trips = (input.trips as unknown[]).map(tripInput);
    assertItinerary(trips);
    return trips;
  }
  return [tripInput({
    route_id: input.route_id, service_date: input.service_date ?? input.date, pax: input.pax, booking_mode: input.booking_mode,
    charter_boat_id: input.charter_boat_id, lock_draws: input.lock_draws,
  }, 0)];
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
    header: bookingHeader(input),
    passengers: parseBookingPassengers(input.passengers),
    // booking_data: input,
  };
}

/**
 * An amendment either replaces the itinerary outright or moves the single departure it has, and
 * either way carries whichever header fields the caller mentioned.
 *
 * The header is read from the same body by the same table the create path uses, so a field
 * `POST /v1/bookings` accepts is a field `PATCH` accepts. It is read on both branches: an
 * amendment that rewrites the trips may correct the lead passenger in the same call.
 */
function bookingListQuery(query: Record<string, unknown>): BookingListQuery {
  const serviceDate = optionalString(query.service_date ?? query.date);
  const from = optionalString(query.from);
  const to = optionalString(query.to);
  if (serviceDate !== undefined && (from !== undefined || to !== undefined)) badRequest('service_date cannot be combined with from or to');
  if ((from === undefined) !== (to === undefined)) badRequest('from and to must be supplied together');
  if (from !== undefined && (!isIsoDate(from) || !isIsoDate(to!))) badRequest('from and to must be YYYY-MM-DD dates');
  if (from !== undefined && to! < from) badRequest('to must not precede from');
  const rawLimit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) badRequest('limit must be an integer between 1 and 100');
  const cursor = optionalString(query.cursor);
  const order = query.order === undefined ? undefined : query.order === 'asc' || query.order === 'desc' ? query.order : badRequest('order must be asc or desc');
  return { routeId: optionalString(query.route_id), agentId: optionalString(query.agent_id), serviceDate, from, to, limit: rawLimit, cursor, ...(order ? { order } : {}) };
}

/** `?active=` on the agent list: active agents by default, `false` for inactive ones, `all` for both. */
function agentListQuery(query: Record<string, unknown>): AgentListQuery {
  const active = query.active === undefined || query.active === 'true' ? true : query.active === 'false' ? false : query.active === 'all' ? undefined : badRequest('active must be true, false or all');
  return { marketId: optionalString(query.market), salesId: optionalString(query.sales), q: optionalString(query.q), active };
}

function bookingChanges(body: unknown): BookingChanges {
  const input = record(body);
  const status = bookingStatus(input.status);
  const header = bookingHeaderPatch(input);
  const common = {
    ...(status === undefined ? {} : { status }),
    ...(Object.keys(header).length === 0 ? {} : { header }),
    ...(input.passengers === undefined ? {} : { passengers: parseBookingPassengers(input.passengers) }),
  };
  if (input.trips !== undefined) return { trips: tripsInput(input), ...common };
  return {
    ...(input.route_id === undefined ? {} : { route_id: string(input.route_id, 'route_id') }),
    ...(input.service_date === undefined ? {} : { service_date: string(input.service_date, 'service_date') }),
    ...(input.pax === undefined ? {} : { pax: pax(input.pax) }),
    ...common,
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
    if (path === '/v1/login') return;
    const isOperations = path.startsWith('/operations/') || path === '/v1/manifest';
    const isWrite = request.method !== 'GET';
    const user = await authenticator.authenticate(request);
    requireAnyScope(user, [isOperations ? (isWrite ? 'operations:write' : 'operations:read') : (isWrite ? 'booking:write' : 'booking:read')]);
  });

  /**
   * Temporary testing login — exchanges `AUTH_PASSWORD_USERS` credentials for a short-lived Bearer
   * token this service will itself accept. Deliberate, scoped exception to "validate tokens, do not
   * issue them" (CLAUDE.md); not part of the OIDC contract and not meant to outlive testing.
   */
  app.post('/v1/login', async (request) => {
    const body = record(request.body);
    const { token, expiresIn } = await authenticator.issuePasswordToken(string(body.username, 'username'), string(body.password, 'password'));
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn };
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

  /**
   * One route on one day (`route_id` + `date`), or a list of route-days over `from..to` for one route
   * or, without `route_id`, every route in the catalogue — so a month grid asks once, not per cell.
   *
   * Each range entry carries the calendar's `open` beside the seat numbers: a closed day with no
   * boat and an open day nobody has staffed yet both have zero seats, and only `open` tells them
   * apart. `deployments[].capacity` is the boat's sellable seats that day, after any override and
   * the licence clamp, so the entries sum to `deployed_capacity`.
   */
  app.get('/v1/availability', async (request) => {
    const query = request.query as Record<string, unknown>;
    const from = optionalString(query.from); const to = optionalString(query.to);
    const date = optionalString(query.service_date ?? query.date);
    if (from === undefined && to === undefined) {
      const route_id = string(query.route_id, 'route_id');
      const service_date = date ?? badRequest('date is required, or from and to for a range');
      return { route_id, service_date, ...(await store.capacity(route_id, service_date, exclusion(query))) };
    }

    if (date !== undefined) badRequest('Pass either date or from and to, not both');
    if (from === undefined || to === undefined) return badRequest('from and to must be supplied together');
    if (!isIsoDate(from) || !isIsoDate(to)) badRequest('from and to must be YYYY-MM-DD dates');
    if (to < from) badRequest('to must not precede from');
    const routeId = optionalString(query.route_id);
    const limit = routeId === undefined ? MAX_ALL_ROUTES_DAYS : MAX_CALENDAR_DAYS;
    const span = [...eachDate(from, to)].length;
    if (span > limit) badRequest(`Range covers ${span} days; the maximum is ${limit}${routeId === undefined ? ' without route_id' : ''}`);

    const routeIds = routeId === undefined ? (await store.listRoutes()).map((route) => route.id) : [routeId];
    const calendar = routeCalendar(await store.listSeasons(), await store.listDayOverrides(from, to));
    const days = await store.dayRange(routeIds, from, to, exclusion(query));
    return {
      days: days.map((day) => ({
        route_id: day.route_id, service_date: day.service_date, open: calendar.isOpen(day.route_id, day.service_date),
        ...capacityNumbers(day),
        deployments: day.boats.map((boat) => ({ boat_id: boat.boat_id, capacity: boat.sellable, license_pax: boat.license_pax ?? null, chartered: boat.chartered })),
      })),
    };
  });

  app.get('/v1/bookings', async (request) => {
    const query = request.query as Record<string, unknown>;
    return await store.listBookings(bookingListQuery(query));
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
    return { ...(await store.allotment(route_id, service_date)), bookings: (await store.listBookings({ routeId: route_id, serviceDate: service_date, limit: 100 })).bookings };
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

  /**
   * Agents and their reference lists. Read-only for now: agents arrive through the legacy import.
   * Under `booking:read` like the rest of `/v1`. Every caller sees every agent — scoping a salesperson
   * to their own agents needs their salesperson id in the token, which is not decided yet.
   */
  app.get('/v1/markets', async () => ({ markets: await store.listMarkets() }));
  app.get('/v1/sales', async () => ({ sales: await store.listSalesPeople() }));
  app.get('/v1/agents', async (request) => ({ agents: await store.listAgents(agentListQuery(request.query as Record<string, unknown>)) }));
  app.get('/v1/agents/:id', async (request) => (await store.agent((request.params as { id: string }).id)) ?? notFound('Agent not found'));
  app.get('/v1/agents/:id/activity', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) badRequest('limit must be an integer between 1 and 200');
    return { activity: (await store.agentActivity((request.params as { id: string }).id, limit)) ?? notFound('Agent not found') };
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
