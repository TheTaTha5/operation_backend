import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyCosting, mergeActual } from '../src/tools/legacy-costing.js';
import { blankActual } from '../src/domain/trip-actuals.js';

// Legacy's cost model and trip actuals as rows (src/tools/legacy-costing.ts), on fixture rows shaped
// like production's (app_meta values are JSON text of JSON text).
const twice = (v: unknown) => JSON.stringify(JSON.stringify(v));
const src = {
  meta: [
    { key: 'cost_template', value: twice({ vatRate: 7, lines: [
      { id: 'park', g: 'อุทยาน', l: 'ค่าเข้าอุทยาน', vat: false, parts: [{ k: 'var', u: 0 }, { k: 'var', u: 0 }] },
      { id: 'fuel', g: 'น้ำมัน', l: 'น้ำมันเรือ', vat: true, parts: [{ k: 'fix', per: 'boat', q: 360, q4: 520, fuel: true }] },
      { id: 'ltc', g: 'หางยาว', l: 'เหมา', vat: false, parts: [{ k: 'fix', q: 0, u: 1000 }], od: 1, odQ: 0 },
    ] }) },
    { key: 'cost_plans', value: twice([
      { id: 'p4ojal1', name: 'Phi Phi + Bamboo', famId: 'r10', eng: '4EN', boats: 1, cap: 65, pax: 65, paxTH: 65, price: 1200, comm: 0, fuel: 40, priceCh: 1400,
        ovr: { park: { p: [{ u: 400, uTH: 40 }, {}] }, gear: {}, xxlm0df: { off: 1 } }, grp: { Hotel: { off: 1 }, 'อุทยาน': {} }, od: { van: { aQ: 0 } } },
      { id: 'pgone', name: 'Old', famId: 'r999', eng: '3EN', boats: 1, cap: 38, pax: 33, paxTH: 0, price: 1400, comm: 0, fuel: 40, priceCh: '', boatId: 'b404', itin: [{ t: '09.30' }] },
    ]) },
    { key: 'boat_rent', value: twice({
      b1: { on: 1, mode: 'lump', amt: 0, seat: 0, days: 30, off: 2, trips: 1, vat: 0, note: '', from: '', to: '', ex: { dep: 1, cap: 1, crew: 1 } },
      b178: { on: 1, mode: 'lump', amt: 420000, seat: 0, days: 30, off: 2, trips: 1, vat: 0, note: '', from: '2026-11-01', to: '2027-10-31', ex: { dep: 1, cap: 1, crew: 1 }, fuelMul: 80 },
      bgone: { on: 1 },
    }) },
  ],
  venues: [{ id: 'mvny4wld', name: 'ร้านอาหารต้นไทร', place: '', price_ad: '210', price_ch: '105', phone: '', note: '', active: true, eta: null }],
  routes: [{ id: 'r10', mealvenueid: 'mvny4wld' }, { id: 'r12', mealvenueid: null }, { id: 'r11', mealvenueid: 'mv_unknown' }],
  actuals: [
    { key: '2026-08-15::b2', value: JSON.stringify({ meal: { venueId: 'mvny4wld', name: 'ร้านอาหารต้นไทร', ad: 56, chd: 3, priceAd: 210, priceCh: 105, amount: 12075, at: '2026-08-15T11:56:22.833Z', by: '—' } }) },
    { key: '2026-09-03::b13', value: JSON.stringify({ mealOvn: { 'BK-1': 'in', 'BK-404': 'out' }, mealNote: { t: 'UPDAETD #1', at: '2026-09-03T02:34:39.124Z', by: 'GSA.PK02' } }) },
    { key: '2026-09-04::b404', value: JSON.stringify({ meal: { amount: 1 } }) },
  ],
  pierJobs: [{ key: '2026-08-31::b10', value: JSON.stringify({ cap: 'x', mv: '-' }) }, { key: '2026-08-15::b2', value: JSON.stringify({ mv: '' }) }],
};
const here = {
  routeKeys: new Set(['r10', 'r11', 'r12', 'phiphi']), routes: new Set(['r10', 'r11', 'r12']), boats: new Set(['b1', 'b178', 'b2', 'b10', 'b13']),
  bookings: new Set(['lg_BK-1']), prefix: 'lg_', now: '2026-10-10T00:00:00.000Z',
};

test('legacy\'s cost model and trip actuals map to rows; what is not here is listed', () => {
  const skipped: string[] = [];
  const out = mapLegacyCosting(src, here, { skip: (k, id, why) => skipped.push(`${k} ${id}: ${why}`), note: () => {} });
  assert.deepEqual(out.template?.lines.map((l) => [l.id, l.parts.length, l.on_demand, l.on_demand_qty]), [['park', 2, false, null], ['fuel', 1, false, null], ['ltc', 1, true, 0]]);
  assert.deepEqual(out.template?.lines[1].parts[0], { kind: 'fix', per: 'boat', qty: 360, qty_4en: 520, fuel: true });

  const [p, old] = out.plans;
  assert.deepEqual([p.id, p.route_key, p.engines, p.pax_th, p.price_child, p.on_demand, p.groups], ['p4ojal1', 'r10', '4EN', 65, 1400, { van: { agent_qty: 0 } }, { Hotel: { off: true }, 'อุทยาน': {} }]);
  assert.deepEqual(p.overrides, { park: { parts: [{ unit: 400, unit_th: 40 }, null] }, gear: {}, xxlm0df: { off: true } });
  assert.deepEqual([old.route_key, old.boat_id, old.price_child, old.itinerary], [null, null, null, [{ t: '09.30' }]]);

  assert.deepEqual(out.rents.map((r) => [r.boat_id, r.rented, r.amount, r.from, r.fuel_pct, r.owner_pays]),
    [['b1', true, 0, null, null, ['dep', 'cap', 'crew']], ['b178', true, 420000, '2026-11-01', 80, ['dep', 'cap', 'crew']]]);
  assert.deepEqual(out.venues.map((v) => [v.id, v.price_adult, v.price_child, v.place]), [['mvny4wld', 210, 105, null]]);
  assert.deepEqual(out.routeVenues, [{ route_id: 'r10', venue_id: 'mvny4wld' }, { route_id: 'r12', venue_id: null }]);

  const [a, b, c] = out.actuals;
  assert.deepEqual([a.service_date, a.boat_id, a.meal?.amount, a.meal?.adults, a.meal?.by, a.no_meal], ['2026-08-15', 'b2', 12075, 56, null, false]);
  assert.deepEqual([b.boat_id, b.no_meal], ['b10', true], 'pier_job mv "-": no meal that day');
  assert.deepEqual([c.meal_overnight, c.meal_note?.text, c.meal_note?.by], [{ 'lg_BK-1': 'in' }, 'UPDAETD #1', 'GSA.PK02']);
  assert.equal(out.actuals.length, 3);
  assert.deepEqual(skipped.map((s) => s.split(': ')[0]).sort(), [
    'boat rent bgone', 'overnight meal 2026-09-03::b13/BK-404', 'plan boat pgone', 'plan route pgone', 'route venue r11', 'trip actual 2026-09-04::b404',
  ]);
});

test('a re-import keeps a close or "ran" made here', () => {
  const mine = { ...blankActual('2026-08-15', 'b2'), ran: true, ran_at: 'x', ran_by: 'acct', closed: { at: 'x', by: 'acct', revenue: 1, cost: 1, profit: 0, pax: 1, rows: [] } };
  const theirs = { ...blankActual('2026-08-15', 'b2'), meal_note: { text: 'n', at: null, by: null } };
  const m = mergeActual(mine, theirs);
  assert.deepEqual([m.ran, m.ran_by, m.closed?.by, m.meal_note?.text], [true, 'acct', 'acct', 'n']);
});
