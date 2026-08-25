import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';

const app = buildApp();
after(async () => app.close());

test('source booking payload is normalized while retaining its booking data', async () => {
  const date = '2030-02-03';
  await app.inject({ method: 'POST', url: '/operations/deployments', payload: { boat_id: 'boat-source', route_id: 'r-source', service_date: date, capacity: 20 } });
  const response = await app.inject({
    method: 'POST', url: '/v1/bookings', payload: {
      id: 'BK-source-1', agentId: 'a_b2c', voucherRef: '007592',
      trips: [{ routeId: 'r-source', date, bookingMode: 'charter', pax: { ad_fr: 10, inf_fr: 1, foc_fr: 2 } }],
      passengers: [{ name: 'Example passenger' }],
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().pax_breakdown, { ad_fr: 10, inf_fr: 1, foc_fr: 2 });
  assert.equal(response.json().pax, 13);
  assert.equal(response.json().external_id, 'BK-source-1');
  assert.equal(response.json().booking_mode, 'charter');
  assert.equal(response.json().booking_data.passengers[0].name, 'Example passenger');
});
