import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// Reconfirmation (todo/trip-ops-and-vans-model.md, slice B), on whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type Rc = { status: string | null; via: string | null; at: string | null; by: string | null; sent: boolean; sent_at: string | null; sent_by: string | null } | null;
async function booking(date: string) {
  await send('POST', '/operations/deployments', { boat_id: `rc-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: { ad: 2 } });
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json() as { id: string; reconfirm: Rc };
  assert.equal(b.reconfirm, null, 'nothing recorded yet');
  return b.id;
}
const rcOf = async (id: string): Promise<Rc> => (await send('GET', `/v1/bookings/${id}`)).json().reconfirm;
const historyOf = async (id: string): Promise<string[]> => (await send('GET', `/v1/bookings/${id}/history`)).json().history.map((h: { text: string }) => h.text);

test('what the customer said is stamped by the server, and logged in legacy\'s words', async () => {
  const id = await booking('2050-01-01');
  const wa = await send('PUT', `/v1/bookings/${id}/reconfirm`, { status: 'wa', at: '2000-01-01T00:00:00Z', by: 'someone else' });
  assert.equal(wa.statusCode, 200, wa.body);
  const rc = wa.json().reconfirm;
  assert.deepEqual([rc.status, rc.via, rc.sent, rc.sent_at], ['wa', 'reconfirm', false, null]);
  assert.notEqual(rc.at, '2000-01-01T00:00:00.000Z', 'at is the server\'s');
  await send('PUT', `/v1/bookings/${id}/reconfirm`, { status: 'done', via: 'phone' });
  assert.deepEqual((await historyOf(id)).slice(-2), ['Re-confirm: WhatsApp sent · awaiting', 'Re-confirmed pickup (phone)']);

  for (const body of [{ status: 'maybe' }, { status: '' }, { status: 'done', via: 'email' }, {}]) {
    assert.equal((await send('PUT', `/v1/bookings/${id}/reconfirm`, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await send('PUT', '/v1/bookings/bk_nowhere/reconfirm', { status: 'done' })).statusCode, 404);
});

test('sending the agent\'s list is its own fact: the status never clears it, and it never sets the status', async () => {
  const [a, b, gone] = [await booking('2050-01-02'), await booking('2050-01-02'), await booking('2050-01-02')];
  await send('PUT', `/v1/bookings/${a}/reconfirm`, { status: 'noans' });
  await send('POST', `/v1/bookings/${gone}/cancel`, { category: 'sick' });

  const sent = await send('POST', '/v1/reconfirm/sent', { booking_ids: [a, b, gone], sent: true });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(sent.json().skipped, [{ id: gone, reason: 'cancelled' }], 'legacy passes over cancelled bookings');
  assert.deepEqual(sent.json().bookings.map((x: { id: string; reconfirm: Rc }) => [x.id, x.reconfirm!.status, x.reconfirm!.sent]), [[a, 'noans', true], [b, null, true]]);
  assert.equal((await historyOf(b)).at(-1), 'Re-confirm sent to agent');

  await send('PUT', `/v1/bookings/${a}/reconfirm`, { status: 'done' });
  assert.equal((await rcOf(a))!.sent, true, 'confirming keeps the list sent');
  const cleared = await send('DELETE', `/v1/bookings/${a}/reconfirm`);
  assert.deepEqual([cleared.json().reconfirm.status, cleared.json().reconfirm.sent], [null, true], 'clearing the status keeps it too');
  assert.equal((await send('DELETE', `/v1/bookings/${a}/reconfirm?all=true`)).json().reconfirm, null, 'the ops board\'s clear drops it all (legacy bkV2ReconfirmClear)');
  await send('POST', '/v1/reconfirm/sent', { booking_ids: [a], sent: true });
  const board = await send('PUT', `/v1/bookings/${a}/reconfirm`, { status: 'done', via: 'list' });
  assert.deepEqual([board.json().reconfirm.status, board.json().reconfirm.sent], ['done', false], 'the board\'s confirm replaces the record whole (legacy bkV2Reconfirm)');
  await send('DELETE', `/v1/bookings/${a}/reconfirm?all=true`);

  await send('POST', '/v1/reconfirm/sent', { booking_ids: [a, b], sent: false });
  assert.deepEqual([await rcOf(a), await rcOf(b)], [null, null], 'nothing left, no record');
  await send('PUT', `/v1/bookings/${b}/reconfirm`, { status: 'done' });
  await send('POST', '/v1/reconfirm/sent', { booking_ids: [b], sent: false });
  assert.deepEqual([(await rcOf(b))!.status, (await rcOf(b))!.sent], ['done', false]);

  assert.equal((await send('POST', '/v1/reconfirm/sent', { booking_ids: [b, 'bk_nowhere'], sent: true })).statusCode, 400);
  assert.equal((await rcOf(b))!.sent, false, 'refused whole: nothing was sent');
  assert.equal((await send('POST', '/v1/reconfirm/sent', { booking_ids: [], sent: true })).statusCode, 400);
});

test('PATCH may echo reconfirm back unchanged, and may not change it', async () => {
  const id = await booking('2050-01-03');
  await send('PUT', `/v1/bookings/${id}/reconfirm`, { status: 'callback' });
  const rc = await rcOf(id);
  const echo = await send('PATCH', `/v1/bookings/${id}`, { hotel_name: 'Kept', reconfirm: rc });
  assert.equal(echo.statusCode, 200, echo.body);
  const changed = await send('PATCH', `/v1/bookings/${id}`, { reconfirm: { ...rc, status: 'done' } });
  assert.equal(changed.statusCode, 400);
  assert.match(changed.json().message, /PUT or DELETE \/v1\/bookings\/\{id\}\/reconfirm/);
  assert.equal((await send('PATCH', `/v1/bookings/${id}`, { reconfirm: null })).statusCode, 400);
});
