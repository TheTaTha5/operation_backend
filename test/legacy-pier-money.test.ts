import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyPierMoney } from '../src/tools/legacy-pier-money.js';

// How legacy's pier payments, SB_EXTRAS, TS_COT, travel_sum and Daily PFM history become rows
// (src/tools/legacy-pier-money.ts), on rows shaped as the legacy tables hold them.
const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => skipped.push(`${kind} ${id}: ${reason}`), note: (what: string) => notes.push(what) };
};
const ctx = { prefix: 'lg_', bookings: new Set(['lg_BK-1', 'lg_BK-2']), files: new Set(['att_1']) };
const none = { bookings: [], extras: [], tsCot: [], travelSum: [], history: [] };

test('pier payments: ids prefixed, a card keeps its fee and percentage, a slip not copied is dropped and counted', () => {
  const r = report();
  const out = mapLegacyPierMoney({ ...none, bookings: [
    { id: 'BK-1', pierpayments: JSON.stringify([
      { id: 'pp_a', date: '2026-10-07', amount: 1700, method: 'card', fee: 85, feePct: 5, note: '', slips: [{ id: 'att_1' }, { id: 'att_gone' }], by: 'Pier.Asst', at: '2026-10-07T01:47:46.055Z' },
      { id: 'pp_b', date: '2026-10-07', amount: 3000, method: 'cash', fee: 0, feePct: null, note: 'x', slips: [], by: 'GSA', at: '2026-10-07T01:48:00.000Z' },
      { id: 'pp_c', date: '2026-10-07', amount: 0, method: 'cash' },
      { id: 'pp_d', date: '2026-10-07', amount: 10, method: 'cash', fee: 5 },
    ]) },
    { id: 'BK-9', pierpayments: JSON.stringify([{ id: 'pp_e', date: '2026-10-07', amount: 10, method: 'cash' }]) },
    { id: 'BK-2', pierpayments: '[]' },
  ] }, ctx, r);
  assert.deepEqual(out.pierPayments.map((p) => [p.id, p.booking_id, p.method, p.amount, p.fee, p.fee_pct, p.note, p.by]), [
    ['lg_pp_a', 'lg_BK-1', 'card', 1700, 85, 5, null, 'Pier.Asst'], ['lg_pp_b', 'lg_BK-1', 'cash', 3000, 0, null, 'x', 'GSA'],
  ]);
  assert.deepEqual(out.pierSlips, [{ payment_id: 'lg_pp_a', seq: 0, attachment_id: 'att_1' }]);
  assert.deepEqual(r.skipped, ['pier payment pp_c: amount 0', 'pier payment pp_d: a fee on cash', 'pier payment BK-9: booking not imported']);
  assert.ok(r.notes.some((n) => n.startsWith('pier payment slips dropped')));
});

test('on-tour sales: total and commission follow from the row, fees kept as legacy rounded them, a cot sale settled becomes cash', () => {
  const r = report();
  const sale = (id: string, extra: Record<string, unknown>) => ({ id, bookingid: 'BK-1', tripdate: '2026-10-09', service: 'Longtail (Private)', qty: 1, unitprice: 2500, total: 2500,
    tocompany: 1750, commission: 750, seller: 'PLOY', method: 'cash', settle: 'done', date: '2026-10-09T09:08:22.986Z', feepct: 0, fee: 0, customerpaid: 2500, slips: '[]', ...extra });
  const out = mapLegacyPierMoney({ ...none, extras: [
    sale('ex_1', {}), sale('ex_2', { method: 'card', feepct: 3, fee: 20, unitprice: 650, total: 650, tocompany: 455 }), sale('ex_3', { method: 'cot', settle: 'pending', tripdate: '' }),
    sale('ex_4', { method: 'cot', settle: 'done' }), sale('ex_5', { bookingid: 'BK-9' }), sale('ex_6', { unitprice: 0 }),
  ] }, ctx, r);
  assert.deepEqual(out.tourSales.map((s) => [s.id, s.method, s.unit_price, s.to_company, s.fee_pct, s.fee, s.trip_date, s.sold_at]), [
    ['lg_ex_1', 'cash', 2500, 1750, 0, 0, '2026-10-09', '2026-10-09T09:08:22.986Z'], ['lg_ex_2', 'card', 650, 455, 3, 20, '2026-10-09', '2026-10-09T09:08:22.986Z'],
    ['lg_ex_3', 'cot', 2500, 1750, 0, 0, null, '2026-10-09T09:08:22.986Z'], ['lg_ex_4', 'cash', 2500, 1750, 0, 0, '2026-10-09', '2026-10-09T09:08:22.986Z'],
  ]);
  assert.deepEqual(r.skipped, ['on-tour sale ex_5: booking not imported', 'on-tour sale ex_6: qty 1 × price 0']);
});

test('after the trip: TS_COT and travel_sum keyed <date>::<booking>, as legacy has them; legacy\'s "—" is nobody', () => {
  const r = report();
  const out = mapLegacyPierMoney({ ...none,
    tsCot: [
      { id: '2026-10-09::BK-1', key: '2026-10-09::BK-1', mode: 'full', deduct: 3000, payout: 0, ref: null, by: 'GSA.PK02', at: '2026-10-09T07:37:04.630Z', slips: '[{"id":"att_1"}]' },
      { id: '2026-08-09::BK-2', key: '2026-08-09::BK-2', mode: 'nocol', deduct: 0, payout: 0, ref: 'no-show', by: '—', at: '2026-08-10T08:31:32.027Z', slips: null },
      { id: 'x', key: '2026-08-09::BK-3', mode: 'full', deduct: 1, payout: 0, at: '2026-08-10T08:31:32.027Z' },
      { id: 'y', key: '2026-08-09::BK-1', mode: 'half', at: '2026-08-10T08:31:32.027Z' },
    ],
    travelSum: [
      { id: '2026-08-16::BK-1', key: '2026-08-16::BK-1', decision: 'full', amount: 6400, note: null, by: '—', at: '2026-08-16T02:40:38.246Z' },
      { id: '2026-08-17::BK-2', key: '2026-08-17::BK-2', decision: 'postpone', amount: null, note: 'moved', by: 'GSA.PK01', at: '2026-08-17T01:56:38.845Z' },
    ],
  }, ctx, r);
  assert.deepEqual(out.cotDecisions, [
    { booking_id: 'lg_BK-1', service_date: '2026-10-09', mode: 'full', deduct: 3000, payout: 0, ref: null, by: 'GSA.PK02', at: '2026-10-09T07:37:04.630Z' },
    { booking_id: 'lg_BK-2', service_date: '2026-08-09', mode: 'nocol', deduct: 0, payout: 0, ref: 'no-show', by: null, at: '2026-08-10T08:31:32.027Z' },
  ]);
  assert.deepEqual(out.cotSlips, [{ booking_id: 'lg_BK-1', service_date: '2026-10-09', seq: 0, attachment_id: 'att_1' }]);
  assert.deepEqual(out.noshow.map((c) => [c.booking_id, c.service_date, c.decision, c.amount, c.note, c.by]), [
    ['lg_BK-1', '2026-08-16', 'full', 6400, null, null], ['lg_BK-2', '2026-08-17', 'postpone', 0, 'moved', 'GSA.PK01'],
  ]);
  assert.deepEqual(r.skipped, ['COT decision 2026-08-09::BK-3: booking BK-3 not imported', 'COT decision 2026-08-09::BK-1: mode half']);
});

test('Daily PFM: legacy lost ops.pfm, so its history lines are the decisions', () => {
  const r = report();
  const h = (id: string, text: string, at = '2026-09-01T10:00:00.000Z') => ({ sb_bookings_id: id, idx: 0, at, kind: 'edit', text, tag: 'Notify', by: 'Nok' });
  const out = mapLegacyPierMoney({ ...none, history: [
    h('BK-1', 'PFM payment reminder sent'), h('BK-1', 'PFM unpaid · travel EXTENDED by P\'MAM'), h('BK-2', 'PFM unpaid · put on hold'),
    h('BK-9', 'PFM payment reminder sent'), h('BK-1', 'Edited · pax'),
  ] }, ctx, r);
  assert.deepEqual(out.pfmEvents.map((e) => [e.booking_id, e.kind, e.approver, e.by]), [
    ['lg_BK-1', 'reminded', null, 'Nok'], ['lg_BK-1', 'approved', 'P\'MAM', 'Nok'], ['lg_BK-2', 'hold', null, 'Nok'],
  ]);
});
