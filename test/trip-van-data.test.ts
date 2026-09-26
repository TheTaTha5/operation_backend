import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { InjectOptions } from 'fastify';

// Van data has no API yet (hand-off §3), so it is written here with SQL. That makes this file
// PostgreSQL-only: the in-process store holds no van data to lose.
const url = process.env.DATABASE_URL;
const app = buildApp();
const pool = url ? new Pool({ connectionString: url }) : undefined;
after(async () => { await app.close(); await pool?.end(); });

async function request(method: InjectOptions['method'], path: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url: path }) : app.inject({ method, url: path, payload });
}
const tripsOf = (response: { json(): unknown }) => (response.json() as { trips: { id: string }[] }).trips;

test('a trip keeps its van data through edits that keep it, and loses it when it moves', { skip: !url && 'PostgreSQL only' }, async () => {
  const [first, second, moved] = ['2034-04-01', '2034-04-02', '2034-04-09'];
  for (const date of [first, second, moved]) await request('POST', '/operations/deployments', { boat_id: 'boat-van-data', route_id: 'r1', service_date: date, capacity: 20 });
  const created = await request('POST', '/v1/bookings', { trips: [{ route_id: 'r1', date: first, pax: 2 }, { route_id: 'r1', date: second, pax: 2 }] });
  const bookingId = (created.json() as { id: string }).id;
  const [a, b] = tripsOf(created);

  await pool!.query(`INSERT INTO vans (id, name, capacity) VALUES ('van-test-data', 'Van T', 12) ON CONFLICT DO NOTHING`);
  for (const [trip, date, number] of [[a.id, first, 1], [b.id, second, 1]] as const) {
    const group = `vgrp_test_${trip}`;
    await pool!.query(`INSERT INTO van_groups (id, service_date, route_id, zone, number, van_id) VALUES ($1, $2, 'r1', 'PK', $3 + (SELECT COALESCE(MAX(number), 0) FROM van_groups WHERE service_date = $2 AND route_id = 'r1'), 'van-test-data')`, [group, date, number]);
    await pool!.query(`INSERT INTO booking_trip_van_allocations (booking_trip_id, idx, ad, van_group_id) VALUES ($1, 0, 2, $2)`, [trip, group]);
    await pool!.query(`INSERT INTO booking_trip_operations (booking_trip_id, pickup_time_final) VALUES ($1, '07:15')`, [trip]);
  }
  const vanData = async (trip: string) => (await pool!.query(
    `SELECT (SELECT count(*) FROM booking_trip_van_allocations WHERE booking_trip_id = $1)::int AS allocations,
            (SELECT count(*) FROM booking_trip_operations WHERE booking_trip_id = $1)::int AS operations`, [trip])).rows[0];

  assert.equal((await request('PATCH', `/v1/bookings/${bookingId}`, { hotel_name: 'Kept' })).statusCode, 200);
  assert.equal((await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ route_id: 'r1', date: first, pax: 3 }, { route_id: 'r1', date: second, pax: 2 }] })).statusCode, 200);
  assert.deepEqual(await vanData(a.id), { allocations: 1, operations: 1 }, 'a header edit and a pax change keep it');

  const edited = await request('PATCH', `/v1/bookings/${bookingId}`, { trips: [{ id: a.id, route_id: 'r1', date: first, pax: 3 }, { id: b.id, route_id: 'r1', date: moved, pax: 2 }] });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual(tripsOf(edited).map((t) => t.id), [a.id, b.id], 'the moved trip keeps its id');
  assert.deepEqual(await vanData(b.id), { allocations: 0, operations: 0 }, 'its van data was for the old day');
  assert.deepEqual(await vanData(a.id), { allocations: 1, operations: 1 }, 'the trip that stayed keeps its own');
});
