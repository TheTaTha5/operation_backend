import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enforcedPriceMode, priceBooking, type PricingCatalogue, type QuoteInput, type QuoteTrip } from '../src/domain/pricing.js';
import { parseRouteBlock, type RateType } from '../src/domain/rate-types.js';
import type { Contract } from '../src/domain/contracts.js';
import type { PaxRow } from '../src/domain/pax.js';

// Legacy's pricing rules that its own bookings never exercise (the fixture test covers the rest).
const rate = (id: string, routes: Record<string, object>): RateType =>
  ({ id, routes: Object.entries(routes).map(([route_id, block]) => ({ route_id, ...parseRouteBlock(block, '') })) }) as unknown as RateType;
const standard = rate('rt_std', {
  r1: { zones: { PK: { net: { ad_fr: 1000, chd_fr: 600, ad_th: 800, chd_th: 500 } }, KL: { net: { ad_fr: 0, ad_th: 0 } } },
    longtail: { join_adult: 300, join_child: 200, charter_price: 3500 }, transfer: { PK: { van: 1800 } } },
  r2: { zones: { PK: { net: { ad_fr: 2000, ad_th: 1500 } } } },
});
const winter = rate('rt_winter', { r1: { zones: { PK: { net: { ad_fr: 1200, ad_th: 900 } } } } });
const pax = (grid: Record<string, number>): PaxRow[] => Object.entries(grid).map(([key, count]) => {
  const [category, suffix] = key.split('_');
  return { category, residency: suffix === 'fr' ? 'foreign' : suffix === 'th' ? 'thai' : 'unknown', count } as PaxRow;
});
const trip = (fields: Partial<QuoteTrip> = {}): QuoteTrip => ({ route_id: 'r1', service_date: '2027-01-10', zone: 'PK', pax: pax({ ad_fr: 2 }), ...fields });
const input = (fields: Partial<QuoteInput> = {}): QuoteInput =>
  ({ agent_id: 'a1', booking_date: '2027-01-01', trips: [trip()], add_ons: [], adjustments: [], price_mode: 'rate', rate: 'agent', rate_type_ref: 'rt_std', ...fields });
const catalogue = (fields: Partial<PricingCatalogue> = {}): PricingCatalogue => ({
  rateTypes: new Map([standard, winter].map((r) => [r.id, r])),
  agent: { id: 'a1', code: 'A1', rate_type_id: 'rt_std', rate_seasons: [] }, contracts: [], boatTypes: new Map(), ...fields,
});
const promo = (fields: Partial<Contract>): Contract => ({
  id: 'ct_p', agent_id: 'a1', kind: 'promo', status: 'active', rate_type_id: null, active_from: '2027-01-01', active_to: '2027-01-31', priority: 10,
  version: null, price_mode: 'own', discount: null, bonus: null, book_window: false, created_date: null, created_by: null, note: null, doc_id: null,
  program_periods: [{ route_id: 'r1', book_from: '2026-12-01', book_to: '2027-01-31', travel_from: '2027-01-01', travel_to: '2027-01-31', note: null }],
  seat_prices: [], ...fields,
});

test('seats: per tier, infants free, and legacy\'s bare count priced only when the foreign count is 0', () => {
  assert.equal(priceBooking(input({ trips: [trip({ pax: pax({ ad_fr: 1, chd_fr: 1, ad_th: 1, chd_th: 1, inf_fr: 3 }) })] }), catalogue()).seat, 1000 + 600 + 800 + 500);
  assert.equal(priceBooking(input({ trips: [trip({ pax: pax({ ad: 2 }) })] }), catalogue()).seat, 2000, 'bare adults priced as foreign');
  assert.equal(priceBooking(input({ trips: [trip({ pax: pax({ ad: 2, ad_fr: 1 }) })] }), catalogue()).seat, 1000, 'legacy: ad_fr || ad');
  const notOffered = priceBooking(input({ trips: [trip({ zone: 'KL' })] }), catalogue());
  assert.deepEqual([notOffered.seat, notOffered.warnings[0].code], [0, 'not_offered'], 'both adult prices 0: not offered, ฿0, said');
});

test('the rate: today\'s season, else the agent\'s; an edit keeps the old rate', () => {
  const seasonal = catalogue({ agent: { id: 'a1', code: 'A1', rate_type_id: 'rt_std', rate_seasons: [{ rate_type_id: 'rt_winter', from: '2026-11-01', to: '2027-04-30' }] } });
  const today = priceBooking(input(), seasonal);
  assert.deepEqual([today.seat, today.trips[0].rate_type_id, today.trips[0].rate_source], [2400, 'rt_winter', 'season']);
  const kept = priceBooking(input({ rate: 'kept', trips: [trip({ kept_rate_type_id: null })] }), seasonal);
  assert.deepEqual([kept.seat, kept.trips[0].rate_source], [2000, 'kept'], 'kept: the booking\'s rate_type_ref');
  const moved = priceBooking(input({ rate: 'kept', trips: [trip()] }), seasonal);
  assert.equal(moved.trips[0].rate_source, 'season', 'a trip that is not the one sold has no rate to keep');
});

test('promos: own prices replace whole zones, a discount takes off the main rate, the higher priority wins', () => {
  const own = promo({ seat_prices: [{ route_id: 'r1', zone: 'PK', category: 'ad', residency: 'foreign', price: 700 }] });
  const q = priceBooking(input({ trips: [trip({ pax: pax({ ad_fr: 1, ad_th: 1 }) })] }), catalogue({ contracts: [own] }));
  assert.deepEqual([q.seat, q.trips[0].promo_id], [700, 'ct_p'], 'legacy: a cell missing in a promo zone is 0');
  const off = promo({ id: 'ct_d', price_mode: 'discount', discount: { mode: 'pct', value: 10 } });
  assert.equal(priceBooking(input(), catalogue({ contracts: [off] })).seat, 1800);
  const amt = promo({ id: 'ct_a', price_mode: 'discount', discount: { mode: 'amt', value: 1500 } });
  assert.equal(priceBooking(input(), catalogue({ contracts: [amt] })).seat, 0, 'never below 0');
  assert.equal(priceBooking(input(), catalogue({ contracts: [off, { ...own, priority: 20 }] })).seat, 1400, 'priority 20 beats 10');
  assert.equal(priceBooking(input(), catalogue({ contracts: [{ ...own, book_window: true }] })).trips[0].promo_id, 'ct_p');
  assert.equal(priceBooking(input({ booking_date: '2027-03-01' }), catalogue({ contracts: [{ ...own, book_window: true }] })).trips[0].promo_id, null, 'booked outside its book window');
  assert.equal(priceBooking(input(), catalogue({ contracts: [{ ...own, status: 'void' }] })).trips[0].promo_id, null);
});

test('add-ons from the first trip\'s main rate; adjustments and overnight charges; FOC shown, never subtracted', () => {
  const q = priceBooking(input({
    trips: [trip({ pax: pax({ ad_fr: 2, chd_fr: 1, foc_fr: 1 }), ovn: 'return', ovn_charge: 250 })],
    add_ons: [{ type: 'longtail-join', join_adults: 1 }, { type: 'transfer-r1-PK-van' }, { type: 'mystery' }],
    adjustments: [{ kind: 'discount', mode: 'percent', value: 10 }, { kind: 'extra', mode: 'amount', value: 100 }],
  }), catalogue());
  assert.deepEqual(q.add_ons, [{ amount: 300 + 200, counted: true }, { amount: 1800, counted: true }, { amount: 0, counted: true }], 'join: 1 adult as asked, the child uncapped');
  assert.equal(q.warnings.find((w) => w.code === 'unknown_add_on')?.add_on, 2);
  const base = 2600 + 2300;
  assert.deepEqual([q.seat, q.add_on, q.discount, q.extra, q.foc_discount, q.total], [2600, 2300, -Math.round(base / 10), 350, -1000, base - Math.round(base / 10) + 350]);
});

test('priced by hand: the manual total, adjustments and overnight charges ignored as legacy does', () => {
  const q = priceBooking(input({ price_mode: 'manual', manual_total: 5000, adjustments: [{ kind: 'extra', mode: 'amount', value: 999 }] }), catalogue());
  assert.deepEqual([q.total, q.seat, q.extra, q.trips[0].subtotal], [5000, 5000, 0, 2000], 'the trip subtotal is still the rate engine\'s');
});

test('who may be priced by hand', () => {
  const agent = (id: string, code: string) => ({ id, code, rate_type_id: null, rate_seasons: [] });
  assert.deepEqual(enforcedPriceMode(agent('a_company', 'COMPANY'), undefined, undefined, undefined), { price_mode: 'manual', manual_total: 0 });
  assert.deepEqual(enforcedPriceMode(agent('a_staff', 'STAFF'), 'inspection', undefined, undefined), { price_mode: 'manual', manual_total: 0 });
  assert.deepEqual(enforcedPriceMode(agent('a_staff', 'STAFF'), 'welfare', undefined, undefined), { price_mode: 'rate' });
  assert.deepEqual(enforcedPriceMode(agent('a_walkin', 'WALKIN'), undefined, 'manual', 1200), { price_mode: 'manual', manual_total: 1200 });
  const refused = (f: () => unknown) => assert.throws(f, (e: Error & { statusCode?: number }) => e.statusCode === 400);
  refused(() => enforcedPriceMode(agent('a1', 'A1'), undefined, 'manual', 100));
  refused(() => enforcedPriceMode(agent('a_company', 'COMPANY'), undefined, 'rate', undefined));
  refused(() => enforcedPriceMode(agent('a_staff', 'STAFF'), 'inspection', 'manual', 500));
});
