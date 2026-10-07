import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// Runs against whichever store `buildApp` picks, so `DATABASE_URL=… npm test` asks PostgreSQL the
// same questions. Every booking here carries one agent id unique to this run, and every query is
// scoped to it, so rows left by earlier runs in a shared database cannot change the answers.
const app = buildApp();
after(async () => { await app.close(); });

async function request(method: InjectOptions['method'], path: string, payload?: object) {
  return payload === undefined ? app.inject({ method, url: path }) : app.inject({ method, url: path, payload });
}

test('the booking list filters by status, voucher and free text, and counts what it matches', async () => {
  const date = '2035-06-06';
  await request('POST', '/operations/deployments', { boat_id: 'boat-list-filters', route_id: 'r1', service_date: date, capacity: 30 });
  const run = Date.now().toString(36);
  const agent = `tag_list_${run}`;
  // Each status is reached the way a client reaches it: a discount waits for approval, the cancels are commands.
  const make = async (status: string, voucher: string | undefined, lead: string) => {
    const discount = status === 'pending_approval' ? { price_discount: -500 } : {};
    const created = await request('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 1, agent_id: agent, voucher_ref: voucher, lead_pax: lead, ...discount });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    if (status === 'cancelled' || status === 'cancelled_weather') await request('POST', `/v1/bookings/${id}/${status === 'cancelled' ? 'cancel' : 'cancel-weather'}`);
    assert.equal((await request('GET', `/v1/bookings/${id}`)).json().status, status);
    return id;
  };
  const pending = await make('pending_approval', `VCH-${run}-A`, 'Somchai Jaidee');
  const cancelled = await make('cancelled', `vch-${run}-b`, 'Anna 100%_Smith');
  const weather = await make('cancelled_weather', undefined, 'Ivan Petrov');
  const confirmed = await make('confirmed', `VCH-${run}-C`, 'somchai Other');

  const list = async (params: string) => {
    const response = await request('GET', `/v1/bookings?agent_id=${agent}&${params}`);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { bookings: { id: string }[]; total: number; next_cursor?: string };
    return { ids: body.bookings.map((b) => b.id).sort(), total: body.total, next: body.next_cursor };
  };
  const sorted = (...ids: string[]) => [...ids].sort();

  assert.deepEqual(await list('status=pending_approval'), { ids: [pending], total: 1, next: undefined });
  assert.deepEqual((await list('status=cancelled,cancelled_weather')).ids, sorted(cancelled, weather), 'comma-separated is any of');
  assert.deepEqual((await list('status=cancelled&status=cancelled_weather')).ids, sorted(cancelled, weather), 'a repeated key reads the same');
  assert.equal((await request('GET', '/v1/bookings?status=pending,nonsense')).statusCode, 400, 'an unknown status is refused, not silently matched by nothing');

  assert.deepEqual((await list(`voucher_ref=vch-${run}-a`)).ids, [pending], 'voucher_ref ignores case');
  assert.deepEqual((await list(`voucher_ref=${encodeURIComponent(` VCH-${run}-B `)}`)).ids, [cancelled], 'and surrounding spaces in the query');
  assert.deepEqual((await list(`voucher_ref=VCH-${run}`)).ids, [], 'but is a whole match, not a prefix');

  assert.deepEqual((await list('q=SOMCHAI')).ids, sorted(pending, confirmed), 'q searches the lead name, ignoring case');
  assert.deepEqual((await list(`q=${run}-c`)).ids, [confirmed], 'and the voucher');
  assert.deepEqual((await list(`q=${encodeURIComponent(weather.slice(-6))}`)).ids, [weather], 'and the id');
  assert.deepEqual((await list(`q=${encodeURIComponent('100%_')}`)).ids, [cancelled], '% and _ are literal characters, not wildcards');
  assert.deepEqual((await list(`q=${encodeURIComponent('%')}`)).ids, [cancelled]);

  // The total counts the whole match, not the page and not what is left after the cursor.
  const first = await list('limit=1');
  assert.equal(first.ids.length, 1);
  assert.equal(first.total, 4);
  const second = await list(`limit=1&cursor=${first.next}`);
  assert.equal(second.total, 4, 'the same total on every page');
  assert.equal((await list('status=confirmed,pending_approval&q=somchai&limit=1')).total, 2, 'filters combine');
});
