import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_SEED_UPSERT, contractFromLegacy, contractImportArgs } from '../src/tools/legacy-contracts.js';

// Fixture rows in the shape of legacy's sb_contracts and __programperiods (production, 2026-10-09).
const catalogue = { agentIds: new Set(['a06', 'a13']), rateTypeIds: new Set(['rt1', 'rt2']), routeIds: new Set(['r4', 'r10']) };
const main = {
  id: 'ct_main_a13', agentid: 'a13', kind: 'main', ratetypeid: 'rt1', activefrom: '2025-10-01', activeto: '2026-09-30', priority: '0',
  version: 'v2025-1', status: 'active', createddate: '2025-10-01', createdby: 'migration', note: '', docid: null,
  pricemode: null, rates: null, discount: null, bonus: null, bookwin: null,
};
const period = (idx: number, fields: object = {}) => ({ sb_contracts_id: 'ct_main_a13', idx: String(idx), routeid: 'r4', bookfrom: '2025-10-01', bookto: '2026-09-30', travelfrom: '2025-10-01', travelto: '2026-09-30', note: '', ...fields });

test('a main contract keeps its fields, and its periods in legacy\'s order', () => {
  const mapped = contractFromLegacy(main, [period(1, { routeid: 'r10' }), period(0)], catalogue);
  assert.ok('contract' in mapped);
  assert.deepEqual(mapped.notes, []);
  const { program_periods, ...rest } = mapped.contract;
  assert.deepEqual(rest, {
    id: 'ct_main_a13', agent_id: 'a13', kind: 'main', status: 'active', rate_type_id: 'rt1', active_from: '2025-10-01', active_to: '2026-09-30',
    priority: 0, version: 'v2025-1', price_mode: null, discount: null, bonus: null, book_window: false, created_date: '2025-10-01',
    created_by: 'migration', note: null, doc_id: null, voided_at: null, voided_by: null, seat_prices: [],
  });
  assert.deepEqual(program_periods.map((p) => p.route_id), ['r4', 'r10']);
});

test('an own-price promo\'s prices move into the rate types\' vocabulary', () => {
  const promo = {
    ...main, id: 'ctpromo', kind: 'promo', ratetypeid: null, pricemode: 'own', bookwin: '1', priority: '10',
    rates: JSON.stringify({ r10: { PK: { 'adult-thai': 1500, 'child-thai': 1200, 'adult-fr': 1700, 'child-fr': 1300 } } }),
  };
  const mapped = contractFromLegacy(promo, [], catalogue);
  assert.ok('contract' in mapped);
  assert.equal(mapped.contract.book_window, true);
  assert.deepEqual(mapped.contract.seat_prices, [
    { route_id: 'r10', zone: 'PK', category: 'ad', residency: 'thai', price: 1500 },
    { route_id: 'r10', zone: 'PK', category: 'chd', residency: 'thai', price: 1200 },
    { route_id: 'r10', zone: 'PK', category: 'ad', residency: 'foreign', price: 1700 },
    { route_id: 'r10', zone: 'PK', category: 'chd', residency: 'foreign', price: 1300 },
  ]);
  const old = contractFromLegacy({ ...main, id: 'ctold', kind: 'promo', status: 'void', ratetypeid: 'rt2' }, [], catalogue);
  assert.ok('contract' in old && old.contract.price_mode === 'rate', 'a promo with no mode is read as rate, as legacy does');
});

test('discount and bonus are read as legacy\'s pricing reads them', () => {
  const mapped = contractFromLegacy({ ...main, kind: 'promo', pricemode: 'discount', discount: '{"mode":"amt","value":200}', bonus: '{"on":1,"buy":10,"free":1,"basis":"adchd"}' }, [], catalogue);
  assert.ok('contract' in mapped);
  assert.deepEqual([mapped.contract.discount, mapped.contract.bonus], [{ mode: 'amt', value: 200 }, { buy: 10, free: 1, basis: 'adchd' }]);
  assert.deepEqual(contractFromLegacy({ ...main, kind: 'promo', pricemode: 'discount', discount: '{"mode":"pct","value":0}' }, [], catalogue),
    { skip: 'a discount promo without a discount above 0 (legacy prices it as no promo)' });
});

test('what the schema cannot hold is skipped, set to none or dropped, and noted', () => {
  assert.deepEqual(contractFromLegacy({ ...main, agentid: 'gone' }, [], catalogue), { skip: 'agent gone does not exist' });
  const mapped = contractFromLegacy({ ...main, ratetypeid: 'rt_deleted' }, [
    period(0, { bookfrom: '2026-10-15', bookto: '2026-05-15' }),
    period(1, { travelfrom: '', travelto: '' }),
  ], catalogue);
  assert.ok('contract' in mapped);
  assert.equal(mapped.contract.rate_type_id, null);
  assert.deepEqual(mapped.contract.program_periods.map((p) => [p.travel_from, p.travel_to]), [[null, null]], 'the backwards one is gone; an open travel window stays');
  assert.equal(mapped.notes.length, 2);
});

test('import:contracts seeds only when told: without --seed it writes nothing', () => {
  assert.deepEqual(contractImportArgs([]), { commit: false, seed: false });
  assert.deepEqual(contractImportArgs(['--seed', '--commit']), { commit: true, seed: true });
  assert.throws(() => contractImportArgs(['--comit']), /Unknown flag --comit/);
  // A void made here keeps its stamp only while legacy's row is void too.
  assert.match(CONTRACT_SEED_UPSERT, /voided_at = CASE WHEN EXCLUDED\.status = 'void' THEN contracts\.voided_at END/);
});
