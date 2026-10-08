import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userFromLegacy } from '../src/tools/legacy-users.js';

// Fixture rows in the shape of legacy's `operation_schemas.users`: JSON as text, `logout_after` in ms.
const HASH = '9fe873eaade5a417abacc7c31ad6e24f:18b02cb4cf0f46e5653880b7ef2bcc224db2e004aff22d85f64514253dec5a88';
const sales = new Set(['s01']);
const rsvn = {
  id: 3, username: 'RSVN01', pass_hash: HASH, name: 'Earn', role: 'staff', can_edit: true,
  edit_areas: '["overview","operations","sales"]', perms: '["dashboard","booking","act-capunlock"]',
  dept: 'rsvn', sales_id: null, logout_after: '1790000000000',
};

test('a legacy user keeps its username, password hash and rights', () => {
  const mapped = userFromLegacy(rsvn, sales);
  assert.ok('user' in mapped);
  assert.deepEqual(mapped.notes, []);
  assert.deepEqual(mapped.user, {
    username: 'RSVN01', pass_hash: HASH, name: 'Earn', role: 'staff', can_edit: true, edit_areas: ['overview', 'operations', 'sales'],
    actions: ['act-capunlock'], view_perms: ['dashboard', 'booking'], sales_id: null, agent_id: null, dept: 'rsvn',
    disabled_at: null, tokens_valid_after: new Date(1790000000000).toISOString(), legacy_id: 3,
  });
});

test('no edit list stays null (every area when can_edit), and an empty one stays empty', () => {
  const admin = userFromLegacy({ ...rsvn, role: 'admin', edit_areas: null, perms: null }, sales);
  assert.ok('user' in admin);
  assert.deepEqual([admin.user.edit_areas, admin.user.view_perms, admin.user.actions], [null, null, []]);
  const readOnly = userFromLegacy({ ...rsvn, can_edit: false, edit_areas: '[]' }, sales);
  assert.ok('user' in readOnly);
  assert.deepEqual([readOnly.user.can_edit, readOnly.user.edit_areas], [false, []]);
});

test('what does not fit is dropped and noted, never guessed', () => {
  const odd = userFromLegacy({ ...rsvn, pass_hash: 'plain', edit_areas: '["operations","marketing"]', perms: '["act-fly"]', sales_id: 's99', logout_after: null }, sales);
  assert.ok('user' in odd);
  assert.deepEqual([odd.user.pass_hash, odd.user.edit_areas, odd.user.actions, odd.user.sales_id, odd.user.tokens_valid_after], [null, ['operations'], [], null, null]);
  assert.equal(odd.notes.length, 4);
  assert.deepEqual(userFromLegacy({ ...rsvn, username: ' ' }, sales), { skip: 'no username' });
  const known = userFromLegacy({ ...rsvn, sales_id: 's01' }, sales);
  assert.ok('user' in known && known.user.sales_id === 's01');
});
