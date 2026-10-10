import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { cancellationRow, companyPurposeOf, displacementAckOf, feeItemRows, historyRows, partialCancelRows, rescheduleRow, type Report } from '../src/tools/legacy-records.js';

// Fixture rows in the shape of legacy's `sb_bookings` and its child tables
// (`operation_frontend/data-model/tables/sb_bookings.js`).
const AT = '2026-09-01T00:00:00.000Z';
function reporter() {
  const skipped: string[] = [], notes: string[] = [];
  const report: Report = { skip: (kind, id, reason) => { skipped.push(`${kind} ${id}: ${reason}`); }, note: (what) => { notes.push(what); } };
  return { report, skipped, notes };
}

test('a cancellation is carried only for a cancelled booking with a known category', () => {
  const { report, skipped, notes } = reporter();
  const legacy = {
    cancellation_category: 'flight_visa', cancellation_group: 'customer', cancellation_note: 'visa refused', cancellation_chargetype: 'partial',
    cancellation_chargeamount: 1500, cancellation_at: '2026-08-02T03:04:05.000Z', cancellation_by: 'ops1',
  };
  assert.deepEqual(cancellationRow(legacy, 'lg_b1', 'cancelled', AT, report), {
    booking_id: 'lg_b1', category: 'flight_visa', grp: 'customer', note: 'visa refused', charge_type: 'partial', charge_amount: 1500, at: '2026-08-02T03:04:05.000Z', by: 'ops1',
  });
  assert.equal(cancellationRow(legacy, 'lg_b2', 'confirmed', AT, report), undefined, 'restored since: the columns are stale');
  assert.equal(cancellationRow({ cancelreason: 'old free text' }, 'lg_b3', 'cancelled', AT, report), undefined, 'an old cancel keeps its text in cancellation_reason');
  assert.equal(cancellationRow({ cancellation_category: 'meteor' }, 'lg_b4', 'cancelled', AT, report), undefined);
  assert.equal(cancellationRow({ cancellation_category: 'sick', cancellation_chargetype: 'none', cancellation_chargeamount: 900 }, 'lg_b5', 'rejected', AT, report)?.charge_amount, 0);
  assert.deepEqual(skipped, ['cancellation lg_b4: category meteor is not a cancel category']);
  assert.deepEqual(notes, ['cancellation records dropped: booking no longer cancelled', 'cancellations without a category (reason text only)']);
});

test('the latest reschedule is one row; a rebook without one is the weather move', () => {
  const { report, skipped } = reporter();
  assert.deepEqual(rescheduleRow({
    reschedule_fromdate: '2026-10-10', reschedule_todate: '2026-10-14', reschedule_reason: 'customer request', reschedule_chargetype: 'partial',
    reschedule_chargeamount: 500, reschedule_collect: 'invoice', reschedule_at: '2026-10-01T00:00:00Z', reschedule_by: 'ops1',
    rebook_from: '2026-10-10', rebook_to: '2026-10-14', rebook_reason: 'manual',
  }, 'lg_b1', AT, report), {
    booking_id: 'lg_b1', from_date: '2026-10-10', to_date: '2026-10-14', reason: 'customer request', charge_type: 'partial', charge_amount: 500,
    collect: 'invoice', at: '2026-10-01T00:00:00.000Z', by: 'ops1',
  });
  assert.deepEqual(rescheduleRow({ rebook_from: '2026-10-10', rebook_to: '2026-10-11', rebook_reason: 'weather', rebook_at: '2026-10-09T10:00:00Z' }, 'lg_b2', AT, report), {
    booking_id: 'lg_b2', from_date: '2026-10-10', to_date: '2026-10-11', reason: 'weather', charge_type: 'none', charge_amount: 0, collect: 'none', at: '2026-10-09T10:00:00.000Z', by: null,
  });
  assert.equal(rescheduleRow({ reschedule_fromdate: '2026-10-10', reschedule_chargeamount: 0, reschedule_collect: 'invoice' }, 'lg_b3', AT, report), undefined);
  assert.equal(rescheduleRow({}, 'lg_b4', AT, report), undefined, 'never rescheduled');
  assert.deepEqual(skipped, ['reschedule lg_b3: dates 2026-10-10 → ']);
});

test('partial cancels become the pax grid on the imported trip at that position', () => {
  const { report, skipped, notes } = reporter();
  const rows = partialCancelRows([
    { idx: 0, date: '2026-10-10', tripidx: 1, paxremoved_ad_fr: 1, paxremoved_foc_th: null, count: 1, category: 'sick', group: 'customer', note: '',
      charged_count: 0, charged_amount: 0, waived_count: 1, waived_amount: 2000, at: '2026-10-02T00:00:00Z', by: 'ops1' },
    { idx: 1, date: '', tripidx: 5, paxremoved_foc_th: 2, count: 2, category: 'legacy-code', waived_count: 2, refund: 300 },
    { idx: 2, paxremoved_xx: 1 },
  ], 'lg_b1', ['trip_lg_b1_0', 'trip_lg_b1_1'], ['2026-10-09', '2026-10-10'], AT, report);
  assert.deepEqual(rows, [
    { booking_id: 'lg_b1', booking_trip_id: 'trip_lg_b1_1', service_date: '2026-10-10', pax_removed: { ad_fr: 1 }, count: 1, category: 'sick', grp: 'customer', note: null,
      charged_count: 0, charged_amount: 0, waived_count: 1, waived_amount: 2000, at: '2026-10-02T00:00:00.000Z', by: 'ops1' },
    { booking_id: 'lg_b1', booking_trip_id: null, service_date: null, pax_removed: { foc_th: 2 }, count: 2, category: 'legacy-code', grp: null, note: null,
      charged_count: 0, charged_amount: 0, waived_count: 2, waived_amount: 300, at: AT, by: null },
  ]);
  assert.deepEqual(skipped, ['partial cancel lg_b1#2: pax_removed.xx is not a passenger category']);
  assert.deepEqual(notes, ['partial cancels whose trip is gone (kept with its date)', 'partial cancels with an unknown category (kept, no group)']);
});

test('fee items and history are carried as they are', () => {
  const { report, skipped, notes } = reporter();
  assert.deepEqual(feeItemRows([
    { idx: 0, type: 'reschedule', label: 'Reschedule fee · 2026-10-10 → 2026-10-14 · storm', amount: 500, at: '2026-10-01T00:00:00Z' },
    { idx: 1, type: '', amount: 5 },
  ], 'lg_b1', AT, report), [{ booking_id: 'lg_b1', type: 'reschedule', label: 'Reschedule fee · 2026-10-10 → 2026-10-14 · storm', amount: 500, at: '2026-10-01T00:00:00.000Z' }]);
  assert.deepEqual(historyRows([
    { idx: 0, at: '2026-09-30T01:02:03.000Z', kind: 'create', tag: 'Created', text: 'Created', by: 'RM' },
    { idx: 1, at: 'not a date', kind: '', tag: '', text: 'ดึงที่นั่งจาก seat lock กลับมา 1/3 ที่', by: '' },
  ], 'lg_b1', AT, report), [
    { booking_id: 'lg_b1', at: '2026-09-30T01:02:03.000Z', by: 'RM', kind: 'create', tag: 'Created', text: 'Created' },
    { booking_id: 'lg_b1', at: AT, by: null, kind: 'note', tag: null, text: 'ดึงที่นั่งจาก seat lock กลับมา 1/3 ที่' },
  ]);
  assert.deepEqual(skipped, ['fee item lg_b1#1: no type']);
  assert.deepEqual(notes, ['history lines with no readable time (given the booking\'s)']);
});

test('a company booking\'s reason comes from legacy\'s purpose; a charter\'s displacement acknowledgement gets the booking\'s time', () => {
  assert.equal(companyPurposeOf({ purpose: 'company_special' }), 'company_special');
  assert.equal(companyPurposeOf({ purpose: 'staff_welfare' }), null, 'not a company reason');
  assert.equal(companyPurposeOf({}), null);
  assert.deepEqual(displacementAckOf({ charterdisplacementack: true }, true, AT), { charter_displaced_at: AT, charter_displaced_by: null });
  assert.deepEqual(displacementAckOf({ charterdisplacementack: false }, true, AT), { charter_displaced_at: null, charter_displaced_by: null });
  assert.deepEqual(displacementAckOf({ charterdisplacementack: true }, false, AT), { charter_displaced_at: null, charter_displaced_by: null }, 'only a charter carries one');
});

// The rows must also fit the tables, through the same `jsonb_populate_recordset` the import uses,
// and come back out of the booking read in the API's shape.
const url = process.env.DATABASE_URL;
const app = buildApp();
const pool = url ? new Pool({ connectionString: url }) : undefined;
after(async () => { await app.close(); await pool?.end(); });

test('imported records land in the tables and read back through the API', { skip: !url && 'PostgreSQL only' }, async () => {
  const date = '2037-05-01';
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: 'boat-import', route_id: 'r1', service_date: date, capacity: 20 } });
  const booking = (await app.inject({ method: 'POST', url: '/v1/bookings', payload: { route_id: 'r1', service_date: date, pax: 3 } })).json();
  // The import writes legacy's status as it is; the API only reaches `cancelled` through /cancel.
  await pool!.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [booking.id]);
  const { report } = reporter();
  // `import-legacy.ts`'s statement: only the columns the rows carry, so a serial id takes its default.
  const insert = (table: string, rows: object[]) => {
    const list = Object.keys(Object.assign({}, ...rows)).map((c) => `"${c}"`).join(', ');
    return pool!.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(rows)]);
  };
  const id = booking.id as string;
  await insert('booking_cancellations', [cancellationRow({ cancellation_category: 'no_show', cancellation_chargetype: 'full', cancellation_chargeamount: 4000 }, id, 'cancelled', AT, report)!]);
  await insert('booking_reschedules', [rescheduleRow({ rebook_from: '2037-04-30', rebook_to: date, rebook_reason: 'weather' }, id, AT, report)!]);
  await insert('booking_partial_cancels', partialCancelRows([{ idx: 0, tripidx: 0, paxremoved_ad: 1, waived_count: 1, waived_amount: 100 }], id, [booking.trips[0].id], [date], AT, report));
  await insert('booking_fee_items', feeItemRows([{ idx: 0, type: 'reschedule', amount: 250 }], id, AT, report));
  await pool!.query(`INSERT INTO booking_history (booking_id, at, by, kind, tag, text) SELECT r.booking_id, r.at, r.by, r.kind, r.tag, r.text
    FROM jsonb_populate_recordset(NULL::booking_history, $1::jsonb) r`, [JSON.stringify(historyRows([{ at: AT, kind: 'cancel', tag: 'Cancel', text: 'Cancelled · imported', by: 'RM' }], id, AT, report))]);

  const read = (await app.inject({ method: 'GET', url: `/v1/bookings/${id}` })).json();
  assert.deepEqual(read.cancellation, { category: 'no_show', group: 'customer', note: null, charge_type: 'full', charge_amount: 4000, at: AT, by: null });
  assert.equal(read.reschedules[0].reason, 'weather');
  assert.deepEqual(read.partial_cancels[0].pax_removed, { ad: 1 });
  assert.equal(read.partial_cancels[0].trip_id, booking.trips[0].id);
  assert.deepEqual(read.fee_items, [{ type: 'reschedule', label: null, amount: 250, at: AT }]);
  const history = (await app.inject({ method: 'GET', url: `/v1/bookings/${id}/history` })).json().history;
  assert.deepEqual(history[0], { at: AT, by: 'RM', kind: 'cancel', tag: 'Cancel', text: 'Cancelled · imported' }, 'oldest first: the imported line predates the API\'s own');
});
