import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// The change feed (todo/change-feed-model.md), on whichever store DATABASE_URL selects. Other files
// write in parallel on PostgreSQL, so each test looks only at the records it made.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type Change = { version: number; kind: string; entity_id: string; action: string; route_days: { route_id: string; service_date: string }[] | null };
const version = async (): Promise<number> => (await send('GET', '/v1/changes')).json().version;
const since = async (v: number): Promise<Change[]> => (await send('GET', `/v1/changes?since=${v}`)).json().changes;
const about = (changes: Change[], id: string) => changes.filter((c) => c.entity_id === id);

test('a booking\'s create and edit are recorded with the days whose seats they touched; a refused write records nothing', async () => {
  const [d1, d2] = ['2055-01-01', '2055-01-02'];
  for (const d of [d1, d2]) await send('POST', '/operations/deployments', { boat_id: 'cf-boat', route_id: 'r1', service_date: d, capacity: 40 });
  const start = await version();
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: d1, pax: 2 });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const moved = await send('PATCH', `/v1/bookings/${id}`, { trips: [{ id: created.json().trips[0].id, route_id: 'r1', date: d2, pax: 2 }] });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { pax: -1 })).statusCode, 400);

  const mine = about(await since(start), id);
  assert.deepEqual(mine.map((c) => [c.kind, c.action]), [['booking', 'created'], ['booking', 'updated']], 'one row per write; the refused one left none');
  assert.deepEqual(mine[1].route_days, [{ route_id: 'r1', service_date: d1 }, { route_id: 'r1', service_date: d2 }], 'the day it left and the day it went to');
  assert.ok(mine[0].version < mine[1].version);
  const health = (await send('GET', '/v1/changes')).json().health;
  assert.equal(typeof health.migrations_pending, 'number');
  assert.equal((await send('GET', '/v1/changes?since=-1')).statusCode, 400);
});

test('seat locks and deployments are recorded; a dispatch write is the booking\'s change', async () => {
  const date = '2055-01-03';
  const start = await version();
  await send('POST', '/operations/deployments', { boat_id: 'cf-boat-2', route_id: 'r1', service_date: date, capacity: 40 });
  const lock = (await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: date, pax: 2 })).json();
  const booking = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1 })).json();
  await send('PATCH', `/operations/trip-ops/${booking.trips[0].id}`, { boat_id: 'cf-boat-2' });
  await send('DELETE', `/operations/deployments/${date}/cf-boat-2?remove_anyway=true`);

  const all = await since(start);
  assert.deepEqual(about(all, lock.id).map((c) => [c.kind, c.action]), [['seat_lock', 'created']]);
  assert.deepEqual(about(all, `${date}:cf-boat-2`).map((c) => c.action), ['created', 'deleted']);
  assert.deepEqual(about(all, booking.id).map((c) => c.action), ['created', 'updated'], 'the boat set on its trip');
});

test('a bulk lock records every departure it made; a draw records the lock it drew on', async () => {
  const start = await version();
  const group = (await send('POST', '/v1/seat-lock-groups', { route_id: 'r1', date_from: '2055-01-05', date_to: '2055-01-06', pax: 2 })).json();
  const ids = group.seat_locks.map((l: { id: string }) => l.id);
  const all = await since(start);
  assert.deepEqual(ids.map((id: string) => about(all, id).map((c) => c.action)), [['created'], ['created']]);
  const mid = await version();
  await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date: '2055-01-05', pax: 1, lock_draws: { [ids[0]]: 1 } }] });
  assert.deepEqual(about(await since(mid), ids[0]).map((c) => [c.kind, c.action]), [['seat_lock', 'updated']], 'its drawn_pax moved');
});

test('the stream sends what changed, as it commits', async () => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const date = '2055-01-04';
  await send('POST', '/operations/deployments', { boat_id: 'cf-boat-3', route_id: 'r1', service_date: date, capacity: 40 });
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/changes/stream`, { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader();
  const created = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1 })).json();
  let text = '';
  const deadline = Date.now() + 5000;
  while (!text.includes(`"entity_id":"${created.id}"`) && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.match(text, /retry: 5000/);
  assert.match(text, new RegExp(`id: \\d+\\nevent: change\\ndata: \\{[^\\n]*"entity_id":"${created.id}"`));
});
