import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// A save from a stale copy is refused instead of overwriting someone else's edit
// (todo/booking-concurrency-model.md). Runs against whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());

const send = (method: InjectOptions['method'], url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
const newBooking = async (date: string) => {
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, version: 99 });
  assert.equal(created.statusCode, 201, created.body);
  return created;
};

test('a booking starts at version 1, whatever the client sends, and every write adds one', async () => {
  const created = await newBooking('2042-01-01');
  assert.equal(created.json().version, 1, 'version is the server\'s');
  assert.equal(created.headers.etag, '"1"');
  const id = created.json().id as string;
  assert.equal((await send('GET', `/v1/bookings/${id}`)).headers.etag, '"1"');

  const patched = await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'A' });
  assert.equal(patched.json().version, 2, 'without If-Match the write goes through, as before');
  const cancelled = await send('POST', `/v1/bookings/${id}/cancel`, { category: 'sick' });
  assert.equal(cancelled.json().version, 3, 'a command is a write too');
  assert.equal((await send('POST', `/v1/bookings/${id}/confirm`, {})).statusCode, 409);
  assert.equal((await send('GET', `/v1/bookings/${id}`)).json().version, 3, 'a refused write changes nothing');
});

test('two people edit the same booking: the second save, made from the old copy, is refused', async () => {
  const id = (await newBooking('2042-01-02')).json().id as string;
  const first = await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'Somchai' }, { 'if-match': '"1"' });
  assert.equal(first.statusCode, 200, first.body);
  const second = await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'Malee' }, { 'if-match': '"1"' });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'stale_version');
  assert.equal(second.json().message, `Booking ${id} has changed since you read it (you have version 1, it is now 2); reload and try again`);
  assert.equal((await send('GET', `/v1/bookings/${id}`)).json().lead_pax, 'Somchai', 'the first edit survives');

  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'Malee', version: 2 })).statusCode, 200, 'or in the body');
  assert.equal((await send('POST', `/v1/bookings/${id}/cancel`, { category: 'sick', version: 2 })).statusCode, 409, 'commands check it too');
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'X' }, { 'if-match': 'yesterday' })).statusCode, 400);
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'X', version: 3 }, { 'if-match': '"2"' })).statusCode, 400, 'two that disagree');
});

test('a seat lock has a version too, and the client sets only its pax and agent', async () => {
  const created = await send('POST', '/v1/seat-locks', { route_id: 'r1', service_date: '2042-01-03', pax: 2, version: 99 });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().version, 1);
  const id = created.json().id as string;

  const grown = await send('PATCH', `/v1/seat-locks/${id}`, { pax: 3, status: 'released', version: 1 });
  assert.equal(grown.statusCode, 200, grown.body);
  assert.deepEqual([grown.json().pax, grown.json().status, grown.json().version], [3, 'active', 2], 'status is not a client fact');
  assert.equal((await send('PATCH', `/v1/seat-locks/${id}`, { pax: 4 }, { 'if-match': '"1"' })).json().code, 'stale_version');
  assert.equal((await send('POST', `/v1/seat-locks/${id}/release`, {}, { 'if-match': '"1"' })).statusCode, 409);
  const released = await send('POST', `/v1/seat-locks/${id}/release`, {}, { 'if-match': '"2"' });
  assert.deepEqual([released.json().status, released.json().version], ['released', 3]);
  assert.equal((await send('POST', `/v1/seat-locks/${id}/release`, {})).json().version, 3, 'releasing twice changes nothing');
});
