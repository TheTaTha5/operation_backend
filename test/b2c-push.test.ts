import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';

// Love Kingdom's push (todo/b2c-sync-model.md, decided 2026-10-09): its login's bad input is held for
// ops instead of refused, what is stored is checked and listed, and it can read what changed since a
// time. Runs against whichever store DATABASE_URL selects.
process.env.AUTH_JWT_SECRET = 'b2c-push-test-secret';
const { buildApp } = await import('../src/app.js');
const { OperationsStore } = await import('../src/domain/operations.js');
const { seedAgents, seedUser, testStore, tokenFor } = await import('./users-helper.js');
const store = testStore();
// The in-process store checks routes only once it has a catalogue; PostgreSQL's comes from migrations.
if (store instanceof OperationsStore) store.seedCatalogue({ routes: [{ id: 'r1', name: 'Tratato' }] });
const app = buildApp({ store });
after(async () => app.close());

await seedAgents(store, [], { a_b2c: null });
await seedUser(store, { username: 'b2c.push', agent_id: 'a_b2c', edit_areas: ['operations'] });
await seedUser(store, { username: 'b2c.ops', edit_areas: ['operations'] });
await seedUser(store, { username: 'b2c.sales', edit_areas: ['sales'] });
const push = await tokenFor(app, 'b2c.push');
const ops = await tokenFor(app, 'b2c.ops');
const sales = await tokenFor(app, 'b2c.sales');

const run = Date.now().toString(36);
const send = (headers: Record<string, string>, method: InjectOptions['method'], url: string, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const trip = (date: string, routeId = 'r1') => ({ routeId, date, pax: { ad_fr: 2 } });
const order = (n: string, extra: object = {}) => ({ external_id: `LOV-${run}-${n}`, leadPax: `B2C ${run} ${n}`, total: 3000, trips: [trip('2046-02-01')], ...extra });

/** The change feed's rows for one record since `version` (the suite shares one database, so read from a mark). */
const feedVersion = async (): Promise<number> => (await send(ops, 'GET', '/v1/changes')).json().version as number;
const feedRows = async (since: number, id: string) =>
  ((await send(ops, 'GET', `/v1/changes?since=${since}&limit=1000`)).json().changes as { kind: string; entity_id: string; action: string }[]).filter((c) => c.entity_id === id);

test('Love Kingdom\'s create on an unknown route is held for ops, not refused, and a retry is the same order', async () => {
  const mark = await feedVersion();
  const body = order('route', { trips: [trip('2046-02-01', 'r-nowhere')] });
  const held = await send(push, 'POST', '/v1/bookings', body);
  assert.equal(held.statusCode, 202, held.body);
  const h = held.json().held_order;
  assert.equal(held.json().code, 'held_for_review');
  assert.equal(held.json().message, `Not booked: Unknown route: r-nowhere. Held for ops to review as ${h.id}`);
  assert.match(h.id, /^held_/);
  assert.deepEqual([h.action, h.external_id, h.booking_id, h.problem, h.status, h.attempts, h.received_by], ['create', body.external_id, null, 'Unknown route: r-nowhere', 'open', 1, 'b2c.push']);
  assert.deepEqual(h.request, body, 'the body exactly as sent');
  assert.equal(held.headers.etag, undefined, 'no booking, no version');
  const listed = await send(ops, 'GET', `/v1/bookings?q=${encodeURIComponent(body.leadPax)}`);
  assert.equal(listed.json().total, 0, 'nothing booked');

  const again = await send(push, 'POST', '/v1/bookings', { ...body, leadPax: `${body.leadPax} again` });
  assert.equal(again.statusCode, 202);
  assert.equal(again.json().held_order.id, h.id, 'the same open order, not a second one');
  assert.equal(again.json().held_order.attempts, 2);
  assert.equal(again.json().held_order.request.leadPax, `${body.leadPax} again`, 'the latest request is kept');

  const read = await send(ops, 'GET', `/v1/b2c/held-orders/${h.id}`);
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().attempts, 2);
  assert.deepEqual((await feedRows(mark, h.id)).map((c) => [c.kind, c.action]), [['b2c_held_order', 'created'], ['b2c_held_order', 'updated']], 'the panel hears of it');
});

test('only Love Kingdom\'s login is held, and only a 400: staff still see the refusal, a duplicate is still 409', async () => {
  const body = order('staff', { agent_id: 'a_b2c', trips: [trip('2046-02-02', 'r-nowhere')] });
  const refused = await send(ops, 'POST', '/v1/bookings', body);
  assert.equal(refused.statusCode, 400, 'a person at a screen can fix the field');
  assert.equal(refused.json().message, 'Unknown route: r-nowhere');

  const booked = await send(push, 'POST', '/v1/bookings', order('dup'));
  assert.equal(booked.statusCode, 201, booked.body);
  const duplicate = await send(push, 'POST', '/v1/bookings', order('dup'));
  assert.equal(duplicate.statusCode, 409, 'not bad data: the order is already booked');
  assert.equal(duplicate.json().code, 'duplicate_external_id');
  const other = await send(push, 'POST', '/v1/bookings', order('agent', { agent_id: 'a01' }));
  assert.equal(other.statusCode, 403, 'another agent is still refused');
});

test('a held order fixed and resent books, and the held one is settled by itself', async () => {
  const body = order('fixed', { trips: [{ routeId: 'r1', date: '2046-02-03', pax: { adult: 2 } }] });
  const held = await send(push, 'POST', '/v1/bookings', body);
  assert.equal(held.statusCode, 202);
  assert.equal(held.json().held_order.problem, 'trips[0].pax.adult is not a passenger category');
  const id = held.json().held_order.id as string;

  const mark = await feedVersion();
  const booked = await send(push, 'POST', '/v1/bookings', { ...body, trips: [trip('2046-02-03')] });
  assert.equal(booked.statusCode, 201, booked.body);
  const settled = (await send(ops, 'GET', `/v1/b2c/held-orders/${id}`)).json();
  assert.deepEqual([settled.status, settled.resolved_booking_id, settled.decided_by, settled.note], ['resolved', booked.json().id, 'b2c.push', `Booked as ${booked.json().id}`]);
  const open = (await send(ops, 'GET', '/v1/b2c/held-orders')).json().held_orders as { id: string }[];
  assert.ok(!open.some((h) => h.id === id), 'off the open list');
  assert.deepEqual((await feedRows(mark, id)).map((c) => [c.kind, c.action]), [['b2c_held_order', 'updated']], 'the panel hears it was settled');
});

test('an amend or cancel with bad data is held and the booking stays as it was; a stale version is still 409', async () => {
  const created = await send(push, 'POST', '/v1/bookings', order('amend'));
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json();
  const v = { 'if-match': `"${b.version}"` };

  const amend = await send({ ...push, ...v }, 'PATCH', `/v1/bookings/${b.id}`, { trips: [trip('2046-02-04', 'r-nowhere')] });
  assert.equal(amend.statusCode, 202, amend.body);
  assert.deepEqual([amend.json().held_order.action, amend.json().held_order.booking_id, amend.json().held_order.external_id], ['amend', b.id, b.external_id]);
  const cancel = await send({ ...push, ...v }, 'POST', `/v1/bookings/${b.id}/cancel`, { category: 'lost_interest' });
  assert.equal(cancel.statusCode, 202, cancel.body);
  assert.equal(cancel.json().held_order.action, 'cancel');
  assert.match(cancel.json().held_order.problem, /category/);

  const now = (await send(push, 'GET', `/v1/bookings/${b.id}`)).json();
  assert.deepEqual([now.version, now.status, now.trips[0].route_id], [b.version, 'confirmed', 'r1'], 'nothing changed');
  const stale = await send({ ...push, 'if-match': '"99"' }, 'PATCH', `/v1/bookings/${b.id}`, { leadPax: 'X' });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale_version', 'an edit clash is the version\'s, not held');
  const unversioned = await send(push, 'PATCH', `/v1/bookings/${b.id}`, { leadPax: 'X' });
  assert.equal(unversioned.statusCode, 428, 'If-Match is still required');
});

test('ops resolve or dismiss a held order; the decision is the server\'s, and only from open', async () => {
  const held = async (n: string) => (await send(push, 'POST', '/v1/bookings', order(n, { trips: [trip('2046-02-05', 'r-nowhere')] }))).json().held_order.id as string;
  const a = await held('resolve'), b = await held('dismiss');

  assert.equal((await send(push, 'POST', `/v1/b2c/held-orders/${a}/resolve`, {})).statusCode, 403, 'Love Kingdom does not settle its own');
  const salesTry = await send(sales, 'POST', `/v1/b2c/held-orders/${a}/resolve`, {});
  assert.equal(salesTry.statusCode, 403);
  assert.equal(salesTry.json().message, 'Needs the operations area');
  assert.equal((await send(ops, 'POST', '/v1/b2c/held-orders/held_nope/resolve', {})).statusCode, 404);
  const unknown = await send(ops, 'POST', `/v1/b2c/held-orders/${a}/resolve`, { booking_id: 'booking_nope' });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().message, 'booking_id booking_nope is not a booking');

  const target = (await send(ops, 'POST', '/v1/bookings', { trips: [trip('2046-02-05')] })).json().id as string;
  const resolved = await send(ops, 'POST', `/v1/b2c/held-orders/${a}/resolve`, {
    booking_id: target, note: 'Booked by hand on r1', decided_by: 'someone else', status: 'dismissed', attempts: 9,
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.deepEqual([resolved.json().status, resolved.json().resolved_booking_id, resolved.json().note, resolved.json().decided_by, resolved.json().attempts],
    ['resolved', target, 'Booked by hand on r1', 'b2c.ops', 1], 'who decided, the status and the count are the server\'s');
  assert.ok(resolved.json().decided_at);
  const twice = await send(ops, 'POST', `/v1/b2c/held-orders/${a}/dismiss`, {});
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().code, 'wrong_status');
  assert.equal(twice.json().message, `Held order ${a} is already resolved`);

  assert.equal((await send(ops, 'POST', `/v1/b2c/held-orders/${b}/dismiss`, { booking_id: target })).statusCode, 400, 'a dismissed order was not booked');
  assert.equal((await send(ops, 'POST', `/v1/b2c/held-orders/${b}/dismiss`, { note: 7 })).statusCode, 400);
  const dismissed = await send(ops, 'POST', `/v1/b2c/held-orders/${b}/dismiss`, { note: 'test order' });
  assert.deepEqual([dismissed.json().status, dismissed.json().resolved_booking_id], ['dismissed', null]);

  const ids = (status: string) => send(ops, 'GET', `/v1/b2c/held-orders?status=${status}`).then((r) => (r.json().held_orders as { id: string }[]).map((h) => h.id));
  assert.ok((await ids('resolved')).includes(a) && !(await ids('resolved')).includes(b));
  assert.ok((await ids('dismissed')).includes(b));
  assert.ok(!(await ids('open')).includes(a));
  assert.ok((await ids('all')).includes(a) && (await ids('all')).includes(b));
  assert.equal((await send(ops, 'GET', '/v1/b2c/held-orders?status=closed')).statusCode, 400);
});

test('what Love Kingdom stores is checked, told back to it, and listed for ops until fixed', async () => {
  const body = order('issues', {
    leadNationality: 'Slovak', hotelName: 'Blu Monkey Hub', total: 1500, priceBreakdown: { seat: 1000 },
    trips: [{ routeId: 'r1', date: '2046-02-06', pax: { ad_th: 2 } }],
    passengers: [{ name: 'Jan', nationality: 'GB' }, { name: 'Eva', nationality: 'GB' }, { name: 'Ola', nationality: 'Polish' }],
    issues: [], // a client cannot say there is nothing wrong
  });
  const created = await send(push, 'POST', '/v1/bookings', body);
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json();
  assert.equal(b.total, 1500, 'a B2C price stays as sent');
  assert.deepEqual((b.issues as { code: string }[]).map((i) => i.code), ['nat_unread', 'nat_unread', 'nat_mix', 'money_parts', 'pickup_area']);
  assert.deepEqual(b.issues[0], { code: 'nat_unread', severity: 'warn', message: 'อ่านสัญชาติผู้จองไม่ออก: "Slovak"' });
  assert.equal(b.issues[1].message, 'อ่านสัญชาติผู้โดยสารไม่ออก: "Polish"');
  assert.match(b.issues[2].message, /^ขายราคาคนไทย 2 ที่ แต่ในใบมีต่างชาติ 2 คน \(2046-02-06\)/);
  assert.equal(b.issues[3].message, 'ยอดแยกรวมไม่เท่ายอดบรรทัด (1000 ≠ 1500)');
  assert.deepEqual(b.issues[4], { code: 'pickup_area', severity: 'info', message: 'จับคู่จุดรับไม่ได้: "Blu Monkey Hub" · ต้องเลือกพื้นที่รับเอง' });
  assert.equal((await send(push, 'GET', `/v1/bookings/${b.id}`)).json().issues, undefined, 'computed for the write\'s answer, not stored on the booking');

  const panel = async () => {
    const response = await send(ops, 'GET', '/v1/b2c/issues');
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { issues: { booking_id: string; code: string; external_id: string; lead_pax: string; service_date: string }[]; counts: Record<string, number>; signature: string; held_orders: unknown[] };
  };
  const first = await panel();
  const mine = first.issues.filter((i) => i.booking_id === b.id);
  assert.deepEqual(mine.map((i) => i.code), ['nat_unread', 'nat_unread', 'nat_mix', 'money_parts', 'pickup_area']);
  assert.deepEqual([mine[0].external_id, mine[0].lead_pax, mine[0].service_date], [body.external_id, body.leadPax, '2046-02-06']);
  assert.match(first.signature, /^[0-9a-f]{12}$/);
  assert.equal(first.counts.held, first.held_orders.length);

  // Ops correct the booking: what they fixed drops off by itself, and the signature moves.
  const fixed = await send({ ...ops, 'if-match': `"${b.version}"` }, 'PATCH', `/v1/bookings/${b.id}`, {
    leadNationality: 'SK', passengers: [{ name: 'Jan', nationality: 'GB' }, { name: 'Eva', nationality: 'GB' }, { name: 'Ola', nationality: 'PL' }],
  });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.equal(fixed.json().issues, undefined, 'staff answers are unchanged');
  const second = await panel();
  assert.deepEqual(second.issues.filter((i) => i.booking_id === b.id).map((i) => i.code), ['nat_mix', 'money_parts', 'pickup_area']);
  assert.notEqual(second.signature, first.signature);

  const cancelled = await send({ ...ops, 'if-match': `"${fixed.json().version}"` }, 'POST', `/v1/bookings/${b.id}/cancel`, { category: 'customer_cancel' });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.ok(!(await panel()).issues.some((i) => i.booking_id === b.id), 'a cancelled booking needs nothing from anyone');

  const clean = await send(push, 'POST', '/v1/bookings', order('clean', { leadNationality: 'GB', passengers: [{ name: 'A', nationality: 'GB' }] }));
  assert.deepEqual(clean.json().issues, [], 'always there for Love Kingdom, empty when nothing is wrong');
  const staff = await send(ops, 'POST', '/v1/bookings', { agent_id: 'a_b2c', leadNationality: 'Slovak', trips: [trip('2046-02-06')] });
  assert.equal(staff.json().issues, undefined, 'staff keying an a_b2c booking get the usual answer');
});

test('Love Kingdom reads the bookings changed since a time (the reconciliation read)', async () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
  const a = (await send(push, 'POST', '/v1/bookings', order('since-a'))).json();
  await pause();
  const b = (await send(push, 'POST', '/v1/bookings', order('since-b'))).json();
  const ids = async (since: string) => {
    const response = await send(push, 'GET', `/v1/bookings?updated_since=${encodeURIComponent(since)}&limit=100`);
    assert.equal(response.statusCode, 200, response.body);
    return (response.json().bookings as { id: string }[]).map((x) => x.id);
  };
  assert.deepEqual((await ids(b.updated_at)).filter((id) => id === a.id || id === b.id), [b.id], 'at or after: the boundary booking comes, the older one does not');
  assert.ok((await ids(a.updated_at)).includes(a.id));

  await pause();
  const edited = await send({ ...push, 'if-match': `"${a.version}"` }, 'PATCH', `/v1/bookings/${a.id}`, { leadPax: 'Changed' });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.ok(edited.json().updated_at > b.updated_at);
  assert.deepEqual((await ids(edited.json().updated_at)).filter((id) => id === a.id || id === b.id), [a.id], 'an edit brings it back');

  for (const bad of ['yesterday', '2046-13-45T00:00:00Z', '1700000000']) {
    const response = await send(push, 'GET', `/v1/bookings?updated_since=${bad}`);
    assert.equal(response.statusCode, 400, bad);
    assert.equal(response.json().message, 'updated_since must be an ISO instant, e.g. 2026-10-09T03:00:00Z');
  }
});
