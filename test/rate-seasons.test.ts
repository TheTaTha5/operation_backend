import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { parseRateSeasons, rateTypeFor, seasonsActivityText, type RateSeason } from '../src/domain/rate-seasons.js';
import { seedAgents, testStore } from './users-helper.js';

// Agent rate seasons (todo/rate-seasons-model.md): legacy's `§rtSeason`, on whichever store
// DATABASE_URL selects.
const store = testStore();
const app = buildApp({ store });
after(async () => app.close());
const send = (method: InjectOptions['method'], url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });

const winter: RateSeason = { rate_type_id: 'rt_w', from: '2026-11-01', to: '2027-04-30' };
const summer: RateSeason = { rate_type_id: 'rt_s', from: '2027-05-01', to: null };

test('the season with the latest start that covers the date wins; else the agent\'s own rate', () => {
  assert.deepEqual(rateTypeFor('rt_own', [summer, winter], '2027-01-15'), { rate_type_id: 'rt_w', source: 'season', season: winter });
  assert.equal(rateTypeFor('rt_own', [winter, summer], '2030-01-01').rate_type_id, 'rt_s', 'no end');
  assert.deepEqual(rateTypeFor('rt_own', [winter, summer], '2026-10-31'), { rate_type_id: 'rt_own', source: 'agent', season: null });
  const overlap: RateSeason = { rate_type_id: 'rt_promo', from: '2027-01-01', to: '2027-01-31' };
  assert.equal(rateTypeFor('rt_own', [winter, overlap], '2027-01-10').rate_type_id, 'rt_promo', 'overlapping: the later start wins, as legacy');
  assert.equal(rateTypeFor('rt_own', [winter, overlap], '2027-02-10').rate_type_id, 'rt_w');
  assert.equal(rateTypeFor(null, [], '2027-01-10').rate_type_id, null);
});

test('a season table is parsed in legacy\'s spelling too, sorted, and refused where it makes no sense', () => {
  assert.deepEqual(parseRateSeasons({ seasons: [{ rt: 'rt_s', from: '2027-05-01', to: '' }, { rate_type_id: 'rt_w', from: '2026-11-01', to: '2027-04-30' }] }), [winter, summer]);
  const refused = (seasons: object[]) => assert.throws(() => parseRateSeasons({ seasons }), (e: Error & { statusCode?: number }) => e.statusCode === 400);
  refused([{ rt: 'rt_w', from: '2027-04-30', to: '2026-11-01' }]);
  refused([{ rt: 'rt_w', from: '2026-11-01' }, { rt: 'rt_s', from: '2026-11-01' }]);
  refused([{ rt: 'rt_w', from: '1/11/2026' }]);
  refused([{ from: '2026-11-01' }]);
});

test('legacy\'s activity line, word for word', () => {
  const name = (id: string) => ({ rt_w: 'Winter', rt_s: 'Summer' })[id] ?? id;
  assert.equal(seasonsActivityText([winter, summer], name), 'ตั้งตารางฤดูกาล 2 ช่วง · Winter 2026-11-01→2027-04-30 · Summer 2027-05-01→ไม่มีวันสิ้นสุด');
  assert.equal(seasonsActivityText([], name), 'เอาตารางฤดูกาลออก · กลับไปใช้ชุดราคาเดียวทั้งปี');
});

test('sales set an agent\'s seasons; the agent, the lookup and the activity log follow', async () => {
  await seedAgents(store, [], { rs_a1: null });
  const run = Date.now().toString(36);
  const ids: string[] = [];
  for (const label of ['Winter', 'Summer']) {
    const created = await send('POST', '/v1/rate-types', { name: `RS ${run} ${label}` });
    assert.equal(created.statusCode, 201, created.body);
    ids.push(created.json().id);
  }
  const put = await send('PUT', '/v1/agents/rs_a1/rate-seasons', { seasons: [{ rt: ids[1], from: '2027-05-01', to: '' }, { rate_type_id: ids[0], from: '2026-11-01', to: '2027-04-30' }] });
  assert.equal(put.statusCode, 200, put.body);
  assert.deepEqual(put.json().seasons.map((s: RateSeason) => [s.rate_type_id, s.from, s.to]), [[ids[0], '2026-11-01', '2027-04-30'], [ids[1], '2027-05-01', null]]);
  assert.equal((await send('GET', '/v1/agents/rs_a1')).json().rate_seasons.length, 2);
  assert.deepEqual((await send('GET', '/v1/agents/rs_a1/rate-type?date=2027-06-01')).json(), { rate_type_id: ids[1], source: 'season', season: { rate_type_id: ids[1], from: '2027-05-01', to: null } });
  assert.equal((await send('GET', '/v1/agents/rs_a1/rate-type?date=June')).statusCode, 400);
  const log = (await send('GET', '/v1/agents/rs_a1/activity')).json().activity;
  assert.equal(log[0].text, `ตั้งตารางฤดูกาล 2 ช่วง · RS ${run} Winter 2026-11-01→2027-04-30 · RS ${run} Summer 2027-05-01→ไม่มีวันสิ้นสุด`);

  assert.equal((await send('DELETE', `/v1/rate-types/${ids[0]}`)).statusCode, 409, 'a rate type a season uses is in use');
  assert.equal((await send('PUT', '/v1/agents/rs_a1/rate-seasons', { seasons: [{ rt: 'rt_none', from: '2027-01-01' }] })).statusCode, 400);
  assert.equal((await send('PUT', '/v1/agents/nobody/rate-seasons', { seasons: [] })).statusCode, 404);
  assert.deepEqual((await send('PUT', '/v1/agents/rs_a1/rate-seasons', { seasons: [] })).json().seasons, [], '[] clears');
  assert.equal((await send('DELETE', `/v1/rate-types/${ids[0]}`)).statusCode, 204, 'free again');
});
