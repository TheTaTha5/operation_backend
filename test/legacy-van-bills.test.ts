import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyDailySettings, mapLegacyVanBills, mapLegacyVanRates } from '../src/tools/legacy-van-bills.js';

const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => { skipped.push(`${kind} ${id}: ${reason}`); }, note: (what: string) => { notes.push(what); } };
};

test('van bills: today\'s key imported with its inputs; the older four-part key skipped', () => {
  const r = report();
  const bills = mapLegacyVanBills([
    { key: 'ภูเก็ตล่ำซำ|2026-09|1', value: JSON.stringify({ perPax: 200, rate: 0, rateC: { PP: 1500, XX: 9 },
      rows: { '2026-09-08~r10~veh19': { rate: 1200 }, '2026-09-09~r12~veh11~R': { rate: 800 }, '2026-09-10~r10~veh11': { ex: 0 }, bad: { ex: 1 } },
      extra: [{ id: 'xmucdwfn2', date: '2026-09-01', note: 'รถนอก', van: 1, pax: 0, rate: 700, ex: 0, cut: 0, per: 0 }],
      by: 'AP.Petch', at: '2026-09-14T03:17:06.859Z', seen: ['2026-09-08~r10~veh19'] }) },
    { key: 'TAXI นอก|2026-10|1', value: '{"perPax":0,"rate":0,"rows":{"2026-10-08~r10~veh10":{"rate":0}},"extra":[],"by":"admin","at":"2026-10-09T06:30:46.264Z"}' },
    { key: 'โกหมง|*|2026-08|2', value: '{"perPax":200}' },
    { key: 'เขาหลัก|2026-09|3', value: '{"perPax":0,"rate":0,"rows":{},"extra":[],"by":"","at":""}' },
  ], r);
  assert.equal(bills.length, 3);
  const [a, taxi, blank] = bills;
  assert.deepEqual([a.partner, a.month, a.period, a.per_pax, a.rate, a.route_rates, a.updated_by, a.updated_at], ['ภูเก็ตล่ำซำ', '2026-09', 1, 200, 0, { PP: 1500 }, 'AP.Petch', '2026-09-14T03:17:06.859Z']);
  assert.deepEqual(Object.keys(a.row_overrides), ['2026-09-08~r10~veh19', '2026-09-09~r12~veh11~R', '2026-09-10~r10~veh11']);
  assert.deepEqual(a.row_overrides['2026-09-10~r10~veh11'], { rate: null, ex: 0, cut: null, per: null }, 'an explicit 0 is kept');
  assert.deepEqual(a.extra_lines, [{ id: 'xmucdwfn2', date: '2026-09-01', note: 'รถนอก', vans: 1, pax: 0, rate: 700, ex: 0, cut: 0, per_pax: 0 }]);
  assert.deepEqual(a.seen, ['2026-09-08~r10~veh19']);
  assert.deepEqual(taxi.row_overrides['2026-10-08~r10~veh10'], { rate: 0, ex: null, cut: null, per: null }, 'rate 0 is "no charge", not "not set"');
  assert.equal(taxi.seen, null, 'never saved with §vbSeen');
  assert.deepEqual([blank.updated_by, blank.updated_at], [null, null]);
  assert.deepEqual(r.skipped, ['van bill โกหมง|*|2026-08|2: older key (partner|van|month|period): legacy no longer reads it']);
  assert.ok(r.notes.includes('van bill route rates dropped: code XX'));
});

test('van rates and the daily report settings', () => {
  const r = report();
  const raw = JSON.stringify(JSON.stringify({ own: { rt: { r7: { PK: 1700, KL: 0 }, r99: { PK: 1 } } }, 'p:TAXI นอก': { base: 1200 }, bogus: { base: 1 } }));
  assert.deepEqual(mapLegacyVanRates(raw, new Set(['r7']), r), [
    { group_key: 'own', route_id: 'r7', field: 'PK', rate: 1700 }, { group_key: 'own', route_id: 'r7', field: 'KL', rate: 0 },
    { group_key: 'p:TAXI นอก', route_id: null, field: 'base', rate: 1200 },
  ]);
  assert.ok(r.notes.includes('van rates dropped: route r99 not in catalogue'));
  assert.deepEqual(r.skipped, ['van rates bogus: not a van group']);
  assert.deepEqual(mapLegacyDailySettings('"{\\"vanCost\\":1700,\\"vanQuota\\":6,\\"targetPerPax\\":0}"'), { van_cost: 1700, van_quota: 6, target_per_pax: null });
});
