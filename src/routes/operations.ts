import type { FastifyInstance } from 'fastify';
import { OperationsStore, type Booking, type Deployment, type SeatLock } from '../domain/operations.js';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';

const badRequest = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const notFound = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 404; throw error; };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest('Request body must be an object');
const string = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0 ? value : badRequest(`${name} is required`);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const pax = (value: unknown, name = 'pax'): number => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : badRequest(`${name} must be a positive integer`);

function deployment(body: unknown): Deployment {
  const input = record(body);
  const capacity = pax(input.capacity ?? input.cap, 'capacity');
  return { boat_id: string(input.boat_id, 'boat_id'), route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), capacity, license_pax: input.license_pax === undefined && input.licensePax === undefined ? undefined : pax(input.license_pax ?? input.licensePax, 'license_pax'), total_capacity: input.total_capacity === undefined && input.totalcap === undefined ? undefined : pax(input.total_capacity ?? input.totalcap, 'total_capacity') };
}
function paxBreakdown(value: unknown): Record<string, number> {
  const input = record(value);
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(input)) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) badRequest(`pax.${key} must be a non-negative integer`);
    result[key] = count as number;
  }
  return result;
}
function bookingInput(body: unknown): Omit<Booking, 'id' | 'allocated_pax' | 'status' | 'created_at' | 'updated_at'> {
  const input = record(body);
  const trips = input.trips === undefined ? undefined : (Array.isArray(input.trips) && input.trips.length === 1 ? input.trips : badRequest('Exactly one trip is required; create one booking per departure'));
  const trip = trips ? record(trips[0]) : undefined;
  const breakdown = trip?.pax === undefined ? undefined : paxBreakdown(trip.pax);
  const calculatedPax = breakdown ? Object.values(breakdown).reduce((total, count) => total + count, 0) : undefined;
  const suppliedPax = input.pax === undefined ? undefined : pax(input.pax);
  if (suppliedPax !== undefined && calculatedPax !== undefined && suppliedPax !== calculatedPax) badRequest('pax must equal the sum of trip.pax');
  const totalPax = suppliedPax ?? (calculatedPax && calculatedPax > 0 ? calculatedPax : badRequest('pax or trip.pax is required'));
  return {
    route_id: string(input.route_id ?? trip?.routeId, 'route_id'),
    service_date: string(input.service_date ?? input.date ?? trip?.date, 'service_date'),
    pax: totalPax,
    external_id: optionalString(input.external_id ?? input.id),
    agent_id: optionalString(input.agent_id ?? input.agentId),
    voucher_ref: optionalString(input.voucher_ref ?? input.voucherRef),
    rate_type_ref: optionalString(input.rate_type_ref ?? input.rateTypeRef),
    booking_mode: optionalString(input.booking_mode ?? trip?.bookingMode),
    pax_breakdown: breakdown,
    booking_data: input,
  };
}
function lockInput(body: unknown): Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'> {
  const input = record(body);
  return { ...input, route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), pax: pax(input.pax), agent_id: optionalString(input.agent_id) };
}

export function registerOperationsRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const store = process.env.DATABASE_URL ? new PostgresOperationsStore(process.env.DATABASE_URL) : new OperationsStore();
  if (store instanceof PostgresOperationsStore) app.addHook('onClose', async () => store.close());

  app.get('/v1/availability', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { route_id: string(query.route_id, 'route_id'), service_date: string(query.service_date ?? query.date, 'date'), ...(await store.capacity(string(query.route_id, 'route_id'), string(query.service_date ?? query.date, 'date'))) };
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
    const changes = record(request.body);
    if (changes.route_id !== undefined) string(changes.route_id, 'route_id');
    if (changes.service_date !== undefined) string(changes.service_date, 'service_date');
    if (changes.pax !== undefined) pax(changes.pax);
    return store.transaction(async () => (await store.amendBooking((request.params as { id: string }).id, changes as Partial<Booking>)) ?? notFound('Booking not found'));
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
    return await store.allotment(string(query.route_id, 'route_id'), string(query.service_date, 'service_date'));
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
