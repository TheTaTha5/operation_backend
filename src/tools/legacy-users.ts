/**
 * Legacy's `users` rows as this service's (migration 027). Pure, so `test/legacy-users.test.ts`
 * checks the mapping without a legacy database; `import-users.ts` reads the source and writes these.
 *
 * Legacy keeps `perms` (the pages to show, plus action keys such as `act-capunlock`) and
 * `edit_areas` as JSON text, `logout_after` as epoch milliseconds. The password hash moves as it is,
 * so everyone keeps their password.
 */
import { ACTIONS, AREAS, type Action, type Area, type NewUser } from '../domain/users.js';

type Row = Record<string, unknown>;
const HASH = /^[0-9a-f]{32}:[0-9a-f]{64}$/;
const str = (value: unknown): string | null => { const s = value == null ? '' : String(value).trim(); return s || null; };
const jsonList = (value: unknown): unknown[] | null => {
  if (value == null) return null;
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
};

/** The row to write, or why it cannot be; `notes` lists what was dropped on the way. */
export function userFromLegacy(row: Row, salesIds: ReadonlySet<string>): { user: NewUser; notes: string[] } | { skip: string } {
  const username = str(row.username);
  const legacyId = Number(row.id);
  if (!username) return { skip: 'no username' };
  if (!Number.isInteger(legacyId)) return { skip: 'no id' };
  const notes: string[] = [];

  const hash = str(row.pass_hash);
  if (hash && !HASH.test(hash)) notes.push('password hash not in legacy\'s format: the user cannot log in');

  const areaList = jsonList(row.edit_areas);
  const editAreas = areaList === null ? null : areaList.filter((a): a is Area => (AREAS as readonly unknown[]).includes(a));
  if (areaList && editAreas && editAreas.length < areaList.length) notes.push(`unknown edit areas dropped: ${areaList.filter((a) => !editAreas.includes(a as Area)).join(', ')}`);

  const perms = jsonList(row.perms);
  const actionKeys = (perms ?? []).filter((p): p is string => typeof p === 'string' && p.startsWith('act-'));
  const actions = actionKeys.filter((a): a is Action => (ACTIONS as readonly string[]).includes(a));
  if (actions.length < actionKeys.length) notes.push(`unknown action rights dropped: ${actionKeys.filter((a) => !actions.includes(a as Action)).join(', ')}`);
  const viewPerms = perms === null ? null : perms.filter((p): p is string => typeof p === 'string' && !p.startsWith('act-'));

  const salesId = str(row.sales_id);
  if (salesId && !salesIds.has(salesId)) notes.push(`sales_id ${salesId} is not a salesperson here: dropped`);
  const role = row.role === 'admin' ? 'admin' : 'staff';
  if (row.role !== 'admin' && row.role !== 'staff') notes.push(`role ${String(row.role)} read as staff`);
  const logoutAfter = Number(row.logout_after);

  return {
    user: {
      username, pass_hash: hash && HASH.test(hash) ? hash : null, name: str(row.name), role,
      can_edit: row.can_edit !== false, edit_areas: editAreas, actions, view_perms: viewPerms,
      sales_id: salesId && salesIds.has(salesId) ? salesId : null, agent_id: null, dept: str(row.dept),
      disabled_at: null, tokens_valid_after: row.logout_after == null || !Number.isFinite(logoutAfter) ? null : new Date(logoutAfter).toISOString(),
      legacy_id: legacyId,
    },
    notes,
  };
}
