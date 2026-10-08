import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// A booking's discounts and extras (todo/adjustments-model.md), kept as a list instead of being
// dropped on save. Runs against whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });

const discount = { kind: 'discount', mode: 'percent', value: 10, label: 'Discount', note: 'repeat agent' };
const extra = { kind: 'extra', value: 500, label: 'Extra charge' };

test('a booking keeps its adjustments in order, as legacy sends them', async () => {
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: '2043-01-01', pax: 2, adjustments: [discount, extra] });
  assert.equal(created.statusCode, 201, created.body);
  const expected = [{ seq: 0, ...discount }, { seq: 1, kind: 'extra', mode: 'amount', value: 500, label: 'Extra charge' }];
  assert.deepEqual(created.json().adjustments, expected, 'mode defaults to amount; an unset note is left off');
  assert.deepEqual((await send('GET', `/v1/bookings/${created.json().id}`)).json().adjustments, expected);
  assert.deepEqual((await send('POST', '/v1/bookings', { route_id: 'r1', service_date: '2043-01-01', pax: 1 })).json().adjustments, [], 'none by default');
});

test('an edit replaces the list, leaves it when absent, and clears it with [] or null', async () => {
  const id = (await send('POST', '/v1/bookings', { route_id: 'r1', service_date: '2043-01-02', pax: 1, adjustments: [discount] })).json().id as string;
  const kept = await send('PATCH', `/v1/bookings/${id}`, { lead_pax: 'A' });
  assert.equal(kept.json().adjustments.length, 1, 'absent leaves it');
  const replaced = await send('PATCH', `/v1/bookings/${id}`, { adjustments: [extra] });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.deepEqual(replaced.json().adjustments.map((a: { kind: string }) => a.kind), ['extra']);
  assert.ok(replaced.json().version > kept.json().version, 'a change is a write');
  const history = (await send('GET', `/v1/bookings/${id}/history`)).json().history as { text: string }[];
  assert.match(history.at(-1)!.text, /adjustments/);
  assert.deepEqual((await send('PATCH', `/v1/bookings/${id}`, { adjustments: [] })).json().adjustments, []);
  await send('PATCH', `/v1/bookings/${id}`, { adjustments: [extra] });
  assert.deepEqual((await send('PATCH', `/v1/bookings/${id}`, { adjustments: null })).json().adjustments, [], 'null clears too');
});

test('a malformed adjustment is refused naming its row, never dropped', async () => {
  const refused = async (adjustment: object, message: string) => {
    const response = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: '2043-01-03', pax: 1, adjustments: [extra, adjustment] });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().message, message);
  };
  await refused({ kind: 'bonus', value: 1 }, 'adjustments[1].kind must be discount or extra');
  await refused({ kind: 'discount', mode: 'half', value: 1 }, 'adjustments[1].mode must be amount or percent');
  await refused({ kind: 'discount', value: 0 }, 'adjustments[1].value must be a number above 0');
  await refused({ kind: 'extra', value: '500' }, 'adjustments[1].value must be a number above 0');
  assert.equal((await send('POST', '/v1/bookings', { route_id: 'r1', service_date: '2043-01-03', pax: 1, adjustments: 'none' })).statusCode, 400);
});
