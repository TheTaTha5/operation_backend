import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { OperationsStore } from '../src/domain/operations.js';
import { pickupNameKey, specialRequest } from '../src/domain/van-jobs.js';
import { createStore } from '../src/routes/operations.js';

// Van job orders (todo/van-job-orders-model.md), on whichever store DATABASE_URL selects. Routes r1
// and r2 come from migration 006 (both sail from Tap Lamu); the in-process store is seeded with them.
const store = createStore();
if (store instanceof OperationsStore) {
  store.seedCatalogue({ routes: [{ id: 'r1', name: 'Early Tratato Similan Islands', pier: 'tublamu' }, { id: 'r2', name: 'Early Tiger Similan Islands', pier: 'tublamu' }] });
}
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });

type Row = { no: number | null; kind: string; booking_id?: string; lead_pax?: string; pickup?: string; pickup_th?: string | null; pickup_time?: string | null;
  special_request?: string | null; struck?: string | null; label?: string; from_van_id?: string | null; return_van_id?: string | null; ad?: number; pax?: number; parts?: number[]; merged_parts?: number; zone?: string | null };
type Job = { key: string; van_id: string; group_id: string | null; route_id: string; round: { no: number; of: number; time: string | null } | null; has_out: boolean; has_ret: boolean;
  out_pax: number; ret_pax: number; pax: number; capacity: number; over_capacity: boolean; struck: number; bookings: number;
  driver: { name: string | null; phone: string | null; plate: string | null; override: boolean }; sent: { at: string; by: string | null; changed_since_sent: boolean | null } | null;
  pickups: { name: string; name_th: string | null }[] };
type Sheet = { job: Job; out: { rows: Row[]; totals: Record<string, number> } | null; ret: { rows: Row[]; totals: Record<string, number> } | null; ret_on_round_1: boolean; unassigned_on_route: { bookings: number; pax: number } };

/** A day on `route` with a boat, and vans on the programme. */
async function day(date: string, vans: { name: string; capacity: number; driver?: string }[], route = 'r1') {
  await send('POST', '/operations/deployments', { boat_id: `vj-boat-${date}-${route}`, route_id: route, service_date: date, capacity: 60 });
  const out = [];
  for (const v of vans) {
    const van = (await send('POST', '/operations/vans', v)).json();
    await send('PUT', `/operations/van-days/${date}/${van.id}`, { route_ids: [route] });
    out.push(van as { id: string; name: string });
  }
  return out;
}
async function book(date: string, fields: Record<string, unknown> = {}, trip: Record<string, unknown> = {}) {
  const created = await send('POST', '/v1/bookings', { lead_pax: 'Ann', hotel_name: 'Patong Beach Hotel', trips: [{ route_id: 'r1', date, pax: { ad: 2 }, zone: 'PK', ...trip }], ...fields });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as { id: string; version: number; trips: { id: string }[] };
}
async function group(date: string, trips: string[], vanId?: string, extra: object = {}, route = 'r1') {
  const g = await send('POST', '/operations/van-groups', { service_date: date, route_id: route, zone: 'PK', members: trips.map((trip_id) => ({ trip_id })), ...(vanId ? { van_id: vanId } : {}), ...extra });
  assert.equal(g.statusCode, 201, g.body);
  return g.json() as { id: string; number: number };
}
const jobs = async (date: string) => {
  const res = await send('GET', `/operations/van-jobs?date=${date}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { jobs: Job[]; unassigned: { pax: number; by_route: { route_id: string; pax: number }[] }; return_unarranged: { booking_id: string }[]; self_arrive: { booking_id: string; has_van: boolean }[]; struck: number };
};
const sheet = async (date: string, key: string) => {
  const res = await send('GET', `/operations/van-jobs/${date}/${encodeURIComponent(key)}`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as Sheet;
};
const bookingRows = (s: Sheet['out']) => (s?.rows ?? []).filter((r) => r.kind === 'booking');

test('a group with a van is a job; its sheet lists the pickups in time order, with the special request', async () => {
  const date = '2052-01-01';
  const [van] = await day(date, [{ name: 'Love 1', capacity: 4, driver: 'Somchai' }]);
  const late = await book(date, { lead_pax: 'Late', notes: 'wait downstairs', room_number: '512', passengers: [{ name: 'Late' }, { name: 'Bob' }] }, { pickup_time: '07:30' });
  const early = await book(date, { lead_pax: 'Early', hotel_name: 'Kata Hotel' }, { pickup_time: '06:45' });
  const loose = await book(date, { lead_pax: 'No van' }, { pickup_time: '06:00' });
  const g = await group(date, [late.trips[0].id, early.trips[0].id], van.id);
  // A new group numbers its members in the order sent, as legacy does; cleared, the sheet goes by time.
  assert.deepEqual(bookingRows((await sheet(date, g.id)).out).map((r) => r.lead_pax), ['Late', 'Early'], 'the manual order');
  await send('PUT', `/operations/van-groups/${g.id}/order`, { clear: true });

  const list = await jobs(date);
  const job = list.jobs.find((j) => j.van_id === van.id)!;
  assert.deepEqual([job.key, job.group_id, job.round, job.has_out, job.has_ret, job.out_pax, job.pax, job.capacity, job.over_capacity, job.bookings],
    [g.id, g.id, null, true, true, 4, 4, 4, false, 2], 'one group, one round; everyone comes back on the van that took them');
  assert.deepEqual([job.driver.name, job.driver.override, job.sent], ['Somchai', false, null], 'the registry\'s driver; not sent yet');
  assert.equal(list.unassigned.pax, 2, 'the third booking has no van yet');
  assert.ok(list.unassigned.by_route.some((r) => r.route_id === 'r1' && r.pax === 2));

  const s = await sheet(date, g.id);
  const out = bookingRows(s.out);
  assert.deepEqual(out.map((r) => [r.no, r.lead_pax, r.pickup_time, r.pickup]), [[1, 'Early', '06:45', 'Kata Hotel'], [2, 'Late', '07:30', 'Patong Beach Hotel']], 'by pickup time');
  assert.equal(out[1].special_request, 'wait downstairs', 'the notes, when nothing overrides them');
  assert.deepEqual([s.out!.totals.pax, s.out!.totals.bookings, s.ret!.totals.pax], [4, 2, 4]);
  assert.deepEqual(bookingRows(s.ret).map((r) => r.pickup), ['Tub Lamu Pier', 'Tub Lamu Pier'], 'the return run starts at the pier');
  assert.deepEqual(s.unassigned_on_route, { bookings: 1, pax: 2 }, 'legacy\'s "may be missing from this sheet" warning');
  assert.ok(!bookingRows(s.out).some((r) => r.booking_id === loose.id));

  // The driver of the day overrides the registry.
  await send('PUT', `/operations/van-days/${date}/${van.id}`, { driver: 'Nok', driver_phone: '089' });
  assert.deepEqual((await sheet(date, g.id)).job.driver, { name: 'Nok', phone: '089', plate: null, override: true, plate_override: false });

  assert.equal((await send('GET', '/operations/van-jobs?date=2052-1-1')).statusCode, 400);
  assert.equal((await send('GET', `/operations/van-jobs/${date}/vgrp_nowhere`)).statusCode, 404);
  assert.equal((await send('GET', `/operations/van-jobs/2052-01-02/${g.id}`)).statusCode, 404, 'a group is a job on its own day only');
});

test('job_note: the special request the sheet, check-in and the pier print; "" blanks it, null goes back to the notes', async () => {
  const date = '2052-01-02';
  const [van] = await day(date, [{ name: 'Love 2', capacity: 9 }]);
  const b = await book(date, { notes: 'Room service at 6' });
  const g = await group(date, [b.trips[0].id], van.id);
  const patch = async (body: object) => {
    const res = await send('PATCH', `/v1/bookings/${b.id}`, body);
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { job_note?: string; special_request: string | null; notes?: string };
  };
  assert.equal((await send('GET', `/v1/bookings/${b.id}`)).json().special_request, 'Room service at 6');
  const set = await patch({ job_note: '  ลากหาด +200.- ' });
  assert.deepEqual([set.job_note, set.special_request], ['ลากหาด +200.-', 'ลากหาด +200.-']);
  assert.equal(bookingRows((await sheet(date, g.id)).out)[0].special_request, 'ลากหาด +200.-');
  const blank = await patch({ jobNote: '' });
  assert.deepEqual([blank.job_note, blank.special_request], ['', null], 'legacy\'s blanked override: the notes are not van business');
  assert.equal(bookingRows((await sheet(date, g.id)).out)[0].special_request, null);
  const back = await patch({ job_note: null });
  assert.deepEqual([back.job_note, back.special_request], [undefined, 'Room service at 6'], 'reset: the notes again');
  const computed = await patch({ special_request: 'not mine to set' });
  assert.equal(computed.special_request, 'Room service at 6', 'special_request is computed: a value sent is not taken');

  assert.equal(specialRequest({ notes: '  ' }), null);
  assert.equal(specialRequest({ job_note: 'x', notes: 'y' }), 'x');
});

test('sent to the driver: per job, stamped by the server, and flagged when the sheet changes after', async () => {
  const date = '2052-01-03';
  const [van] = await day(date, [{ name: 'Love 3', capacity: 9 }]);
  const a = await book(date, { lead_pax: 'A' }, { pickup_time: '07:00' });
  const g = await group(date, [a.trips[0].id], van.id);
  const url = `/operations/van-jobs/${date}/${g.id}/sent`;

  const stamped = await send('PUT', url, { sent_at: '2000-01-01T00:00:00Z' });
  assert.equal(stamped.statusCode, 400, 'when it was sent is the server\'s');
  const sent = await send('PUT', url);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().sent.changed_since_sent, false);
  assert.ok(Date.now() - Date.parse(sent.json().sent.at) < 60_000);

  // A new passenger after sending: the tick stays, flagged.
  const b = await book(date, { lead_pax: 'B' }, { pickup_time: '07:15' });
  await send('POST', `/operations/van-groups/${g.id}/members`, { members: [{ trip_id: b.trips[0].id }] });
  let job = (await jobs(date)).jobs.find((j) => j.key === g.id)!;
  assert.deepEqual([!!job.sent, job.sent?.changed_since_sent], [true, true], 'a change after sending keeps the tick and is flagged (new vs legacy)');
  // Undone, it reads as sent again: the flag compares the sheet, not a clock.
  await send('PATCH', `/operations/trip-ops/${b.trips[0].id}`, { van_parts: null });
  job = (await jobs(date)).jobs.find((j) => j.key === g.id)!;
  assert.equal(job.sent?.changed_since_sent, false);
  // A pickup time change is a change; sending again clears the flag.
  await send('PATCH', `/operations/van-groups/${g.id}`, { pickup_time: '06:50' });
  assert.equal((await jobs(date)).jobs.find((j) => j.key === g.id)!.sent?.changed_since_sent, true);
  assert.equal((await send('PUT', url)).json().sent.changed_since_sent, false, 'ticked again: re-sent');

  const unsent = await send('DELETE', url);
  assert.equal(unsent.statusCode, 200, unsent.body);
  assert.equal(unsent.json().sent, null);
  assert.equal((await send('PUT', `/operations/van-jobs/${date}/vgrp_nowhere/sent`)).statusCode, 404);

  // A disbanded group takes its mark with it.
  await send('PUT', url);
  await send('DELETE', `/operations/van-groups/${g.id}`);
  const again = await group(date, [a.trips[0].id], van.id);
  assert.equal((await jobs(date)).jobs.find((j) => j.key === again.id)!.sent, null);
});

test('rounds: a van running a programme twice has two jobs, numbered by pickup time; the return leg prints once, on round 1', async () => {
  const date = '2052-01-04';
  const [van] = await day(date, [{ name: 'Love 4', capacity: 9 }]);
  const patong = await book(date, { lead_pax: 'Patong' }, { pickup_time: '07:30' });
  const panwa = await book(date, { lead_pax: 'Panwa' }, { pickup_time: '06:15' });
  const first = await group(date, [patong.trips[0].id], van.id);
  const second = await group(date, [panwa.trips[0].id], van.id, { allow_second_round: true });
  const mine = (await jobs(date)).jobs.filter((j) => j.van_id === van.id);
  assert.deepEqual(mine.map((j) => [j.key, j.round]), [[first.id, { no: 2, of: 2, time: '07:30' }], [second.id, { no: 1, of: 2, time: '06:15' }]],
    'group 2 picks up first, so it is round 1 (legacy vjRoundPick); the list keeps group order');
  const r1 = await sheet(date, second.id), r2 = await sheet(date, first.id);
  assert.deepEqual(bookingRows(r1.ret).map((r) => r.lead_pax).sort(), ['Panwa', 'Patong'], 'everyone comes back on one boat, so one return run');
  assert.deepEqual([r2.ret, r2.ret_on_round_1, r2.job.has_ret], [null, true, false]);
  // Each round keeps its own tick: adding a round does not orphan the first one's (legacy bug 2).
  await send('PUT', `/operations/van-jobs/${date}/${first.id}/sent`);
  const third = await book(date, { lead_pax: 'Third' }, { pickup_time: '09:00' });
  await group(date, [third.trips[0].id], van.id, { allow_second_round: true });
  assert.ok((await jobs(date)).jobs.find((j) => j.key === first.id)!.sent);
});

test('a van that only brings people back is a job of its own; rows from another van go last', async () => {
  const date = '2052-01-05';
  const [outVan, backVan] = await day(date, [{ name: 'Love 5', capacity: 9 }, { name: 'Love 6', capacity: 9 }]);
  const b = await book(date, { lead_pax: 'Back by Love 6' }, { pickup_time: '07:00' });
  const g = await group(date, [b.trips[0].id], outVan.id);
  const set = await send('PATCH', `/operations/van-groups/${g.id}`, { return_van_id: backVan.id });
  assert.equal(set.statusCode, 200, set.body);
  const list = await jobs(date);
  const back = list.jobs.find((j) => j.van_id === backVan.id)!;
  assert.deepEqual([back.key, back.group_id, back.has_out, back.has_ret, back.ret_pax, back.pax], [`${backVan.id}~r1`, null, false, true, 2, 2]);
  const s = await sheet(date, back.key);
  assert.deepEqual(bookingRows(s.ret).map((r) => [r.lead_pax, r.from_van_id]), [['Back by Love 6', outVan.id]], 'it came out on another van');
  const outSheet = await sheet(date, g.id);
  assert.equal(outSheet.ret, null, 'nobody comes back on Love 5');
  assert.equal(bookingRows(outSheet.out)[0].return_van_id, backVan.id, 'the driver sees who takes them back');
  const sent = await send('PUT', `/operations/van-jobs/${date}/${encodeURIComponent(back.key)}/sent`);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().sent.changed_since_sent, false);
});

test('a cancelled booking still in its group prints struck through and counts nowhere', async () => {
  const date = '2052-01-06';
  const [van] = await day(date, [{ name: 'Love 7', capacity: 9 }]);
  const stays = await book(date, { lead_pax: 'Stays' }, { pickup_time: '07:00' });
  const goes = await book(date, { lead_pax: 'Cancelled' }, { pickup_time: '06:30' });
  const g = await group(date, [stays.trips[0].id, goes.trips[0].id], van.id);
  const cancel = await send('POST', `/v1/bookings/${goes.id}/cancel`, { reason: 'guest', charge_type: 'none' });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const s = await sheet(date, g.id);
  assert.deepEqual(bookingRows(s.out).map((r) => [r.lead_pax, r.no, r.struck]), [['Stays', 1, null], ['Cancelled', null, 'cancelled']],
    'still in its place, so the driver can hold the new sheet against the old one (legacy §strandVj)');
  assert.deepEqual([s.out!.totals.pax, s.out!.totals.struck, s.job.out_pax, s.job.struck], [2, 1, 2, 2], 'struck on the way out and on the way back');
  // Clearing the cancelled trip's van parts takes it off (legacy's "ล้างออก").
  assert.equal((await send('PATCH', `/operations/trip-ops/${goes.trips[0].id}`, { van_parts: null })).statusCode, 200);
  assert.equal((await sheet(date, g.id)).job.struck, 0);
});

test('group order: staff drag a zone\'s groups; the board and the job orders follow it', async () => {
  const date = '2052-01-07';
  const vans = await day(date, [{ name: 'Love 8', capacity: 9 }, { name: 'Love 9', capacity: 9 }, { name: 'Love 10', capacity: 9 }]);
  const groups = [];
  for (const [i, van] of vans.entries()) groups.push(await group(date, [(await book(date, { lead_pax: `G${i}` })).trips[0].id], van.id));
  const order = (group_ids: string[], extra: object = {}) => send('PUT', '/operations/van-groups/order', { service_date: date, route_id: 'r1', zone: 'PK', group_ids, ...extra });
  const res = await order([groups[2].id, groups[0].id]);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().groups.map((g: { id: string; display_order: number | null }) => [g.id, g.display_order]),
    [[groups[2].id, 1], [groups[0].id, 2], [groups[1].id, null]], 'the ones not dragged follow by number');
  assert.deepEqual((await jobs(date)).jobs.filter((j) => j.route_id === 'r1').map((j) => j.group_id), [groups[2].id, groups[0].id, groups[1].id]);

  for (const [ids, extra, message] of [
    [[groups[0].id, groups[0].id], {}, /twice/], [['vgrp_nowhere'], {}, /not a van group of zone PK/], [[groups[0].id], { zone: 'KL' }, /not a van group of zone KL/],
    ['nope', {}, /group_ids must be a list/], [[], { zone: undefined }, /zone is required/],
  ] as const) {
    const bad = await order(ids as unknown as string[], extra);
    assert.equal(bad.statusCode, 400, bad.body);
    assert.match(bad.json().message, message);
  }
  const reset = await order([], { clear: true });
  assert.deepEqual(reset.json().groups.map((g: { number: number }) => g.number), [groups[0].number, groups[1].number, groups[2].number]);
});

test('Thai pickup names: typed once per place, found whatever the case; emptied, deleted', async () => {
  const date = '2052-01-08';
  const [van] = await day(date, [{ name: 'Love 11', capacity: 9 }]);
  const b = await book(date, { hotel_name: 'VJ Sea View Resort' });
  const g = await group(date, [b.trips[0].id], van.id);
  const put = await send('PUT', '/operations/pickup-names-th', { name: '  vj sea view RESORT ', name_th: ' ซีวิว รีสอร์ท ' });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json(), { name: 'vj sea view RESORT', name_th: 'ซีวิว รีสอร์ท' });
  assert.equal(pickupNameKey('  VJ Sea View Resort '), 'vj sea view resort');
  const s = await sheet(date, g.id);
  assert.equal(bookingRows(s.out)[0].pickup_th, 'ซีวิว รีสอร์ท', 'the hotel as typed on the booking finds it');
  assert.deepEqual(s.job.pickups.find((p) => p.name === 'VJ Sea View Resort'), { name: 'VJ Sea View Resort', name_th: 'ซีวิว รีสอร์ท' });
  assert.ok((await send('GET', '/operations/pickup-names-th')).json().names.some((n: { name_th: string }) => n.name_th === 'ซีวิว รีสอร์ท'));

  assert.equal((await send('PUT', '/operations/pickup-names-th', { name: ' ', name_th: 'x' })).statusCode, 400);
  assert.equal((await send('PUT', '/operations/pickup-names-th', { name: 'x', name_th: 5 })).statusCode, 400);
  const gone = await send('PUT', '/operations/pickup-names-th', { name: 'VJ SEA VIEW RESORT', name_th: '' });
  assert.deepEqual(gone.json(), { name: 'VJ SEA VIEW RESORT', name_th: null });
  assert.equal(bookingRows((await sheet(date, g.id)).out)[0].pickup_th, null);
});

test('the sheet\'s order: manual order first, an unordered row goes in by time, a stop is a row', async () => {
  const date = '2052-01-09';
  const [van] = await day(date, [{ name: 'Love 12', capacity: 12 }]);
  const a = await book(date, { lead_pax: 'A 07:00' }, { pickup_time: '07:00' });
  const b = await book(date, { lead_pax: 'B 06:30' }, { pickup_time: '06:30' });
  const g = await group(date, [a.trips[0].id, b.trips[0].id], van.id);
  // Driven against the clock on purpose: A first, then B (legacy keeps the manual order).
  assert.equal((await send('PUT', `/operations/van-groups/${g.id}/order`, { members: [{ trip_id: a.trips[0].id }, { trip_id: b.trips[0].id }] })).statusCode, 200);
  const stop = await send('POST', '/operations/van-stops', { group_id: g.id, kind: 'staff', label: 'Guide', pax: 1, place: 'Office', time: '05:50' });
  assert.equal(stop.statusCode, 201, stop.body);
  const s = await sheet(date, g.id);
  assert.deepEqual(s.out!.rows.map((r) => [r.no, r.kind === 'stop' ? r.label : r.lead_pax]), [[1, 'Guide'], [2, 'A 07:00'], [3, 'B 06:30']],
    'the 05:50 stop goes before the first ordered row that is later (legacy §vsSeqTime)');
  assert.deepEqual([s.job.out_pax, s.job.pax, s.out!.totals.stop_seats], [4, 5, 1], 'a guide riding along takes a seat');
});

test('the day\'s warnings: a self-arrive booking still on a van, a separate drop-off with no van back', async () => {
  const date = '2052-01-10';
  const [van] = await day(date, [{ name: 'Love 13', capacity: 12 }]);
  const self = await book(date, { lead_pax: 'Self', pickup_self: true });
  const drop = await book(date, { lead_pax: 'Drop', dropoff_same: false, dropoff_hotel_name: 'Old Town Hostel' });
  await group(date, [self.trips[0].id, drop.trips[0].id], van.id);
  const list = await jobs(date);
  assert.deepEqual(list.self_arrive.filter((x) => x.booking_id === self.id).map((x) => x.has_van), [true], 'legacy selfWarn');
  assert.ok(list.return_unarranged.some((x) => x.booking_id === drop.id), 'legacy\'s amber "no van back yet"');
  const s = await sheet(date, list.jobs.find((j) => j.van_id === van.id)!.key);
  assert.deepEqual(bookingRows(s.out).map((r) => r.lead_pax), ['Drop'], 'a self-arrive booking is not picked up');
  await send('PATCH', `/operations/trip-ops/${drop.trips[0].id}`, { return_same_van: true });
  assert.ok(!(await jobs(date)).return_unarranged.some((x) => x.booking_id === drop.id), 'confirmed on the same van');
});
