import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boatFromLegacy } from '../src/tools/legacy-boats.js';

// Fixture rows in the shape of legacy's `operation_schemas.boats`, where numbers arrive as text.
const owned = { id: 'b13', name: 'Oceanus', type: 'Speedboat', pier: 'panwa', cap: '38', licensepax: '45', crew: '3', totalcap: '48' };
const charter = { id: 'b1787980378216', name: 'LKC66', type: 'Catamaran', pier: 'panwa', cap: '40', licensepax: '', crew: '', totalcap: '' };

test('a licensed boat keeps capacity and licence apart, and totalcap is never read', () => {
  assert.deepEqual(boatFromLegacy(owned), { id: 'b13', name: 'Oceanus', type: 'Speedboat', pier: 'panwa', capacity: 38, license_pax: 45, crew: 3 });
  assert.deepEqual(boatFromLegacy({ ...owned, totalcap: '999' }), boatFromLegacy(owned), 'persons aboard is not a selling ceiling');
});

test('a boat with no licence on file has a null licence, not zero', () => {
  assert.deepEqual(boatFromLegacy(charter), { id: 'b1787980378216', name: 'LKC66', type: 'Catamaran', pier: 'panwa', capacity: 40, license_pax: null, crew: null });
  assert.equal((boatFromLegacy({ ...charter, licensepax: '0' }) as { license_pax: number | null }).license_pax, null, 'a licence of 0 means none on file');
});

test('a row that breaks a capacity rule is skipped with the reason, never clamped', () => {
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '50' }), { skip: 'capacity 50 exceeds licence 45' });
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '' }), { skip: 'capacity "" is not a positive whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '0' }), { skip: 'capacity "0" is not a positive whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '38.5' }), { skip: 'capacity "38.5" is not a positive whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, licensepax: 'n/a' }), { skip: 'licence "n/a" is not a whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, crew: '-1' }), { skip: 'crew "-1" is not a whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, name: ' ' }), { skip: 'no name' });
});
