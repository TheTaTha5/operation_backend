import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// The document check (todo/booking-extras-model.md §3), on whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
type DC = { status: string | null; by: string | null; at: string | null; note: string | null; items: Record<string, boolean>;
  pre: { text: string | null; results: Record<string, { result: string }>; summary: Record<string, number> } | null };
async function booking(date: string) {
  await send('POST', '/operations/deployments', { boat_id: `dc-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 2 });
  assert.equal(created.statusCode, 201, created.body);
  const b = created.json() as { id: string; doc_check: DC | null; doc_check_status: string };
  assert.deepEqual([b.doc_check, b.doc_check_status], [null, 'nofiles'], 'legacy docCheckStatus: no files, nothing to check');
  return b.id;
}
const put = (id: string, path: string, body: object) => send('PUT', `/v1/bookings/${id}/doc-check${path}`, body);
const historyOf = async (id: string): Promise<string[]> => (await send('GET', `/v1/bookings/${id}/history`)).json().history.map((h: { text: string }) => h.text);

test('items are ticked one by one; a verdict is stamped and logged, and doesn\'t need every tick', async () => {
  const id = await booking('2051-04-01');
  const ticked = await put(id, '/items/route', { checked: true });
  assert.equal(ticked.statusCode, 200, ticked.body);
  const dc = ticked.json().doc_check as DC;
  assert.deepEqual([dc.status, dc.items.route, dc.items.pax], ['pending', true, false], 'legacy creates it pending');
  assert.equal(ticked.json().doc_check_status, 'pending');

  const verified = await put(id, '/status', { status: 'verified', note: 'voucher fine' });
  assert.deepEqual([verified.json().doc_check.status, verified.json().doc_check.note, verified.json().doc_check_status], ['verified', 'voucher fine', 'verified']);
  assert.ok(verified.json().doc_check.at);
  assert.equal((await historyOf(id)).at(-1), 'Document check · ✅ verified · voucher fine');
  assert.equal((await put(id, '/note', { note: 'agent re-sent it' })).json().doc_check.note, 'agent re-sent it');

  for (const [path, body] of [['/items/price', { checked: true }], ['/items/route', { checked: 'yes' }], ['/status', { status: 'pending' }], ['/note', { note: 5 }]] as const) {
    assert.equal((await put(id, path, body)).statusCode, 400, `${path} ${JSON.stringify(body)}`);
  }
  assert.equal((await put('bk_nowhere', '/status', { status: 'issue' })).statusCode, 404);
});

test('the browser\'s pre-check is kept as sent, counts its results, and ticks what it matched', async () => {
  const id = await booking('2051-04-02');
  const pre = await put(id, '/pre', { at: '2051-04-01T10:00:00Z', lang: 'eng', text: 'VOUCHER 123 MR SMITH', results: {
    lead: { s: 'match', ev: 'MR SMITH' }, pax: { s: 'mismatch', detail: '3 vs 2' }, cot: { s: 'none' },
  } });
  assert.equal(pre.statusCode, 200, pre.body);
  const dc = pre.json().doc_check as DC;
  assert.deepEqual([dc.items.lead, dc.items.pax], [true, false], 'a match ticks; a mismatch does not untick');
  assert.deepEqual(dc.pre!.summary, { match: 1, maybe: 0, mismatch: 1, none: 4 }, 'over the six items, as legacy counts');
  assert.equal(dc.pre!.text, 'VOUCHER 123 MR SMITH', 'decision C2: the text is kept');
  assert.equal((await put(id, '/pre', { results: { lead: { s: 'sure' } } })).statusCode, 400);

  const echoed = await send('PATCH', `/v1/bookings/${id}`, { doc_check: dc, hotel_name: 'Kept' });
  assert.equal(echoed.statusCode, 200, echoed.body);
  const changed = await send('PATCH', `/v1/bookings/${id}`, { doc_check: { ...dc, status: 'verified' } });
  assert.equal(changed.statusCode, 400);
  assert.match(changed.json().message, /doc-check/);
});
