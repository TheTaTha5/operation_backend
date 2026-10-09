import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLegacyMoney } from '../src/tools/legacy-invoices.js';

// How legacy's sb_invoices and sb_payments become rows (src/tools/legacy-invoices.ts), on rows shaped
// as the legacy tables hold them.
const report = () => {
  const skipped: string[] = [], notes: string[] = [];
  return { skipped, notes, skip: (kind: string, id: string, reason: string) => skipped.push(`${kind} ${id}: ${reason}`), note: (what: string) => notes.push(what) };
};
const ctx = {
  prefix: 'lg_', agents: new Set(['a1']), files: new Set(['att_1']), routeName: (id: string) => (id === 'r1' ? 'Phi Phi' : undefined),
  bookings: new Map([['lg_BK-1', { voucher_ref: 'V-1', legacy_id: 'BK-1', route_id: 'r1', service_date: '2026-08-01' }]]),
};
const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  id, number: 'INV-2608-0001', agentid: 'a1', subtotal: '1000', total: '1000', netamount: '935', vatamount: '65', vatmode: 'include', vatrate: 0.07,
  issuedat: '2026-08-01T03:00:00.000Z', dueat: '2026-08-01T03:00:00.000Z', status: 'issued', createdby: 'RM', feetype: null, note: null, ...extra,
});

test('invoices: a duplicate number gets a suffix, a prepay and a fee keep their kind, a void stays void', () => {
  const r = report();
  const out = mapLegacyMoney({
    invoices: [invoice('i1'), invoice('i2', { issuedat: '2026-08-02T03:00:00.000Z', note: 'prepay' }),
      invoice('i3', { issuedat: '2026-08-03T03:00:00.000Z', number: 'INV-2608-0002', feetype: 'cancellation', vatmode: 'none', status: 'void', subtotal: '400', total: '400' })],
    bookingIds: [{ sb_invoices_id: 'i1', idx: 0, value: 'BK-1' }, { sb_invoices_id: 'i2', idx: 0, value: 'BK-9' }, { sb_invoices_id: 'i3', idx: 0, value: 'BK-1' }],
    lineItems: [{ sb_invoices_id: 'i3', idx: 0, label: 'Cancellation fee · x', amount: '400' }],
    payments: [],
  }, ctx, r);
  assert.deepEqual(out.invoices.map((i) => [i.id, i.number, i.kind, i.fee_type, i.voided, i.note]), [
    ['lg_i1', 'INV-2608-0001', 'booking', null, false, null],
    ['lg_i2', 'INV-2608-0001-2', 'prepay', null, false, null],
    ['lg_i3', 'INV-2608-0002', 'fee', 'cancellation', true, null],
  ]);
  assert.deepEqual(out.lines.map((l) => [l.invoice_id, l.booking_id, l.label, l.amount]), [
    ['lg_i1', 'lg_BK-1', 'V-1 · Phi Phi · 2026-08-01', 1000],
    ['lg_i2', null, 'BK-9', 1000],
    ['lg_i3', 'lg_BK-1', 'Cancellation fee · x', 400],
  ], 'a booking invoice is one line at the amount legacy froze; a booking not imported leaves the line without one');
  assert.ok(r.notes.includes('invoice numbers given a suffix: a duplicate in legacy'));
});

test('payments: slips link to files here; the status is worked out and a difference is counted', () => {
  const r = report();
  const out = mapLegacyMoney({
    invoices: [invoice('i1')],
    bookingIds: [{ sb_invoices_id: 'i1', idx: 0, value: 'BK-1' }],
    lineItems: [],
    payments: [
      { id: 'p1', invoiceid: 'i1', amount: '1000', method: 'transfer', date: '2026-08-01T18:30:00.000Z', type: 'payment', slips: '[{"id":"att_1"},{"id":"att_gone"}]' },
      { id: 'p2', invoiceid: 'i9', amount: '5', method: 'cash', date: '2026-08-01T00:00:00.000Z', type: 'payment', slips: null },
      { id: 'p3', invoiceid: 'i1', amount: '5', method: 'cheque', date: '2026-08-01T00:00:00.000Z', type: 'payment', slips: null },
    ],
  }, ctx, r);
  assert.deepEqual(out.payments.map((p) => [p.id, p.paid_on]), [['lg_p1', '2026-08-02']], 'the day in Bangkok');
  assert.deepEqual(out.slips, [{ payment_id: 'lg_p1', seq: 0, attachment_id: 'att_1' }]);
  assert.deepEqual(r.skipped, ['payment p2: invoice i9 not imported', 'payment p3: method cheque']);
  assert.deepEqual([...out.statusDiffers], [['issued → paid', 1]], 'legacy said issued; the payment pays it');
});
