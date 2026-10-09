import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

// Attachments (todo/booking-extras-model.md §1), on whichever store DATABASE_URL selects.
const app = buildApp();
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
async function upload(name = 'voucher.jpg', data = jpeg, mime = 'image/jpeg') {
  const r = await send('POST', '/v1/attachments', { filename: name, mime, data_b64: data.toString('base64') });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string; name: string; mime: string; size: number };
}
async function booking(date: string, extra: object = {}) {
  await send('POST', '/operations/deployments', { boat_id: `att-boat-${date}`, route_id: 'r1', service_date: date, capacity: 40 });
  const created = await send('POST', '/v1/bookings', { route_id: 'r1', service_date: date, pax: 2, ...extra });
  assert.equal(created.statusCode, 201, created.body);
  return created.json() as { id: string; attachments: { id: string; name: string; kind: string | null; by: string | null; at: string }[]; upgrades: { slips: { id: string; name: string }[] }[] };
}

test('a file is uploaded once, downloaded as it was, and refused when too big or of another kind', async () => {
  const file = await upload();
  assert.match(file.id, /^att_/);
  assert.deepEqual([file.name, file.mime, file.size], ['voucher.jpg', 'image/jpeg', jpeg.length]);
  const got = await send('GET', `/v1/attachments/${file.id}`);
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.deepEqual(got.rawPayload, jpeg);

  const big = await send('POST', '/v1/attachments', { filename: 'big.jpg', mime: 'image/jpeg', data_b64: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') });
  assert.equal(big.statusCode, 400, big.body);
  assert.match(big.json().message, /limit is 6 MB/);
  for (const bad of [{ filename: 'x.gif', mime: 'image/gif', data_b64: 'AAAA' }, { filename: 'x.jpg', mime: 'image/jpeg', data_b64: '***' }, { mime: 'image/jpeg', data_b64: 'AAAA' }]) {
    assert.equal((await send('POST', '/v1/attachments', bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await send('GET', '/v1/attachments/att_nowhere')).statusCode, 404);
});

test('a booking names its documents; each must exist, and keeps who added it; a file in use is not deleted', async () => {
  const [voucher, passport] = [await upload(), await upload('passport.pdf', Buffer.from('%PDF-1.4 test'), 'application/pdf')];
  const b = await booking('2051-02-01', { attachments: [{ id: voucher.id, kind: 'upload' }] });
  assert.deepEqual(b.attachments.map((a) => [a.id, a.name, a.kind]), [[voucher.id, 'voucher.jpg', 'upload']]);
  const at = b.attachments[0].at;
  assert.ok(at);

  const more = await send('PATCH', `/v1/bookings/${b.id}`, { attachments: [...b.attachments, { id: passport.id, kind: 'capture' }] });
  assert.equal(more.statusCode, 200, more.body);
  assert.deepEqual(more.json().attachments.map((a: { name: string; at: string }) => [a.name, a.at === at]), [['voucher.jpg', true], ['passport.pdf', false]], 'the kept one keeps its time');
  assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, { attachments: [{ id: 'att_nowhere' }] })).statusCode, 400);

  const inUse = await send('DELETE', `/v1/attachments/${voucher.id}`);
  assert.deepEqual([inUse.statusCode, inUse.json().code], [409, 'attachment_in_use']);
  await send('PATCH', `/v1/bookings/${b.id}`, { attachments: [] });
  assert.equal((await send('DELETE', `/v1/attachments/${voucher.id}`)).statusCode, 204);
  assert.equal((await send('DELETE', `/v1/attachments/${voucher.id}`)).statusCode, 404);
});

test('an upgrade sale carries its payment slips', async () => {
  const slip = await upload('slip.jpg');
  const b = await booking('2051-02-02', { upgrades: [{ id: 'up_slip', label: 'Longtail', sell_price: 2000, method: 'card', fee_pct: 5, slips: [{ id: slip.id }] }] });
  assert.deepEqual(b.upgrades[0].slips.map((s) => [s.id, s.name]), [[slip.id, 'slip.jpg']]);
  const echoed = await send('PATCH', `/v1/bookings/${b.id}`, { upgrades: b.upgrades });
  assert.equal(echoed.statusCode, 200, echoed.body);
  assert.equal(echoed.json().upgrades[0].slips.length, 1, 'a read sent back keeps them');
  assert.equal((await send('PATCH', `/v1/bookings/${b.id}`, { upgrades: [{ ...b.upgrades[0], slips: ['att_nowhere'] }] })).statusCode, 400);
});
