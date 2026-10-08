import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalRows, focReason } from '../src/tools/legacy-approvals.js';
import type { Report } from '../src/tools/legacy-records.js';

// Fixture rows in the shape of legacy's `sb_bookings` approval columns.
const AT = '2026-09-01T00:00:00.000Z';
function reporter() {
  const skipped: string[] = [], notes: string[] = [];
  const report: Report = { skip: (kind, id, reason) => { skipped.push(`${kind} ${id}: ${reason}`); }, note: (what) => { notes.push(what); } };
  return { report, skipped, notes };
}
const over = JSON.stringify([{ routeId: 'r10', date: '2026-06-12', name: 'Phi Phi', need: 27, capFree: 25, overBy: 2, licFree: 35 }]);

test('an over-allotment approval keeps its reason, days and decision', () => {
  const { report, skipped } = reporter();
  const { approvals, days } = approvalRows({
    id: 'BK-1', status: 'confirmed', approval_status: 'approved', approval_reason: 'over_capacity', approval_targetstatus: 'confirmed',
    approval_totover: 2, approval_requestedby: 'ops1', approval_requestedat: '2026-06-01T03:00:00.000Z',
    approval_approvedby: 'mgr', approval_approvedat: '2026-06-02T03:00:00.000Z', approval_note: 'second boat', approval_over: over,
  }, 'lg_BK-1', AT, report, true);
  assert.deepEqual(approvals, [{
    booking_id: 'lg_BK-1', kind: 'approval', status: 'approved', reason: 'over_capacity', over_capacity: true, over_total: 2, discount: null,
    foc_count: null, target_status: 'confirmed', requested_by: 'ops1', requested_at: '2026-06-01T03:00:00.000Z',
    decided_by: 'mgr', decided_at: '2026-06-02T03:00:00.000Z', note: 'second boat',
  }]);
  assert.deepEqual(days, [{ booking_id: 'lg_BK-1', kind: 'approval', route_id: 'r10', service_date: '2026-06-12', need: 27, over_by: 2, licensed_free: 35 }]);
  assert.deepEqual(approvalRows({ id: 'BK-1', approval_status: 'approved', approval_over: over }, 'lg_BK-1', AT, reporter().report, false).days[0]!.licensed_free,
    undefined, 'licFree only where the schema keeps it');
  assert.deepEqual(skipped, []);
});

test('a discount or other-label approval is not over capacity, and a pending one keeps no decision', () => {
  const { report, notes } = reporter();
  const [discount] = approvalRows({ id: 'BK-2', status: 'pending_approval', approval_status: 'pending', approval_reason: 'discount',
    approval_approvedby: 'stale', approval_approvedat: AT }, 'lg_BK-2', AT, report).approvals;
  assert.equal(discount!.over_capacity, false);
  assert.equal(discount!.over_total, null);
  assert.equal(discount!.decided_by, null, 'a pending approval is not decided, whatever legacy left in the columns');
  assert.equal(discount!.requested_at, AT, 'no request time of its own: the booking\'s');
  assert.equal(discount!.target_status, 'confirmed', 'a blank target is confirmed');
  const [held] = approvalRows({ id: 'BK-3', status: 'confirmed', approval_status: 'rejected', approval_reason: 'b2c_hold' }, 'lg_BK-3', AT, report).approvals;
  assert.equal(held!.reason, 'b2c_hold');
  assert.equal(held!.over_capacity, false);
  assert.ok(notes.includes('approval target blank → confirmed'));
});

test('an FOC approval carries its count; a stale pending one is imported and counted', () => {
  const { report, notes } = reporter();
  const { approvals } = approvalRows({ id: 'BK-4', status: 'cancelled', focapproval_status: 'pending', focapproval_count: 3,
    focapproval_requestedby: 'RM', focapproval_requestedat: '2026-07-01T00:00:00.000Z' }, 'lg_BK-4', AT, report);
  assert.deepEqual(approvals, [{
    booking_id: 'lg_BK-4', kind: 'foc', status: 'pending', reason: null, over_capacity: false, over_total: null, discount: null, foc_count: 3,
    target_status: 'confirmed', requested_by: 'RM', requested_at: '2026-07-01T00:00:00.000Z', decided_by: null, decided_at: null, note: null,
  }]);
  assert.deepEqual(notes, ['FOC approvals still pending on a booking no longer pending_foc (imported as is)']);
});

test('a status legacy never had is skipped; bad days are dropped and counted', () => {
  const { report, skipped, notes } = reporter();
  const { approvals, days } = approvalRows({
    id: 'BK-5', approval_status: 'maybe', focapproval_status: 'approved',
    approval_over: JSON.stringify([{ routeId: 'r1', date: 'soon', need: 1, overBy: 1 }]),
  }, 'lg_BK-5', AT, report);
  assert.deepEqual(approvals.map((a) => a.kind), ['foc']);
  assert.deepEqual(days, []);
  assert.deepEqual(skipped, ['approval BK-5: status maybe']);
  const zero = approvalRows({ id: 'BK-6', approval_status: 'approved', approval_over: JSON.stringify([{ routeId: 'r1', date: '2026-06-01', need: 3, overBy: 0 }]) }, 'lg_BK-6', AT, report);
  assert.deepEqual(zero.days, []);
  assert.equal(zero.approvals[0]!.over_capacity, false, 'nothing over and no over_cap label: not over capacity');
  assert.ok(notes.includes('approval days dropped: no route, bad date, or nothing over'));
});

test('the FOC reason is the booking\'s own, else its FOC approval\'s', () => {
  const { report, notes } = reporter();
  assert.equal(focReason({ focreason: 'TL', focapproval_reason: 'Guide' }, report), 'TL');
  assert.equal(focReason({ focreason: '', focapproval_reason: 'Guide' }, report), 'Guide');
  assert.equal(focReason({}, report), null);
  assert.deepEqual(notes, ['foc_reason taken from the FOC approval (focapproval_reason)']);
});
