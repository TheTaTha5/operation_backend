import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// The allergy list and the pier's meal editor (todo/booking-extras-model.md §2), on whichever store
// DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type B = { id: string; allergy_list: { name: string; qty: number }[]; allergy_count: number; special_meals_veg?: number; special_meals_allergies?: string; special_meals_pier_at?: string; special_meals_pier_by?: string };
async function booking(date: string, extra: object) {
  await send('POST', '/operations/deployments', { boat_id: `al-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 6, ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as B;
}

test('the allergy list merges a name given twice, and the kitchen counts its people, or 1 for free text alone', async () => {
  const b = await booking('2051-03-01', { specialMeals: { allergies: 'no spicy', allergyList: [{ name: 'Peanut', qty: 1 }, { name: ' peanut ', qty: 2 }, { name: 'Shellfish' }] } });
  assert.deepEqual(b.allergy_list, [{ name: 'Peanut', qty: 3 }, { name: 'Shellfish', qty: 1 }], 'legacy\'s add button adds to a name already listed');
  assert.equal(b.allergy_count, 4);
  const cleared = await send('PATCH', `/v1/bookings/${b.id}`, { allergy_list: [] });
  assert.deepEqual([cleared.json().allergy_list, cleared.json().allergy_count], [[], 1], 'free text alone counts 1 (legacy bkV2AllergyCount)');
  for (const bad of [{ allergy_list: [{ name: ' ' }] }, { allergy_list: [{ name: 'Egg', qty: 0 }] }, { allergy_list: 'Egg' }]) {
    assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, { allergy_count: 9 })).json().allergy_count, 1, 'a sent count is not taken');
});

test('the pier\'s meal editor stamps who changed the meals there; an edit may only echo the stamp', async () => {
  const b = await booking('2051-03-02', {});
  const pier = await send('PUT', `/v1/bookings/${b.id}/meals`, { veg: 2, allergies: 'nuts' });
  assert.equal(pier.statusCode, 200, pier.body);
  const m = pier.json() as B;
  assert.deepEqual([m.special_meals_veg, m.special_meals_allergies], [2, 'nuts']);
  assert.ok(m.special_meals_pier_at, 'stamped');
  assert.equal((await send('PUT', `/v1/bookings/${b.id}/meals`, {})).statusCode, 400);

  const echo = await send('PATCH', `/v1/bookings/${b.id}`, { special_meals_pier_at: m.special_meals_pier_at, hotel_name: 'Kept' });
  assert.equal(echo.statusCode, 200, echo.body);
  const changed = await send('PATCH', `/v1/bookings/${b.id}`, { specialMeals: { pierBy: 'someone' } });
  assert.equal(changed.statusCode, 400);
  assert.match(changed.json().message, /PUT \/v1\/bookings\/\{id\}\/meals/);
  assert.equal((await send('POST', '/v1/bookings', { route_id: 'r1', service_date: '2051-03-02', pax: 1, specialMeals: { pierAt: '2051-03-02T01:00:00Z' } })).statusCode, 400, 'a create may not set it');
});
