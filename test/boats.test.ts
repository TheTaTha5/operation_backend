import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { charterCeiling, deploymentSeats } from '../src/domain/capacity.js';
import { OperationsStore } from '../src/domain/operations.js';

const app = buildApp();
after(async () => app.close());

test('a charter fills to the licence, and to capacity when there is no licence', () => {
  assert.equal(charterCeiling({ capacity: 40, license_pax: 45 }), 45, 'a charter buys the whole boat');
  assert.equal(charterCeiling({ capacity: 40 }), 40, 'no licence on file falls back to capacity');
  assert.notEqual(charterCeiling({ capacity: 40 }), 0, 'a missing licence is not a licence of zero');
});

test('the seat pool and the catalogue resolve the licence the same way', () => {
  // Both read `charterCeiling`, so a boat with no licence cannot be a ceiling of zero in one and
  // capacity in the other — the divergence that made the two stores disagree for months.
  for (const limits of [{ capacity: 40, license_pax: 45 }, { capacity: 40 }]) {
    assert.equal(deploymentSeats(limits).licensed, charterCeiling(limits));
  }
  // An override lowers the operational number, and the ceiling follows it when no licence caps it.
  assert.deepEqual(deploymentSeats({ capacity: 40, override_capacity: 30 }), { sellable: 30, licensed: 30 });
  assert.deepEqual(deploymentSeats({ capacity: 40, license_pax: 45, override_capacity: 50 }), { sellable: 45, licensed: 45 }, 'an override may not raise a boat above its registration');
});

test('the in-process catalogue lists the boats it was seeded with', async () => {
  const store = new OperationsStore();
  assert.deepEqual(store.listBoats(), [], 'empty unless seeded: with no database there is no catalogue');

  store.seedCatalogue({ boats: [{ id: 'b1', name: 'Andaman Star', type: 'catamaran', pier: 'Tap Lamu', capacity: 40, license_pax: 45, crew: 3 }] });
  assert.deepEqual(store.listBoats(), [{ id: 'b1', name: 'Andaman Star', type: 'catamaran', pier: 'Tap Lamu', capacity: 40, license_pax: 45, crew: 3 }]);

  store.listBoats()[0]!.capacity = 999;
  assert.equal(store.listBoats()[0]!.capacity, 40, 'the catalogue hands out copies, not its own rows');
});

test('GET /v1/boats returns the catalogue with a resolved charter ceiling', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/boats' });
  assert.equal(response.statusCode, 200);

  const boats = response.json().boats as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(boats), 'the catalogue is listable');

  // Empty against the in-process store, seeded against PostgreSQL. The invariants hold either way,
  // and this is the assertion that earns its keep on `DATABASE_URL=… npm test`.
  for (const boat of boats) {
    assert.equal(typeof boat.name, 'string', `${boat.id} has a name`);
    assert.equal(typeof boat.capacity, 'number', `${boat.id} has a capacity`);
    assert.ok(boat.license_pax === null || typeof boat.license_pax === 'number', `${boat.id} states its licence or explicitly has none`);
    assert.equal(boat.charter_ceiling, boat.license_pax ?? boat.capacity, `${boat.id} resolves its own ceiling`);
    assert.ok((boat.charter_ceiling as number) >= (boat.capacity as number), `${boat.id} may not sell more seats than it may carry passengers`);
  }
});
