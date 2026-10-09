import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boatFromLegacy, type LegacyBoat } from '../src/tools/legacy-boats.js';

// Fixture rows in the shape of legacy's `operation_schemas.boats`, where numbers arrive as text.
const owned = { id: 'b13', name: 'Oceanus', type: 'Speedboat', pier: 'panwa', cap: '38', licensepax: '45', crew: '3', totalcap: '48' };
const charter = { id: 'b1787980378216', name: 'LKC66', type: 'Catamaran', pier: 'panwa', cap: '40', licensepax: '', crew: '', totalcap: '', ownership: 'charter' };
const boat = (row: Record<string, unknown>, docs: Record<string, unknown>[] = [], log: Record<string, unknown>[] = []) => (boatFromLegacy(row, docs, log) as LegacyBoat).boat;

test('a licensed boat keeps capacity and licence apart; totalcap is persons aboard, never a selling limit', () => {
  const b = boat(owned);
  assert.deepEqual([b.id, b.name, b.type, b.pier, b.capacity, b.license_pax, b.crew, b.ownership], ['b13', 'Oceanus', 'Speedboat', 'panwa', 38, 45, 3, 'own']);
  assert.equal(b.registered_persons, 48, 'totalcap is kept as the registration figure');
  assert.equal(boat({ ...owned, totalcap: '999' }).capacity, 38, 'and never read as seats');
});

test('a boat with no licence on file has a null licence, not zero', () => {
  const b = boat(charter);
  assert.deepEqual([b.capacity, b.license_pax, b.crew, b.registered_persons, b.ownership], [40, null, null, null, 'charter']);
  assert.equal(boat({ ...charter, licensepax: '0' }).license_pax, null, 'a licence of 0 means none on file');
});

test('capacity above the licence is accepted, as legacy accepts it (2026-10-09)', () => {
  assert.deepEqual([boat({ ...owned, cap: '50' }).capacity, boat({ ...owned, cap: '50' }).license_pax], [50, 45]);
});

test('a row with no usable capacity, licence, crew or name is skipped with the reason, never guessed', () => {
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '' }), { skip: 'capacity "" is not a positive whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '0' }), { skip: 'capacity "0" is not a positive whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, cap: '38.5' }), { skip: 'capacity "38.5" is not a positive whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, licensepax: 'n/a' }), { skip: 'licence "n/a" is not a whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, crew: '-1' }), { skip: 'crew "-1" is not a whole number' });
  assert.deepEqual(boatFromLegacy({ ...owned, name: ' ' }), { skip: 'no name' });
});

test('the form\'s other fields, documents and the status log come along; repeated entry ids are made unique', () => {
  const row = { ...owned, nameth: 'โอเชียนัส', use: 'บรรทุกคนโดยสาร (เร็ว)', year: '2015', homeportcity: 'ภูเก็ต', owneraddr: '9/244', gt: 19.73, dwt: '', draft: 'n/a', enginecount: 3, color: '#000000', retired: null };
  const docs = [{ idx: 1, name: 'ใบอนุญาต สิมิลัน', exp: '2026-05-26', renewstatus: 'done' }, { idx: 0, name: 'ใบอนุญาตใช้เรือ', exp: '2027-03-09', renewstatus: '' }, { idx: 2, name: '', exp: '' }];
  const log = [
    { idx: 0, id: 'sl1', s: 'available', from: '2026-04-01', to: '2026-05-15', loc: 'Visit Panwa' },
    { idx: 1, id: 'sl1', s: 'fixing', from: '2026-05-16', to: '', note: 'Maintenance Job MJ-038', projectid: '' },
    { idx: 2, id: 'sl2', s: 'broken', from: '2026-06-01', to: '' },
  ];
  const { boat: b, notes } = boatFromLegacy(row, docs, log) as LegacyBoat;
  assert.deepEqual([b.name_th, b.vessel_use, b.build_year, b.homeport_city, b.owner_addr, b.gt, b.dwt, b.draft, b.engine_count, b.color, b.retired],
    ['โอเชียนัส', 'บรรทุกคนโดยสาร (เร็ว)', '2015', 'ภูเก็ต', '9/244', 19.73, null, null, 3, '#000000', false]);
  assert.deepEqual(b.documents, [{ name: 'ใบอนุญาตใช้เรือ', expires_on: '2027-03-09', renew_status: null }, { name: 'ใบอนุญาต สิมิลัน', expires_on: '2026-05-26', renew_status: 'done' }]);
  assert.deepEqual(b.status_log.map((e) => [e.id, e.status, e.from_date, e.to_date]), [['sl1', 'available', '2026-04-01', '2026-05-15'], ['sl1-2', 'fixing', '2026-05-16', null]]);
  assert.ok(notes.some((n) => /sl1 repeats/.test(n)) && notes.some((n) => /status "broken"/.test(n)) && notes.some((n) => /no name/.test(n)));
});
