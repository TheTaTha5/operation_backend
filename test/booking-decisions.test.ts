import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { todayInThailand } from '../src/domain/calendar.js';

// The developer's decisions of 2026-10-10 on the booking rules that differed from legacy
// (todo/booking-model.md): through the API, logins on, on whichever store DATABASE_URL selects.
process.env.AUTH_JWT_SECRET = 'booking-decisions-secret';
const { buildApp } = await import('../src/app.js');
const { seedAgents, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = Date.now().toString(36);
let admin: { authorization: string } | undefined;
async function login() {
  if (admin) return admin;
  await seedAgents(store, [], { bd_a1: null, a_company: null, a_walkin: null });
  await seedUser(store, { username: `bd.admin.${run}`, role: 'admin' });
  admin = await tokenFor(app, `bd.admin.${run}`);
  return admin;
}
const send = async (method: InjectOptions['method'], url: string, payload?: object, version?: number) =>
  app.inject({ method, url, headers: { ...(await login()), ...(version === undefined ? {} : { 'if-match': `"${version}"` }) }, ...(payload ? { payload } : {}) });
const ok = (res: { statusCode: number; body: string }, status = 200): Json => { assert.equal(res.statusCode, status, res.body); return JSON.parse(res.body || 'null'); };
const refused = (res: { statusCode: number; body: string }, status: number, code?: string): string => {
  assert.equal(res.statusCode, status, res.body);
  if (code) assert.equal(JSON.parse(res.body).code, code, res.body);
  return JSON.parse(res.body).message as string;
};
/** A booking write: the version it read is required of a login (If-Match). */
const write = (method: InjectOptions['method'], b: Json, path: string, payload?: object) => send(method, `/v1/bookings/${b.id}${path}`, payload ?? {}, b.version);
const history = async (id: string) => (ok(await send('GET', `/v1/bookings/${id}/history`)).history as { text: string }[]).map((h) => h.text);
const seatsLeft = async (route: string, date: string) => ok(await send('GET', `/v1/availability?route_id=${route}&date=${date}`)).available_seats as number;
const deploy = async (boat: string, route: string, date: string, capacity: number, extra: object = {}) =>
  ok(await send('POST', '/operations/deployments', { boat_id: boat, route_id: route, service_date: date, capacity, ...extra }), 201);

let rate: string | undefined;
/** A rate type covering r1 zone PK and a speedboat charter on r1, nothing else. */
async function std(): Promise<string> {
  if (rate) return rate;
  rate = ok(await send('POST', '/v1/rate-types', {
    name: `BD ${run}`, routes: [{ route_id: 'r1', zones: { PK: { net: { ad_fr: 1000, ad_th: 800 } } }, charter: { speedboat: { starter_price: 30000, starter_includes: 10, extra_per_pax: 1000 } } }],
  }), 201).id as string;
  return rate;
}
const seat = (date: string, fields: object = {}) => ({ routeId: 'r1', date, zone: 'PK', pax: { ad_fr: 2 }, ...fields });

// ── 1. No price: refused, like legacy ─────────────────────────────────────────────────────────────

test('a rate-priced trip with no rate for its route and zone is refused on create and on a price-changing edit; a quote only warns', async () => {
  const rt = await std();
  const date = '2074-01-05';
  const noRate = await send('POST', '/v1/bookings', { agent_id: 'bd_a1', rate_type_ref: rt, trips: [seat(date, { zone: 'KL' })] });
  assert.equal(refused(noRate, 409, 'no_rate'), `No rate · 1 trip · cannot save: the rate type doesn't cover trips[0] (r1 ${date} zone KL). Fix the rate type, or change the route or zone`);
  const quoted = ok(await send('POST', '/v1/quote', { agent_id: 'bd_a1', rate_type_ref: rt, trips: [seat(date, { zone: 'KL' })] }));
  assert.deepEqual(quoted.warnings.map((w: Json) => w.code), ['not_offered'], 'POST /v1/quote answers warnings only');

  const b = ok(await send('POST', '/v1/bookings', { agent_id: 'bd_a1', rate_type_ref: rt, trips: [seat(date)] }), 201);
  assert.equal(b.total, 2000);
  refused(await write('PATCH', b, '', { trips: [seat(date, { zone: 'KL' })] }), 409, 'no_rate');
  assert.equal(ok(await send('GET', `/v1/bookings/${b.id}`)).trips[0].zone, 'PK', 'a refused edit changes nothing');
  ok(await write('PATCH', b, '', { lead_pax: 'Somchai' }), 200);

  // A trip with no zone yet is not priced and not refused, as legacy's screen; nor is a hand price or a B2C booking.
  const zoneless = ok(await send('POST', '/v1/bookings', { agent_id: 'bd_a1', rate_type_ref: rt, trips: [{ routeId: 'r1', date, pax: { ad_fr: 1 } }] }), 201);
  assert.deepEqual(zoneless.price_warnings.map((w: Json) => w.code), ['not_offered']);

  ok(await send('POST', '/v1/bookings', { agent_id: 'a_walkin', price_mode: 'manual', manual_total: 900, trips: [seat(date, { zone: 'KL' })] }), 201);
  const b2c = ok(await send('POST', '/v1/bookings', { agent_id: 'a_b2c', external_id: `LOV-bd-${run}`, total: 4321, trips: [seat(date, { zone: 'KL' })] }), 201);
  assert.equal(b2c.total, 4321, 'Love Kingdom prices a B2C booking');
});

test('a charter with no charter price is refused unless free_anyway; an agreed price needs no flag', async () => {
  const rt = await std();
  const date = '2074-01-06';
  const boat = ok(await send('POST', '/v1/boats', { name: `BD cat ${run}`, pier: 'tublamu', type: 'Catamaran', capacity: 30, license_pax: 35 }), 201);
  await deploy(boat.id, 'r1', date, 30);
  const charter = (fields: object = {}) => ({ agent_id: 'bd_a1', rate_type_ref: rt, trips: [{ routeId: 'r1', date, booking_mode: 'charter', charter_boat_id: boat.id, pax: { ad_fr: 6 }, ...fields }] });
  assert.match(refused(await send('POST', '/v1/bookings', charter()), 409, 'no_charter_price'), /^Charter trip will be saved at 0 THB: trips\[0\] \(r1 2074-01-06\) boat .*free_anyway: true if this charter is really free$/);
  refused(await send('POST', '/v1/bookings', { ...charter(), free_anyway: 'yes' }), 400);
  const free = ok(await send('POST', '/v1/bookings', { ...charter(), free_anyway: true }), 201);
  assert.deepEqual([free.total, free.price_warnings.map((w: Json) => w.code)], [0, ['no_charter_price']]);
  ok(await write('POST', free, '/cancel', { category: 'other', note: 'test' }));
  const agreed = ok(await send('POST', '/v1/bookings', charter({ charter_price_mode: 'manual', charter_price_manual: 25000 })), 201);
  assert.equal(agreed.total, 25000);
});

// ── 2. Restore always restores: test/booking-actions.test.ts ─────────────────────────────────────

// ── 3. Chartering a boat with seats sold on it ────────────────────────────────────────────────────

test('a charter displacing sold seats is refused, and with displace_anyway goes through, oversold knowingly and acknowledged on the trip', async () => {
  const date = '2074-02-01';
  await deploy(`bd-x-${run}`, 'r2', date, 10);
  await deploy(`bd-y-${run}`, 'r2', date, 10);
  ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r2', date, pax: { ad_fr: 15 } }] }), 201);
  const charter = { trips: [{ routeId: 'r2', date, booking_mode: 'charter', charter_boat_id: `bd-x-${run}`, pax: { ad_fr: 6 } }] };
  assert.equal(refused(await send('POST', '/v1/bookings', charter), 409, 'charter_displaces_seats'),
    `Insufficient available seats on r2 ${date}: chartering bd-x-${run} takes seats already sold (15 sold, 0 available after, oversold by 5). Send displace_anyway: true to charter it anyway`);
  refused(await send('POST', '/v1/bookings', { ...charter, displace_anyway: 1 }), 400);

  // The acknowledgement is the server's: a trip that claims one is overridden.
  const forged = { trips: [{ ...charter.trips[0], charter_displaced_by: 'mallory', charter_displaced_at: '2020-01-01T00:00:00.000Z' }] };
  const done = ok(await send('POST', '/v1/bookings', { ...forged, displace_anyway: true }), 201);
  assert.deepEqual(done.warnings, [{ code: 'charter_displaced', route_id: 'r2', service_date: date, boat_ids: [`bd-x-${run}`], seats_sold: 15, available_after: 0, oversold_by: 5 }]);
  assert.equal(done.trips[0].charter_displaced_by, `bd.admin.${run}`);
  assert.ok(Date.parse(done.trips[0].charter_displaced_at) > Date.parse('2026-01-01'), 'stamped now');
  assert.equal(await seatsLeft('r2', date), -5);
  assert.equal((await history(done.id)).at(-1), `Chartered anyway · bd-x-${run} on r2 ${date} · 15 seats sold, oversold by 5`);

  // An edit that keeps the boat keeps the acknowledgement, and asks nothing; one that sends the trip back with a forged one changes nothing.
  const named = ok(await write('PATCH', done, '', { lead_pax: 'Charter', trips: forged.trips }));
  assert.deepEqual([named.trips[0].charter_displaced_by, named.trips[0].charter_displaced_at, named.warnings], [done.trips[0].charter_displaced_by, done.trips[0].charter_displaced_at, undefined]);

  // A charter that displaces nothing gets no acknowledgement, whatever it sends.
  const calm = '2074-02-02';
  await deploy(`bd-z-${run}`, 'r2', calm, 10);
  const plain = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r2', date: calm, booking_mode: 'charter', charter_boat_id: `bd-z-${run}`, pax: { ad_fr: 4 }, charter_displaced_at: '2020-01-01T00:00:00.000Z' }], displace_anyway: true }), 201);
  assert.deepEqual([plain.trips[0].charter_displaced_at, plain.warnings], [undefined, undefined]);
});

// ── 4. A quote's charter boat ─────────────────────────────────────────────────────────────────────

test('a quote\'s charter holds the pool but not the boat: it can be pulled off its route; a confirmed charter\'s cannot', async () => {
  const date = '2074-02-10';
  await deploy(`bd-q-${run}`, 'r3', date, 10);
  await deploy(`bd-c-${run}`, 'r3', date, 10);
  const charter = (boat: string, intent: string) => ({ intent, trips: [{ routeId: 'r3', date, booking_mode: 'charter', charter_boat_id: boat, pax: { ad_fr: 4 } }] });
  ok(await send('POST', '/v1/bookings', charter(`bd-q-${run}`, 'quote')), 201);
  ok(await send('POST', '/v1/bookings', charter(`bd-c-${run}`, 'confirm')), 201);
  const days = ok(await send('GET', `/v1/availability?route_id=r3&from=${date}&to=${date}`)).days[0].deployments as Json[];
  assert.deepEqual(days.map((d) => d.chartered), [true, true], 'the pool counts both boats chartered (legacy baCharterBoatMap)');
  refused(await send('DELETE', `/operations/deployments/${date}/bd-c-${run}?remove_anyway=true`), 409, 'charter_boat');
  // A quote does not claim the boat in Boat Operation: it is a booking placed on it, pulled as any other is.
  refused(await send('DELETE', `/operations/deployments/${date}/bd-q-${run}`), 409, 'seats_sold');
  const pulled = ok(await send('DELETE', `/operations/deployments/${date}/bd-q-${run}?remove_anyway=true`));
  assert.deepEqual(pulled.warnings.map((w: Json) => [w.code, w.bookings, w.pax]), [['boat_pulled', 1, 4]]);
});

// ── 5. A discount with FOC passengers ─────────────────────────────────────────────────────────────

test('a discount is asked for only when the save would be confirmed: FOC goes to pending_foc, and approving it confirms', async () => {
  const rt = await std();
  const date = '2074-03-01';
  const discount = [{ kind: 'discount', value: 100 }];
  const foc = ok(await send('POST', '/v1/bookings', { agent_id: 'bd_a1', rate_type_ref: rt, foc_reason: 'Guide', adjustments: discount, trips: [seat(date, { pax: { ad_fr: 2, foc_fr: 1 } })] }), 201);
  assert.equal(foc.status, 'pending_foc');
  assert.deepEqual(foc.approvals.map((a: Json) => a.kind), ['foc'], 'no discount approval');
  assert.equal(ok(await write('POST', foc, '/approve')).status, 'confirmed');

  const plain = ok(await send('POST', '/v1/bookings', { agent_id: 'bd_a1', rate_type_ref: rt, adjustments: discount, trips: [seat(date)] }), 201);
  assert.deepEqual([plain.status, plain.approvals.map((a: Json) => [a.kind, a.reason, a.discount])], ['pending_approval', [['approval', 'discount', 100]]], 'without FOC, as before');
});

// ── 6. An edit asks again only for what it raises ────────────────────────────────────────────────

test('an edit that raises the FOC count or the discount above what was approved asks again; an unchanged one does not', async () => {
  const rt = await std();
  const date = '2074-03-05';
  let b = ok(await send('POST', '/v1/bookings', { agent_id: 'bd_a1', rate_type_ref: rt, trips: [seat(date)] }), 201);
  assert.equal(b.status, 'confirmed');
  refused(await write('PATCH', b, '', { trips: [seat(date, { pax: { ad_fr: 2, foc_fr: 1 } })] }), 400);
  b = ok(await write('PATCH', b, '', { foc_reason: 'Guide', trips: [seat(date, { pax: { ad_fr: 2, foc_fr: 1 } })] }));
  assert.equal(b.status, 'pending_foc', 'an added FOC passenger waits for its approval');
  assert.deepEqual(b.approvals.filter((a: Json) => a.status === 'pending').map((a: Json) => [a.kind, a.foc_count]), [['foc', 1]]);
  assert.equal((await history(b.id)).at(-1), 'Waiting for FOC approval · 1 FOC pax');
  b = ok(await write('POST', b, '/approve'));
  assert.equal(b.status, 'confirmed');

  b = ok(await write('PATCH', b, '', { lead_pax: 'Same', trips: [seat(date, { pax: { ad_fr: 2, foc_fr: 1 } })] }));
  assert.equal(b.status, 'confirmed', 'the approved count is not asked again');
  b = ok(await write('PATCH', b, '', { trips: [seat(date, { pax: { ad_fr: 3 } })] }));
  b = ok(await write('PATCH', b, '', { trips: [seat(date, { pax: { ad_fr: 2, foc_fr: 1 } })] }));
  assert.equal(b.status, 'confirmed', 'back to what was approved');
  b = ok(await write('PATCH', b, '', { trips: [seat(date, { pax: { ad_fr: 1, foc_fr: 2 } })] }));
  assert.deepEqual([b.status, b.approvals.at(-1).foc_count], ['pending_foc', 2], 'more than was approved');
  b = ok(await write('POST', b, '/approve'));

  b = ok(await write('PATCH', b, '', { adjustments: [{ kind: 'discount', value: 200 }] }));
  assert.deepEqual([b.status, b.approvals.at(-1).kind, b.approvals.at(-1).discount], ['pending_approval', 'approval', 200], 'a discount added to a confirmed booking');
  b = ok(await write('POST', b, '/approve'));
  assert.equal(b.status, 'confirmed');
  b = ok(await write('PATCH', b, '', { adjustments: [{ kind: 'discount', value: 200 }], lead_pax: 'Again' }));
  assert.equal(b.status, 'confirmed', 'the approved discount is not asked again');
  b = ok(await write('PATCH', b, '', { adjustments: [{ kind: 'discount', value: 300 }] }));
  assert.deepEqual([b.status, b.approvals.at(-1).discount], ['pending_approval', 300]);
});

// ── 7. Editing a closed booking ───────────────────────────────────────────────────────────────────

test('a cancelled, rejected or completed booking is edited with edit_anyway; a weather-cancelled one freely', async () => {
  const date = '2074-04-01';
  await deploy(`bd-e-${run}`, 'r1', date, 20);
  let cancelled = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date, pax: { ad_fr: 2 } }] }), 201);
  cancelled = ok(await write('POST', cancelled, '/cancel', { category: 'sick' }));
  assert.equal(refused(await write('PATCH', cancelled, '', { lead_pax: 'X' }), 409, 'booking_closed'), 'This booking is cancelled. Edit anyway? Send edit_anyway: true to save the edit');
  refused(await write('PATCH', cancelled, '', { lead_pax: 'X', edit_anyway: 'sure' }), 400);
  const edited = ok(await write('PATCH', cancelled, '', { lead_pax: 'X', edit_anyway: true }));
  assert.deepEqual([edited.lead_pax, edited.status, edited.allocated_pax], ['X', 'cancelled', 0], 'still cancelled, holding nothing');
  assert.equal(await seatsLeft('r1', date), 20);

  let weather = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date, pax: { ad_fr: 2 } }] }), 201);
  weather = ok(await write('POST', weather, '/cancel-weather', {}));
  assert.equal(ok(await write('PATCH', weather, '', { lead_pax: 'Rain' })).lead_pax, 'Rain');
});

// ── 8. Back to a quote ────────────────────────────────────────────────────────────────────────────

test('/unconfirm turns a confirmed, FOC-waiting or approval-waiting booking back into a quote; the version is required', async () => {
  const date = '2074-05-01';
  await deploy(`bd-u-${run}`, 'r1', date, 10, { license_pax: 20 });
  const confirmed = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date, pax: { ad_fr: 2 } }] }), 201);
  refused(await send('POST', `/v1/bookings/${confirmed.id}/unconfirm`, {}), 428, 'version_required');
  const quote = ok(await write('POST', confirmed, '/unconfirm', { note: 'customer unsure' }));
  assert.deepEqual([quote.status, quote.confirmed_at, quote.allocated_pax], ['quote', confirmed.confirmed_at, 2], 'who confirmed it is kept; a quote holds its seats');
  assert.equal((await history(quote.id)).at(-1), 'Back to quote · was confirmed · customer unsure');
  refused(await write('POST', quote, '/unconfirm'), 409, 'wrong_status');

  const foc = ok(await send('POST', '/v1/bookings', { foc_reason: 'Guide', trips: [{ routeId: 'r1', date, pax: { ad_fr: 1, foc_fr: 1 } }] }), 201);
  const unfoc = ok(await write('POST', foc, '/unconfirm'));
  assert.deepEqual([unfoc.status, unfoc.approvals.map((a: Json) => [a.kind, a.status])], ['quote', [['foc', 'replaced']]], 'a quote waits for nothing');

  // Over the allotment (10) but within the licence (20): it held no seats, and as a quote it still asks.
  const over = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date, pax: { ad_fr: 9 } }] }), 201);
  assert.deepEqual([over.status, over.allocated_pax], ['pending_approval', 0]);
  const still = ok(await write('POST', over, '/unconfirm'));
  assert.deepEqual([still.status, still.approvals.filter((a: Json) => a.status === 'pending').map((a: Json) => [a.target_status, a.over_capacity])], ['pending_approval', [['quote', true]]]);
  assert.equal(ok(await write('POST', still, '/approve')).status, 'quote');
});

// ── 9. The booking code ───────────────────────────────────────────────────────────────────────────

test('a booking gets a server-numbered code, BK-YYMMNNNN for this Bangkok month; a client cannot set or change it', async () => {
  const date = '2074-06-01';
  const month = todayInThailand().slice(2, 7).replace('-', '');
  const first = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date, pax: { ad_fr: 1 } }] }), 201);
  const second = ok(await send('POST', '/v1/bookings', { trips: [{ routeId: 'r1', date, pax: { ad_fr: 1 } }] }), 201);
  assert.match(first.code, new RegExp(`^BK-${month}\\d{4,}$`));
  assert.ok(Number(second.code.slice(7)) > Number(first.code.slice(7)), `${second.code} follows ${first.code}`);
  assert.match(first.id, /^booking_[0-9a-f-]{36}$/, 'the id stays the key');

  assert.match(refused(await send('POST', '/v1/bookings', { code: 'BK-99990001', trips: [{ routeId: 'r1', date, pax: { ad_fr: 1 } }] }), 400), /^code cannot be set/);
  ok(await write('PATCH', first, '', { code: first.code, lead_pax: 'Echo' }));
  const again = ok(await send('GET', `/v1/bookings/${first.id}`));
  assert.match(refused(await write('PATCH', again, '', { code: 'BK-99990001' }), 400), /^code cannot be changed/);
  const found = ok(await send('GET', `/v1/bookings?q=${first.code.toLowerCase()}`)).bookings as Json[];
  assert.deepEqual(found.map((b) => b.id), [first.id], 'searchable by code');
});

// ── 10. A company booking's reason ────────────────────────────────────────────────────────────────

test('a company booking needs company_purpose, one of legacy\'s three; it is kept on every save', async () => {
  const date = '2074-07-01';
  const trips = [{ routeId: 'r1', date, pax: { ad_fr: 2 } }];
  assert.match(refused(await send('POST', '/v1/bookings', { agent_id: 'a_company', manual_total: 0, trips }), 400), /company_purpose is required/);
  refused(await send('POST', '/v1/bookings', { agent_id: 'a_company', company_purpose: 'vip', trips }), 400);
  const b = ok(await send('POST', '/v1/bookings', { agent_id: 'a_company', companyPurpose: 'pr_foc', manual_total: 0, trips }), 201);
  assert.deepEqual([b.company_purpose, b.price_mode], ['pr_foc', 'manual']);
  refused(await write('PATCH', b, '', { company_purpose: null }), 400);
  assert.equal(ok(await write('PATCH', b, '', { company_purpose: 'company_special' })).company_purpose, 'company_special');
  refused(await send('POST', '/v1/bookings', { company_purpose: 'free', trips }), 400, undefined);
});
