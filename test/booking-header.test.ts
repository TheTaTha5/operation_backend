import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import {
  BOOKING_HEADER_COLUMNS, bookingHeader, bookingHeaderPatch, mappedHeaderColumns,
} from '../src/domain/booking-header.js';

const app = buildApp();
after(async () => app.close());

test('the frontend document is read into header columns', () => {
  const header = bookingHeader({
    schemaVer: 2,
    leadPax: 'Somchai R.', leadNationality: 'TH', leadType: 'AD', leadFoc: false,
    leadPhone: '0812345678', leadEmail: 'lead@example.com',
    pickupAreaId: 'pa_patong', pickupSelf: false, pickupArea: 'Patong', pickupZone: 'PK',
    hotelName: 'Example Resort', roomNumber: '1204',
    guides: { english: true, russian: false, chinese: false, otherLang: 'German' },
    specialMeals: { veg: 2, vegan: 0, halal: 1, allergies: 'peanuts' },
    cashOnTour: { amount: 1500, currency: 'THB', handling: 'deduct', note: 'pay at pier' },
    priceBreakdown: { seat: 12000, addOn: 800, focDiscount: -500, discount: -200, extra: 0, total: 12100 },
    paymentSnapshot: { method: 'credit', netDays: 30, source: 'contract', contractVersion: 'v3' },
    marketSnapshot: { market: 'EU', sub: 'DE', agentId: 'a_de', at: '2026-09-01' },
    priceMode: 'rate', total: 12100, soldBy: 'RM', purpose: 'sale',
    notes: 'window seats', note: '',
  });

  assert.equal(header.schema_ver, 2);
  assert.equal(header.lead_pax, 'Somchai R.');
  assert.equal(header.lead_foc, false, 'an explicit false is a value, not an absence');
  assert.equal(header.pickup_zone, 'PK');
  assert.equal(header.guide_english, true, 'a fixed-size struct is flattened into columns');
  assert.equal(header.guide_other_lang, 'German');
  assert.equal(header.special_meals_halal, 1);
  assert.equal(header.cash_on_tour_amount, 1500);
  assert.equal(header.price_foc_discount, -500);
  assert.equal(header.payment_net_days, 30);
  assert.equal(header.market_sub, 'DE');
  assert.equal(header.market_at, '2026-09-01');
  assert.equal(header.total, 12100);
  assert.equal(header.notes, 'window seats');
});

test('an absent field stays absent, so omitting it cannot blank a column', () => {
  const header = bookingHeader({ leadPax: 'Only this' });
  assert.equal(header.lead_pax, 'Only this');
  assert.equal('hotel_name' in header, false, 'a key the document never carried must not appear at all');
  // An empty string is how the frontend writes "not filled in" for most of these, and storing it
  // would make "" and NULL two spellings of the same thing.
  assert.equal('note' in bookingHeader({ note: '   ' }), false);
});

test('our own snake_case is accepted beside the frontend camelCase', () => {
  const camel = bookingHeader({ leadPax: 'A', pickupAreaId: 'pa_1', largeLuggage: 3 });
  const snake = bookingHeader({ lead_pax: 'A', pickup_area_id: 'pa_1', large_luggage: 3 });
  assert.deepEqual(camel, snake);
});

test('a DATE column takes the day from the string, never through a Date', () => {
  // `new Date('2026-01-04T00:30:00+07:00').toISOString().slice(0,10)` is 2026-01-03 — the off-by-one
  // the date convention in CLAUDE.md exists to prevent.
  assert.equal(bookingHeader({ bookingDate: '2026-01-04T00:30:00+07:00' }).booking_date, '2026-01-04');
  assert.equal(bookingHeader({ bookingDate: '2026-01-04' }).booking_date, '2026-01-04');
  assert.equal('booking_date' in bookingHeader({ bookingDate: 'Sat Jul 04' }), false, 'a stringified JS Date is not a date');
});

test('unrecognised fields are dropped rather than kept in an overflow column', () => {
  const header = bookingHeader({ leadPax: 'A', somethingNobodyModelled: 'x', docCheck: { openId: 1 } });
  assert.deepEqual(Object.keys(header), ['lead_pax']);
});

test('a booking round-trips its header through storage', async () => {
  const date = '2030-06-11';
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: 'boat-header', route_id: 'r6', service_date: date, capacity: 20 } });
  const created = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      id: 'BK-header-1', agentId: 'a_b2c', voucherRef: 'V-1',
      leadPax: 'Somchai R.', leadPhone: '0812345678', leadFoc: false,
      pickupAreaId: 'pa_patong', pickupArea: 'Patong', pickupZone: 'PK', hotelName: 'Example Resort',
      guides: { english: true, russian: false, chinese: false, otherLang: 'German' },
      specialMeals: { veg: 2, vegan: 0, halal: 1, allergies: 'peanuts' },
      priceBreakdown: { seat: 12000, addOn: 800, focDiscount: -500, discount: -200, extra: 0 },
      paymentSnapshot: { method: 'credit', netDays: 30, source: 'contract', contractVersion: 'v3' },
      marketSnapshot: { market: 'EU', sub: 'DE', agentId: 'a_de', at: '2026-09-01' },
      bookingDate: '2026-09-01', total: 12100, priceMode: 'rate', createdBy: 'RM',
      trips: [{ routeId: 'r6', date, pax: { ad_fr: 4 } }],
    },
  });
  assert.equal(created.statusCode, 201);
  const booking = created.json();

  assert.equal(booking.lead_pax, 'Somchai R.');
  assert.equal(booking.lead_foc, false);
  assert.equal(booking.pickup_area, 'Patong');
  assert.equal(booking.guide_english, true);
  assert.equal(booking.guide_other_lang, 'German');
  assert.equal(booking.special_meals_veg, 2);
  assert.equal(booking.payment_net_days, 30);
  assert.equal(booking.market_at, '2026-09-01', 'a DATE comes back as a plain ISO day, not a stringified Date');
  assert.equal(booking.booking_date, '2026-09-01');
  assert.equal(booking.created_by, 'RM');

  // NUMERIC is handed back by `pg` as a string. Unconverted, `total` would be 12100 for the
  // in-process store and "12100.00" for PostgreSQL — exactly the shape of divergence that kept the
  // seat-lock date bug alive, and invisible unless the suite runs against both.
  assert.equal(booking.total, 12100);
  assert.equal(typeof booking.total, 'number');
  assert.equal(booking.price_foc_discount, -500);
  assert.equal(typeof booking.price_seat, 'number');

  const fetched = await app.inject({ method: 'GET', url: `/v1/bookings/${booking.id}` });
  assert.equal(fetched.statusCode, 200);
  assert.deepEqual(
    { lead: fetched.json().lead_pax, total: fetched.json().total, date: fetched.json().booking_date },
    { lead: 'Somchai R.', total: 12100, date: '2026-09-01' },
    'reading a booking back returns the same header as creating it did',
  );
});

test('a header field the caller omits is absent rather than null', async () => {
  const date = '2030-06-12';
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: 'boat-header-2', route_id: 'r6', service_date: date, capacity: 20 } });
  const created = await app.inject({
    method: 'POST', url: '/v1/bookings',
    payload: { agentId: 'a_b2c', trips: [{ routeId: 'r6', date, pax: { ad: 2 } }] },
  });
  assert.equal(created.statusCode, 201);
  const booking = created.json();
  assert.equal('lead_pax' in booking, false);
  assert.equal('total' in booking, false);
});

test('every column is reachable from the document, and nothing maps to a column that is gone', () => {
  // The mapping table and the column list are read by different code — the table by the route
  // handler, the list by the SQL store — so a column added to one and forgotten in the other is a
  // field that stores but never arrives, or arrives but is never written.
  assert.deepEqual([...mappedHeaderColumns()].sort(), [...BOOKING_HEADER_COLUMNS].sort());
});

test('an amendment carries only the columns the document mentions', () => {
  const patch = bookingHeaderPatch({ leadPhone: '0899999999', guides: { english: true } });
  assert.deepEqual(patch, { lead_phone: '0899999999', guide_english: true },
    'a field the caller is silent about is absent, not null: PATCH merges');
});

test('a mentioned field with no value is a request to clear it', () => {
  assert.deepEqual(bookingHeaderPatch({ notes: null }), { notes: null }, 'an explicit null clears');
  assert.deepEqual(bookingHeaderPatch({ notes: '' }), { notes: null }, 'so does the empty string a form sends');
  assert.deepEqual(bookingHeaderPatch({ notes: '   ' }), { notes: null }, 'whitespace is not a value');
  assert.deepEqual(bookingHeaderPatch({ total: null }), { total: null });
  assert.deepEqual(bookingHeaderPatch({ leadFoc: false }), { lead_foc: false }, 'false is a value, not a clear');
  assert.deepEqual(bookingHeaderPatch({ specialMeals: { veg: 0 } }), { special_meals_veg: 0 }, 'nor is zero');
});

test('creating cannot clear, since there is nothing there yet to clear', () => {
  assert.deepEqual(bookingHeader({ notes: null, leadPax: 'Somchai R.' }), { lead_pax: 'Somchai R.' });
});

/** A booking with a header, on a departure with room to grow, for the amendment tests below. */
async function booked(date: string, capacity: number, payload: Record<string, unknown> = {}) {
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: `boat-${date}`, route_id: 'r6', service_date: date, capacity } });
  const created = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      leadPax: 'Somchai R.', leadPhone: '0812345678', hotelName: 'Example Resort',
      notes: 'window seats', total: 12100, bookingDate: '2026-09-01',
      trips: [{ routeId: 'r6', date, pax: { ad: 4 } }], ...payload,
    },
  });
  assert.equal(created.statusCode, 201);
  return created.json();
}

test('amending a header field changes it and leaves the rest of the header alone', async () => {
  const booking = await booked('2030-08-01', 30);
  const patched = await app.inject({
    method: 'PATCH', url: `/v1/bookings/${booking.id}`,
    payload: { leadPhone: '0899999999', total: 15400 },
  });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual(
    { phone: patched.json().lead_phone, total: patched.json().total, hotel: patched.json().hotel_name, notes: patched.json().notes },
    { phone: '0899999999', total: 15400, hotel: 'Example Resort', notes: 'window seats' },
    'the two mentioned fields moved; the two unmentioned ones did not',
  );

  const fetched = await app.inject({ method: 'GET', url: `/v1/bookings/${booking.id}` });
  assert.equal(fetched.json().lead_phone, '0899999999', 'and the change is in storage, not just the response');
  assert.equal(typeof fetched.json().total, 'number');
});

test('amending clears a field when the caller says to, and only then', async () => {
  const booking = await booked('2030-08-02', 30);
  const patched = await app.inject({ method: 'PATCH', url: `/v1/bookings/${booking.id}`, payload: { notes: '' } });
  assert.equal(patched.statusCode, 200);
  assert.equal('notes' in patched.json(), false, 'a cleared field is absent, the same as one never given');
  assert.equal(patched.json().lead_pax, 'Somchai R.', 'clearing one field does not blank the others');
});

test('a header travels with an itinerary change in the same call', async () => {
  const booking = await booked('2030-08-03', 30);
  const patched = await app.inject({
    method: 'PATCH', url: `/v1/bookings/${booking.id}`,
    payload: { pax: 6, total: 18150, leadPhone: '0899999999' },
  });
  assert.equal(patched.statusCode, 200);
  assert.deepEqual(
    { pax: patched.json().pax, total: patched.json().total, phone: patched.json().lead_phone },
    { pax: 6, total: 18150, phone: '0899999999' },
    'the money can be corrected in the same breath as the seats it is the price of',
  );
});

test('an amendment refused for capacity leaves the header as it was', async () => {
  // The header is applied after the capacity check for this reason: a 409 must not half-land.
  const booking = await booked('2030-08-04', 6);
  const refused = await app.inject({
    method: 'PATCH', url: `/v1/bookings/${booking.id}`,
    payload: { pax: 99, leadPhone: '0899999999' },
  });
  assert.equal(refused.statusCode, 409);
  const fetched = await app.inject({ method: 'GET', url: `/v1/bookings/${booking.id}` });
  assert.deepEqual(
    { phone: fetched.json().lead_phone, pax: fetched.json().pax },
    { phone: '0812345678', pax: 4 },
    'neither the seats nor the phone number moved',
  );
});

test('a booking keeps its header through the amendments that do not mention it', async () => {
  const booking = await booked('2030-08-05', 30);
  await app.inject({ method: 'PATCH', url: `/v1/bookings/${booking.id}`, payload: { status: 'pending_approval' } });
  const rescheduled = await app.inject({
    method: 'POST', url: `/v1/bookings/${booking.id}/reschedule`,
    payload: { route_id: 'r6', service_date: '2030-08-05' },
  });
  assert.equal(rescheduled.statusCode, 200);
  assert.deepEqual(
    { lead: rescheduled.json().lead_pax, hotel: rescheduled.json().hotel_name, date: rescheduled.json().booking_date },
    { lead: 'Somchai R.', hotel: 'Example Resort', date: '2026-09-01' },
  );
});
