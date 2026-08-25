import type { FastifyInstance } from 'fastify';
import { OperationsStore, type Booking, type Deployment, type SeatLock } from '../domain/operations.js';

const badRequest = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const notFound = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 404; throw error; };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest('Request body must be an object');
const string = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0 ? value : badRequest(`${name} is required`);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const pax = (value: unknown, name = 'pax'): number => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : badRequest(`${name} must be a positive integer`);

function deployment(body: unknown): Deployment {
  const input = record(body);
  return { boat_id: string(input.boat_id, 'boat_id'), route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), capacity: pax(input.capacity, 'capacity') };
}
function bookingInput(body: unknown): Omit<Booking, 'id' | 'allocated_pax' | 'status' | 'created_at' | 'updated_at'> {
  const input = record(body);
  return { ...input, route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), pax: pax(input.pax) };
}
function lockInput(body: unknown): Omit<SeatLock, 'id' | 'status' | 'created_at' | 'updated_at'> {
  const input = record(body);
  return { ...input, route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), pax: pax(input.pax), agent_id: optionalString(input.agent_id) };
}

export function registerOperationsRoutes(app: FastifyInstance, _options: object, done: () => void): void {
  const store = new OperationsStore();

  app.get('/v1/availability', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { route_id: string(query.route_id, 'route_id'), service_date: string(query.service_date ?? query.date, 'date'), ...store.capacity(string(query.route_id, 'route_id'), string(query.service_date ?? query.date, 'date')) };
  });

  app.get('/v1/bookings', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { bookings: store.listBookings(optionalString(query.route_id), optionalString(query.service_date ?? query.date)) };
  });
  app.get('/v1/bookings/:id', async (request) => store.booking((request.params as { id: string }).id) ?? notFound('Booking not found'));
  app.post('/v1/bookings', async (request, reply) => {
    const result = await store.transaction(() => store.createBooking(bookingInput(request.body)));
    return reply.code(201).send(result);
  });
  app.patch('/v1/bookings/:id', async (request) => {
    const changes = record(request.body);
    if (changes.route_id !== undefined) string(changes.route_id, 'route_id');
    if (changes.service_date !== undefined) string(changes.service_date, 'service_date');
    if (changes.pax !== undefined) pax(changes.pax);
    return store.transaction(() => store.amendBooking((request.params as { id: string }).id, changes as Partial<Booking>) ?? notFound('Booking not found'));
  });
  app.post('/v1/bookings/:id/cancel', async (request) => {
    const body = record(request.body ?? {});
    return store.transaction(() => store.cancelBooking((request.params as { id: string }).id, optionalString(body.reason)) ?? notFound('Booking not found'));
  });
  app.post('/v1/bookings/:id/partial-cancel', async (request) => {
    const body = record(request.body);
    const quantity = pax(body.pax_to_cancel ?? body.pax, 'pax_to_cancel');
    return store.transaction(() => store.partialCancel((request.params as { id: string }).id, quantity) ?? notFound('Booking not found'));
  });
  app.post('/v1/bookings/:id/reschedule', async (request) => {
    const body = record(request.body);
    const route_id = string(body.route_id, 'route_id');
    const service_date = string(body.service_date ?? body.date, 'service_date');
    return store.transaction(() => store.amendBooking((request.params as { id: string }).id, { route_id, service_date, ...(body.pax === undefined ? {} : { pax: pax(body.pax) }) }) ?? notFound('Booking not found'));
  });

  app.get('/v1/manifest', async (request) => {
    const query = request.query as Record<string, unknown>;
    const route_id = string(query.route_id, 'route_id'); const service_date = string(query.date ?? query.service_date, 'date');
    return { ...store.allotment(route_id, service_date), bookings: store.listBookings(route_id, service_date) };
  });
  app.get('/operations/allotment', async (request) => {
    const query = request.query as Record<string, unknown>;
    return store.allotment(string(query.route_id, 'route_id'), string(query.service_date, 'service_date'));
  });
  app.get('/operations/deployments', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { deployments: store.listDeployments(optionalString(query.from), optionalString(query.to), optionalString(query.route_id)) };
  });
  app.post('/operations/deployments', async (request, reply) => reply.code(201).send(await store.transaction(() => store.createDeployment(deployment(request.body)))));
  app.delete('/operations/deployments/:service_date/:boat_id', async (request, reply) => {
    const params = request.params as { service_date: string; boat_id: string };
    const removed = await store.transaction(() => store.deleteDeployment(params.service_date, params.boat_id));
    if (!removed) notFound('Deployment not found');
    return reply.code(204).send();
  });

  app.get('/v1/seat-locks', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { seat_locks: store.listLocks(optionalString(query.route_id), optionalString(query.service_date ?? query.date)) };
  });
  app.post('/v1/seat-locks', async (request, reply) => reply.code(201).send(await store.transaction(() => store.createLock(lockInput(request.body)))));
  app.patch('/v1/seat-locks/:id', async (request) => {
    const body = record(request.body);
    if (body.pax !== undefined) pax(body.pax);
    if (body.agent_id !== undefined) string(body.agent_id, 'agent_id');
    return store.transaction(() => store.amendLock((request.params as { id: string }).id, body as Partial<SeatLock>) ?? notFound('Seat lock not found'));
  });
  app.post('/v1/seat-locks/:id/release', async (request) => store.transaction(() => store.releaseLock((request.params as { id: string }).id) ?? notFound('Seat lock not found')));
  done();
}
