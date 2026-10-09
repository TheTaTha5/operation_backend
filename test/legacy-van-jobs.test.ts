import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupOrders, jobNotes, sentMarks, thaiNames, type ImportedGroup } from '../src/tools/legacy-van-jobs.js';

// Fixture rows in the shape of legacy's `vanjob_*` tables and `app_meta`, values JSON-encoded in text.
const counted = () => { const notes: string[] = []; return { notes, note: (what: string) => notes.push(what) }; };
const groups: ImportedGroup[] = [
  { id: 'lg_vgrp_2026-10-06_r10_1', day: '2026-10-06', route: 'r10', zone: 'PK', legacyNumber: 1, van: 'veh17' },
  { id: 'lg_vgrp_2026-10-06_r10_2', day: '2026-10-06', route: 'r10', zone: 'PK', legacyNumber: 2, van: 'veh02' },
  { id: 'lg_vgrp_2026-10-06_r10_3', day: '2026-10-06', route: 'r10', zone: 'PK', legacyNumber: 3, van: 'veh02' },
];

test('a sent mark lands on its job: the van\'s one group, else its return-only run', () => {
  const { notes, note } = counted();
  const marks = sentMarks([
    { key: '2026-10-06::veh17~r10', value: '"2026-10-05T11:16:19.776Z"' },
    { key: '2026-10-06::veh02~r10', value: '"2026-10-05T11:00:00.000Z"' },
    { key: '2026-10-06::veh02~r10~3', value: '"2026-10-05T12:00:00.000Z"' },
    { key: '2026-10-06::veh09~r10', value: '"2026-10-05T13:00:00.000Z"' },
    { key: '2026-10-06::veh44~r10', value: '"2026-10-05T13:00:00.000Z"' },
    { key: 'nonsense', value: '"x"' },
  ], groups, new Set(['2026-10-06|r10|veh09']), note);
  assert.deepEqual(marks.map((m) => [m.group_id, m.van_id, m.sent_at, m.fingerprint]), [
    ['lg_vgrp_2026-10-06_r10_1', null, '2026-10-05T11:16:19.776Z', null],
    ['lg_vgrp_2026-10-06_r10_3', null, '2026-10-05T12:00:00.000Z', null],
    [null, 'veh09', '2026-10-05T13:00:00.000Z', null],
  ]);
  assert.deepEqual(notes.sort(), [
    'sent marks dropped: bad key or no time', 'sent marks dropped: no imported job for that van, programme and day',
    'sent marks dropped: the van now runs that programme more than once that day (legacy shows it unsent)', 'sent marks on a van that only brings people back',
  ]);
});

test('special requests keep a blanked override; Thai names fold by case and keep the first', () => {
  assert.deepEqual([...jobNotes([{ key: 'BK-1', value: '""' }, { key: 'BK-2', value: '"ไม่ต้องส่งกลับ "' }])], [['BK-1', ''], ['BK-2', 'ไม่ต้องส่งกลับ']]);
  const { notes, note } = counted();
  assert.deepEqual(thaiNames([
    { key: 'Book a Bed Poshtel', value: 'บุค อะ เบด โพสเทล' }, { key: 'Book A Bed Poshtel', value: 'บุค อะ เบด โพสเทล' }, { key: ' ', value: 'x' },
  ], note), [{ name_key: 'book a bed poshtel', name: 'Book A Bed Poshtel', name_th: 'บุค อะ เบด โพสเทล' }]);
  assert.deepEqual(notes, ['Thai pickup names dropped: no name or no Thai', 'Thai pickup names folded into one typed in another case']);
});

test('the group order (a JSON string in app_meta) gives each imported group its place', () => {
  const { notes, note } = counted();
  const of = (day: string, route: string, zone: string, n: number) => groups.find((g) => g.day === day && g.route === route && g.zone === zone && g.legacyNumber === n)?.id;
  const order = groupOrders(JSON.stringify(JSON.stringify({ '2026-10-06::r10::PK': [3, 9, 1] })), of, note);
  assert.deepEqual([...order], [['lg_vgrp_2026-10-06_r10_3', 1], ['lg_vgrp_2026-10-06_r10_1', 2]]);
  assert.deepEqual(notes, ['group order entries dropped: no imported group']);
});
