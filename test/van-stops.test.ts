import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { createStore } from '../src/routes/operations.js';

// Van stops (todo/van-extras-model.md), on whichever store DATABASE_URL selects. Route r1 comes from
// migration 006; the in-process store is seeded with it.
const store = createStore();
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Tratato', pier: 'tublamu' }] });
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });

/** A day on r1 with a boat, a van of `capacity` on the programme, and a group of `pax` adults on it. */
async function groupWithVan(date: string, capacity: number, pax: number) {
  await send('POST', '/operations/deployments', { boat_id: `vs-boat-${date}`, route_id: 'r1', service_date: date, capacity: 60 });
  const van = (await send('POST', '/operations/vans', { name: `Van ${date}`, capacity })).json();
  await send('PUT', `/operations/van-days/${date}/${van.id}`, { route_ids: ['r1'] });
  const booking = (await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: { ad: pax }, zone: 'PK' }] })).json();
  const group = await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: booking.trips[0].id }], van_id: van.id });
  assert.equal(group.statusCode, 201, group.body);
  return { van, group: group.json() as { id: string; number: number } };
}
const guide = (groupId: string, fields: object = {}) => send('POST', '/operations/van-stops', { group_id: groupId, kind: 'staff', label: 'Guide Nok', pax: 1, place: 'Office', ...fields });
const groupNow = async (date: string, id: string) => ((await send('GET', `/operations/van-groups?service_date=${date}&route_id=r1`)).json().groups as { id: string; pax: number; customer_pax: number; stop_seats: number; over_capacity: boolean; stops: { id: string }[] }[]).find((g) => g.id === id);

test('a stop rides a group\'s van; legacy\'s form rules', async () => {
  const date = '2049-01-01';
  const { group } = await groupWithVan(date, 10, 2);
  const created = await guide(group.id, { time: '06:20', leg: 'both', phone: '089', area: 'Patong', area_id: 'pa_patong' });
  assert.equal(created.statusCode, 201, created.body);
  const stop = created.json();
  assert.deepEqual([stop.service_date, stop.route_id, stop.group_id, stop.kind, stop.pax, stop.leg, stop.checked_in], [date, 'r1', group.id, 'staff', 1, 'both', null]);
  assert.match(stop.id, /^vs_/);

  const noVan = await send('POST', '/operations/van-groups', { service_date: date, route_id: 'r1', zone: 'PK', members: [{ trip_id: (await send('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date, pax: { ad: 1 }, zone: 'PK' }] })).json().trips[0].id }] });
  const refused = await guide(noVan.json().id);
  assert.deepEqual([refused.statusCode, refused.json().code], [409, 'group_has_no_van']);
  for (const [fields, message] of [
    [{ label: ' ' }, /Type what this stop is for/], [{ place: null }, /Type where the van stops/], [{ pax: 0 }, /Enter at least 1/],
    [{ time: '7.15' }, /time must be HH:MM/], [{ leg: 'sideways' }, /leg must be one of out, ret, both/], [{ group_id: 'vgrp_nowhere' }, /not found/],
  ] as const) {
    const bad = await guide(group.id, fields);
    assert.equal(bad.statusCode, 400, bad.body);
    assert.match(bad.json().message, message);
  }
  const cargo = await send('POST', '/operations/van-stops', { group_id: group.id, kind: 'cargo', label: 'Life jackets', pax: 5, place: 'Office' });
  assert.equal(cargo.json().pax, 0, 'cargo carries nobody');
});

test('a guide riding along takes seats: counted in the group, checked unless seats_anyway', async () => {
  const date = '2049-01-02';
  const { group } = await groupWithVan(date, 4, 3);
  const over = await guide(group.id, { pax: 2 });
  assert.deepEqual([over.statusCode, over.json().code], [409, 'van_over_capacity']);
  assert.match(over.json().message, /needs 5 seats/);
  assert.equal((await guide(group.id, { pax: 2, leg: 'ret' })).statusCode, 201, 'only the return leg: no outbound seat');
  const anyway = await guide(group.id, { pax: 2, seats_anyway: true });
  assert.equal(anyway.statusCode, 201, 'legacy\'s "Add anyway?"');
  const view = await groupNow(date, group.id);
  assert.deepEqual([view!.pax, view!.customer_pax, view!.stop_seats, view!.over_capacity, view!.stops.length], [5, 3, 2, true, 2]);

  const edit = await send('PATCH', `/operations/van-stops/${anyway.json().id}`, { note: 'sits up front' });
  assert.equal(edit.statusCode, 200, 'an edit that takes no more seats is not checked');
  assert.equal((await send('PATCH', `/operations/van-stops/${anyway.json().id}`, { pax: 3 })).json().code, 'van_over_capacity');
});

test('check-in, the day\'s list in pickup order, and a disbanded group leaves its stops on the day', async () => {
  const date = '2049-01-03';
  const { group } = await groupWithVan(date, 10, 2);
  const late = (await guide(group.id, { label: 'Late', time: '07:30' })).json();
  const early = (await guide(group.id, { label: 'Early', time: '06:00' })).json();
  const first = (await guide(group.id, { label: 'Ordered', sequence: 1 })).json();
  const list = async () => ((await send('GET', `/operations/van-stops?service_date=${date}&route_id=r1`)).json().stops as { label: string; group_id: string | null }[]);
  assert.deepEqual((await list()).map((x) => x.label), ['Ordered', 'Early', 'Late'], 'the manual order, then time');

  const checked = await send('PUT', `/operations/van-stops/${early.id}/check-in`);
  assert.equal(checked.json().checked_in.seats, 1);
  assert.ok(checked.json().checked_in.at);
  assert.equal((await send('DELETE', `/operations/van-stops/${early.id}/check-in`)).json().checked_in, null);

  assert.equal((await send('DELETE', `/operations/van-groups/${group.id}`)).statusCode, 204);
  assert.deepEqual((await list()).map((x) => x.group_id), [null, null, null]);
  assert.equal((await send('DELETE', `/operations/van-stops/${late.id}`)).statusCode, 204);
  assert.equal((await send('DELETE', `/operations/van-stops/${late.id}`)).statusCode, 404);
  assert.equal((await send('PATCH', `/operations/van-stops/${first.id}`, { label: 'Still here' })).statusCode, 200);
});
