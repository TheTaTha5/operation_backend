import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseBookingAddOns } from '../src/domain/booking-addons.js';

test('absent or null add-ons is an empty list', () => {
  assert.deepEqual(parseBookingAddOns(undefined), []);
  assert.deepEqual(parseBookingAddOns(null), []);
});

test('the frontend shape is read, jAd/jChd included, and nothing is filled in', () => {
  const [join, transfer] = parseBookingAddOns([
    { type: 'longtail-join', label: 'Longtail Join (2A + 0C)', amount: 800, qty: 1, note: '', jAd: 2, jChd: 0 },
    { type: ' transfer-r10-PK-van ' },
  ]);
  assert.deepEqual(join, { type: 'longtail-join', label: 'Longtail Join (2A + 0C)', amount: 800, qty: 1, note: undefined, join_adults: 2, join_children: 0 });
  assert.equal(transfer.type, 'transfer-r10-PK-van');
  assert.equal(transfer.qty, undefined, 'a missing qty stays missing, not 1');
  assert.equal(transfer.join_adults, undefined, 'a missing join count stays missing, not 0: missing means count everyone');
});

test('malformed add-ons are refused with the field and its position', () => {
  assert.throws(() => parseBookingAddOns({ type: 'x' }), /addOns must be an array/);
  assert.throws(() => parseBookingAddOns(['x']), /addOns\[0\] must be an object/);
  assert.throws(() => parseBookingAddOns([{ type: 'a' }, { label: 'no type' }]), /addOns\[1\]\.type is required/);
  assert.throws(() => parseBookingAddOns([{ type: 'a', amount: '800' }]), /addOns\[0\]\.amount must be a number/);
  assert.throws(() => parseBookingAddOns([{ type: 'a', amount: -1 }]), /addOns\[0\]\.amount must not be negative/);
  assert.throws(() => parseBookingAddOns([{ type: 'a', qty: 0 }]), /addOns\[0\]\.qty must be a positive integer/);
  assert.throws(() => parseBookingAddOns([{ type: 'a', jAd: 1.5 }]), /addOns\[0\]\.jAd must be a non-negative integer/);
  assert.throws(() => parseBookingAddOns([{ type: 'a', label: 7 }]), /addOns\[0\]\.label must be a string/);
});

// Runs against whichever store `buildApp` picks, so `DATABASE_URL=… npm test` asks PostgreSQL the
// same questions. Every booking carries an agent id unique to this run.
const app = buildApp();
after(async () => { await app.close(); });

async function request(method: InjectOptions['method'], path: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url: path }) : app.inject({ method, url: path, payload });
}

test('add-ons are kept on create, replaced on PATCH, left alone when absent, and cleared by []', async () => {
  const date = '2035-07-07';
  await request('POST', '/operations/deployments', { boat_id: 'boat-addons', route_id: 'r1', service_date: date, capacity: 30 });
  const agent = `tag_addons_${Date.now().toString(36)}`;

  const created = await request('POST', '/v1/bookings', {
    route_id: 'r1', service_date: date, pax: 2, agent_id: agent,
    addOns: [
      { type: 'longtail-join', label: 'Longtail Join (2A + 0C)', amount: 800.5, qty: 1, note: '', jAd: 2, jChd: 0 },
      { type: 'transfer-r1-PK-van', amount: 1200 },
    ],
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const expected = [
    { seq: 0, type: 'longtail-join', label: 'Longtail Join (2A + 0C)', amount: 800.5, qty: 1, join_adults: 2, join_children: 0 },
    { seq: 1, type: 'transfer-r1-PK-van', amount: 1200 },
  ];
  assert.deepEqual(created.json().add_ons, expected, 'unset fields are left out, not sent as null; amount is a number');
  assert.deepEqual((await request('GET', `/v1/bookings/${id}`)).json().add_ons, expected, 'the read answers what the write stored');

  const untouched = await request('PATCH', `/v1/bookings/${id}`, { lead_pax: 'Somchai' });
  assert.equal(untouched.statusCode, 200, untouched.body);
  assert.deepEqual(untouched.json().add_ons, expected, 'a PATCH that does not mention add-ons keeps them');

  const replaced = await request('PATCH', `/v1/bookings/${id}`, { add_ons: [{ type: 'longtail-charter', qty: 2, amount: 3000 }] });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.deepEqual(replaced.json().add_ons, [{ seq: 0, type: 'longtail-charter', qty: 2, amount: 3000 }], 'a list replaces the whole list');

  const cleared = await request('PATCH', `/v1/bookings/${id}`, { addOns: [] });
  assert.deepEqual(cleared.json().add_ons, [], '[] clears');

  const listed = await request('GET', `/v1/bookings?agent_id=${agent}`);
  assert.deepEqual(listed.json().bookings[0].add_ons, [], 'the list carries add_ons too');
});

test('a malformed add-on is a 400 and changes nothing', async () => {
  const date = '2035-07-08';
  await request('POST', '/operations/deployments', { boat_id: 'boat-addons-bad', route_id: 'r1', service_date: date, capacity: 30 });
  const agent = `tag_addons_bad_${Date.now().toString(36)}`;

  const refused = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, agent_id: agent, addOns: [{ type: 'x', amount: -5 }] });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().message, /addOns\[0\]\.amount must not be negative/);
  assert.equal((await request('GET', `/v1/bookings?agent_id=${agent}`)).json().total, 0, 'nothing was written');

  const created = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, agent_id: agent, addOns: [{ type: 'longtail-join' }] });
  const id = created.json().id as string;
  const bad = await request('PATCH', `/v1/bookings/${id}`, { add_ons: [{ qty: 1 }] });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /add_ons\[0\]\.type is required/, 'the error names the key the caller used');
  assert.deepEqual((await request('GET', `/v1/bookings/${id}`)).json().add_ons, [{ seq: 0, type: 'longtail-join' }]);
});
