import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// The server decides a booking's status from the save button (`intent`) and the facts, as legacy's
// save does in the browser (todo/booking-authority-model.md, phase 2). Runs against whichever store
// DATABASE_URL selects.
const app = buildApp();
after(async () => { await app.close(); });

async function request(method: InjectOptions['method'], url: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });
}
let boat = 0;
/** A day on r3 with `capacity` seats on sale and `license` registered. */
async function day(date: string, capacity = 20, license = 25) {
  const deployed = await request('POST', '/operations/deployments', { boat_id: `boat-appr-${++boat}`, route_id: 'r3', service_date: date, capacity, license_pax: license });
  assert.equal(deployed.statusCode, 201, deployed.body);
}
async function book(date: string, pax: number | Record<string, number>, extra: object = {}) {
  const created = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r3', date, pax: typeof pax === 'number' ? { ad: pax } : pax }], ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json();
}
const seatsLeft = async (date: string) => (await request('GET', `/v1/availability?route_id=r3&date=${date}`)).json().available_seats as number;
const history = async (id: string) => ((await request('GET', `/v1/bookings/${id}/history`)).json().history as { tag: string; text: string }[]).map((h) => h.text);
/** An approval without its timestamps, which differ per run. */
const shape = ({ requested_at, decided_at, ...rest }: Record<string, unknown>) => ({ ...rest, decided: decided_at !== null });

test('over the allotment but within the licence, a booking waits for approval holding no seats', async () => {
  const date = '2039-02-01';
  await day(date);
  const waiting = await book(date, 22);
  assert.equal(waiting.status, 'pending_approval');
  assert.equal(waiting.allocated_pax, 0, 'not granted yet, so it holds nothing');
  assert.equal(waiting.confirmed_at, undefined);
  assert.deepEqual(waiting.approvals.map(shape), [{
    kind: 'approval', status: 'pending', over_capacity: true, over_total: 2, discount: null, foc_count: null, target_status: 'confirmed',
    requested_by: null, decided_by: null, note: null, decided: false, days: [{ route_id: 'r3', service_date: date, need: 22, over_by: 2 }],
  }]);
  assert.equal(await seatsLeft(date), 20, 'the allotment is untouched');
  assert.deepEqual((await history(waiting.id)).slice(-1), [`Waiting for approval · over the allotment by 2 (r3 ${date} +2)`]);

  const tooMany = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r3', date, pax: { ad: 26 } }] });
  assert.equal(tooMany.statusCode, 409, 'past the registered seats there is nothing to approve');
  assert.match(tooMany.json().message, /registered seats are full \(25 left\)/);

  const quote = await book(date, 21, { intent: 'quote' });
  assert.equal(quote.status, 'pending_approval', 'a quote over the allotment waits too');
  assert.equal(quote.approvals[0].target_status, 'quote', 'and remembers it was a quote');
  assert.equal((await request('POST', `/v1/bookings/${quote.id}/approve`)).json().status, 'quote');
});

test('seats held by seat locks are refused, not sent for approval', async () => {
  const date = '2039-02-02';
  await day(date, 20, 30);
  assert.equal((await request('POST', '/v1/seat-locks', { route_id: 'r3', service_date: date, pax: 5 })).statusCode, 201);
  const blocked = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r3', date, pax: { ad: 16 } }] });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json().message, /held by seat locks/);
  const over = await book(date, 21);
  assert.equal(over.status, 'pending_approval', 'past the locked seats too, it is over the allotment');
  assert.equal(over.approvals[0].days[0].over_by, 1);
});

test('approving gives the seats; past the licence it still approves, with a warning', async () => {
  const date = '2039-02-03';
  await day(date);
  const waiting = await book(date, 22);
  const sold = await book(date, 20);
  assert.equal(sold.status, 'confirmed', 'the waiting booking did not take the seats it waits for');

  const approved = await request('POST', `/v1/bookings/${waiting.id}/approve`, { note: 'second boat coming' });
  assert.equal(approved.statusCode, 200, approved.body);
  const body = approved.json();
  assert.equal(body.status, 'confirmed');
  assert.ok(body.confirmed_at);
  assert.equal(body.allocated_pax, 22, 'now it holds its seats');
  assert.deepEqual(body.warnings, [{ code: 'over_licence', route_id: 'r3', service_date: date, over_by: 17 }], 'legacy: add a boat before the travel date');
  assert.deepEqual(body.approvals.map(shape)[0], {
    kind: 'approval', status: 'approved', over_capacity: true, over_total: 2, discount: null, foc_count: null, target_status: 'confirmed',
    requested_by: null, decided_by: null, note: 'second boat coming', decided: true, days: [{ route_id: 'r3', service_date: date, need: 22, over_by: 2 }],
  });

  const calm = '2039-02-04';
  await day(calm);
  const alone = await book(calm, 22);
  assert.deepEqual((await request('POST', `/v1/bookings/${alone.id}/approve`)).json().warnings, [], 'within the licence: no warning');

  const refused = await book(calm, 1, { price_discount: -100 });
  const rejected = (await request('POST', `/v1/bookings/${refused.id}/reject`, { note: 'too generous' })).json();
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.warnings, []);
  assert.equal(rejected.approvals[0].status, 'rejected');
  assert.equal(rejected.approvals[0].note, 'too generous');
});

test('free passengers need a reason to confirm, and wait for an FOC approval', async () => {
  const date = '2039-02-05';
  await day(date);
  const unexplained = await request('POST', '/v1/bookings', { trips: [{ routeId: 'r3', date, pax: { ad: 2, foc: 1 } }] });
  assert.equal(unexplained.statusCode, 400);
  assert.equal(unexplained.json().message, 'foc_reason is required to confirm FOC (free) passengers');

  const foc = await book(date, { ad: 2, foc: 1 }, { focReason: 'tour leader' });
  assert.equal(foc.status, 'pending_foc');
  assert.equal(foc.foc_reason, 'tour leader');
  assert.equal(foc.allocated_pax, 3, 'an FOC wait holds its seats');
  assert.deepEqual(foc.approvals.map((a: Record<string, unknown>) => [a.kind, a.status, a.foc_count, a.target_status]), [['foc', 'pending', 1, 'confirmed']]);
  const approved = (await request('POST', `/v1/bookings/${foc.id}/approve`)).json();
  assert.equal(approved.status, 'confirmed');
  assert.equal(approved.approvals[0].status, 'approved');

  const quote = await book(date, { ad: 2, foc: 1 }, { intent: 'quote' });
  assert.equal(quote.status, 'quote', 'a quote asks for nothing yet');
  assert.deepEqual(quote.approvals, []);
});

test('over the allotment with free passengers: the approval first, then the FOC approval', async () => {
  const date = '2039-02-06';
  await day(date);
  const both = await book(date, { ad: 20, foc: 1 }, { focReason: 'guide' });
  assert.equal(both.status, 'pending_approval');
  assert.deepEqual(both.approvals.map((a: Record<string, unknown>) => [a.kind, a.target_status]), [['foc', 'confirmed'], ['approval', 'pending_foc']]);
  const first = (await request('POST', `/v1/bookings/${both.id}/approve`)).json();
  assert.equal(first.status, 'pending_foc');
  assert.equal(first.allocated_pax, 21);
  assert.equal((await request('POST', `/v1/bookings/${both.id}/approve`)).json().status, 'confirmed');
});

test('a discount on a confirm waits for approval, holding its seats', async () => {
  const date = '2039-02-07';
  await day(date);
  const discounted = await book(date, 4, { price_discount: -500 });
  assert.equal(discounted.status, 'pending_approval');
  assert.equal(discounted.allocated_pax, 4);
  assert.deepEqual(discounted.approvals.map((a: Record<string, unknown>) => [a.over_capacity, a.discount, a.target_status]), [[false, 500, 'confirmed']]);
  assert.deepEqual((await history(discounted.id)).slice(-1), ['Waiting for approval · discount ฿500']);
  assert.equal((await book(date, 4, { price_discount: -500, intent: 'quote' })).status, 'quote', 'a quote is not weighed for its discount');
  assert.equal((await request('POST', `/v1/bookings/${discounted.id}/approve`)).json().status, 'confirmed');
});

test('intent decides; the deprecated status is read as the intent it meant', async () => {
  const date = '2039-02-08';
  await day(date);
  const trips = [{ routeId: 'r3', date, pax: { ad: 1 } }];
  const create = (extra: object) => request('POST', '/v1/bookings', { trips, ...extra });
  assert.equal((await create({})).json().status, 'confirmed', 'no intent: Confirm');
  assert.equal((await create({ intent: 'quote' })).json().status, 'quote');
  assert.equal((await create({ status: 'quote' })).json().status, 'quote', 'deprecated: still accepted');
  assert.equal((await create({ status: 'confirmed', intent: 'confirm' })).json().status, 'confirmed', 'agreeing is fine');

  const disagree = await create({ status: 'confirmed', intent: 'quote' });
  assert.equal(disagree.statusCode, 400);
  assert.match(disagree.json().message, /^intent quote and status confirmed disagree/);
  assert.match((await create({ intent: 'later' })).json().message, /^intent must be quote or confirm/);
  const asked = await create({ status: 'pending_approval' });
  assert.equal(asked.statusCode, 400, 'the waiting statuses are decided, never asked for');
  assert.match(asked.json().message, /^status pending_approval cannot be asked for on create/);
});

test('an edit is weighed again: growing past the allotment waits, shrinking back confirms', async () => {
  const date = '2039-02-09';
  await day(date);
  const booking = await book(date, 10);
  const patch = (body: object) => request('PATCH', `/v1/bookings/${booking.id}`, body);

  const grown = (await patch({ pax: 22 })).json();
  assert.equal(grown.status, 'pending_approval');
  assert.equal(grown.allocated_pax, 0);
  assert.equal(grown.confirmed_at, booking.confirmed_at, 'its first confirmation is kept');
  assert.deepEqual(grown.approvals.map((a: Record<string, unknown>) => [a.status, a.over_total, a.target_status]), [['pending', 2, 'confirmed']]);

  assert.equal((await patch({ notes: 'VIP' })).json().approvals.length, 1, 'a header edit leaves the request alone');
  const more = (await patch({ pax: 23 })).json();
  assert.deepEqual(more.approvals.map((a: Record<string, unknown>) => [a.status, a.over_total]), [['replaced', 2], ['pending', 3]], 'a new request replaces the old');

  const tooMany = await patch({ pax: 26 });
  assert.equal(tooMany.statusCode, 409);
  assert.equal((await request('GET', `/v1/bookings/${booking.id}`)).json().approvals.length, 2, 'a refused edit changes nothing');

  const back = (await patch({ pax: 18 })).json();
  assert.equal(back.status, 'confirmed', 'fits again: back where it was');
  assert.equal(back.allocated_pax, 18);
  assert.deepEqual(back.approvals.map((a: Record<string, unknown>) => a.status), ['replaced', 'replaced']);
  assert.deepEqual((await history(booking.id)).slice(-1), ['Fits the allotment now · confirmed']);
});
