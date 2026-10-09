/**
 * Staff logins and what each may do (todo/login-permissions-model.md, migration 027). Pure, so both
 * stores and the routes decide identically.
 *
 * Copied from legacy's `server.js`: the password hash (`hashPw`/`verifyPw`), and which areas a user
 * may edit (`editInfo`). What legacy checked only in the browser is checked here on every write.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { refuse } from './booking-actions.js';
import type { BookingApproval } from './booking-approvals.js';

export const AREAS = ['overview', 'operations', 'sales', 'accounting', 'fleet', 'pier', 'config'] as const;
export type Area = typeof AREAS[number];
/** `act-approve` is new here; `act-capunlock` and `act-tmpl` are legacy's, kept for its screens. */
export const ACTIONS = ['act-approve', 'act-capunlock', 'act-tmpl'] as const;
export type Action = typeof ACTIONS[number];
export type Role = 'admin' | 'staff';

export type StoredUser = {
  id: number; username: string; pass_hash: string | null; name: string | null; role: Role;
  can_edit: boolean; edit_areas: Area[] | null; actions: Action[]; view_perms: string[] | null;
  sales_id: string | null; agent_id: string | null; dept: string | null;
  disabled_at: string | null; tokens_valid_after: string | null; legacy_id: number | null;
  created_at: string; updated_at: string;
};
/** A user as the API shows it: never the hash. */
export type UserView = Omit<StoredUser, 'pass_hash' | 'tokens_valid_after'> & { can_edit_any: boolean; has_password: boolean };
export type NewUser = Omit<StoredUser, 'id' | 'created_at' | 'updated_at'>;
export type UserPatch = Partial<Pick<StoredUser, 'name' | 'role' | 'can_edit' | 'edit_areas' | 'actions' | 'view_perms' | 'sales_id' | 'agent_id' | 'dept' | 'disabled_at' | 'tokens_valid_after' | 'pass_hash'>>;

// ── Passwords: legacy's scrypt, so its hashes verify as they are ──

/** `salt:key` in hex, as legacy's `hashPw`: a 16-byte salt, scrypt's defaults, a 32-byte key. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

/** Legacy's `verifyPw`. False for a missing or malformed hash, never a throw. */
export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Rights ──

/**
 * Legacy's `editInfo`: a list of areas decides, and `can_edit` is read only when there is no list,
 * where it means every area. An admin edits everything.
 */
export function mayEdit(user: Pick<StoredUser, 'role' | 'can_edit' | 'edit_areas'>, area: Area): boolean {
  if (user.role === 'admin') return true;
  return user.edit_areas ? user.edit_areas.includes(area) : user.can_edit;
}
export const canEditAny = (user: Pick<StoredUser, 'role' | 'can_edit' | 'edit_areas'>): boolean =>
  user.role === 'admin' || (user.edit_areas ? user.edit_areas.length > 0 : user.can_edit);

export const userView = ({ pass_hash, tokens_valid_after: _t, ...user }: StoredUser): UserView =>
  ({ ...user, can_edit_any: canEditAny(user), has_password: pass_hash !== null });

/**
 * What a write needs. `admin` is the user screens; `self` is any logged-in user acting on their own
 * login; otherwise the areas any of which allows it, as legacy assigns them. A write this does not
 * know is admin-only, so a new endpoint is closed until it is given an area.
 */
export type WriteNeed = { kind: 'admin' } | { kind: 'self' } | { kind: 'area'; areas: Area[] };
export function writeNeed(path: string): WriteNeed {
  // A quote saves nothing: any login may ask for one (a login tied to an agent, for its own agent).
  if (path === '/v1/logout' || path === '/v1/me/password' || path === '/v1/quote') return { kind: 'self' };
  if (path === '/v1/users' || path.startsWith('/v1/users/')) return { kind: 'admin' };
  // The document check's note: legacy lets anyone edit it (decision C3, 2026-10-09).
  if (/^\/v1\/bookings\/[^/]+\/doc-check\/note$/.test(path)) return { kind: 'self' };
  if (path === '/v1/bookings' || path.startsWith('/v1/bookings/') || path.startsWith('/v1/seat-locks')) return { kind: 'area', areas: ['operations'] };
  // Files: booking documents (operations), pier and payment slips (pier, accounting); legacy let any editor upload.
  if (path === '/v1/attachments' || path.startsWith('/v1/attachments/')) return { kind: 'area', areas: ['operations', 'pier', 'accounting'] };
  // Legacy's "Pickup time setup" (psuPersist guards operations).
  if (path.startsWith('/v1/pickup-areas') || path.startsWith('/v1/pickup-time-profiles')) return { kind: 'area', areas: ['operations'] };
  // Legacy's Re-confirm page sends the agent's list.
  if (path === '/v1/reconfirm/sent') return { kind: 'area', areas: ['operations'] };
  // Legacy assigns boats from "Boat Operation" (operations) and "Fleet Deployment" (fleet).
  if (path.startsWith('/operations/deployments')) return { kind: 'area', areas: ['operations', 'fleet'] };
  // Dispatch: which boat and van a trip goes on, its final pickup, the pier note.
  // Check-in: legacy `ckCanEdit` lets the pier staff in too.
  if (/^\/operations\/trip-ops\/[^/]+\/checkins\//.test(path)) return { kind: 'area', areas: ['operations', 'pier'] };
  if (path.startsWith('/operations/trip-ops/')) return { kind: 'area', areas: ['operations'] };
  // Legacy's Vans page and month matrix are guarded by "operations" (`laGuardEdit('operations')`).
  if (path.startsWith('/operations/vans') || path.startsWith('/operations/van-')) return { kind: 'area', areas: ['operations'] };
  if (path.startsWith('/v1/rate-types') || path.startsWith('/v1/agents')) return { kind: 'area', areas: ['sales'] };
  if (path.startsWith('/v1/routes/')) return { kind: 'area', areas: ['config'] };
  // Legacy's accounting (`laCanEditArea('accounting')`): invoices, their discounts and payments.
  if (path === '/v1/invoices' || path.startsWith('/v1/invoices/')) return { kind: 'area', areas: ['accounting'] };
  return { kind: 'admin' };
}

/** Throws `403` naming what is missing, unless `user` may make a write to `path`. */
export function assertMayWrite(user: StoredUser, path: string): void {
  const need = writeNeed(path);
  if (need.kind === 'self') return;
  // A login tied to one agent books for it and does nothing else (Love Kingdom's service user).
  if (user.agent_id !== null && !(path === '/v1/bookings' || path.startsWith('/v1/bookings/'))) {
    refuse(`This login books for agent ${user.agent_id} and may change nothing else`, 403, 'forbidden');
  }
  if (need.kind === 'admin') {
    if (user.role !== 'admin') refuse('Only an admin may do this', 403, 'forbidden');
    return;
  }
  if (!need.areas.some((area) => mayEdit(user, area))) {
    refuse(`Needs the ${need.areas.join(' or ')} area`, 403, 'forbidden');
  }
}

/**
 * Who may approve or reject what a booking waits for (decided 2026-10-08):
 * - over the allotment, and FOC passengers: `admin` or `act-approve`;
 * - a discount: the agent's salesperson or `admin`.
 * An approval carrying both needs both. A waiting booking with no approval record (legacy's) is
 * treated as over the allotment.
 */
export function assertMayDecide(user: StoredUser, approval: BookingApproval | undefined, agentSalesId: string | null): void {
  if (user.role === 'admin') return;
  const approver = user.actions.includes('act-approve');
  const over = !approval || approval.kind === 'foc' || approval.over_capacity;
  const discount = approval?.kind === 'approval' && (approval.discount ?? 0) > 0;
  if (over && !approver) {
    refuse(approval?.kind === 'foc' ? 'Approving FOC passengers needs an admin or the act-approve right' : 'Approving over the allotment needs an admin or the act-approve right', 403, 'forbidden');
  }
  if (discount && (user.sales_id === null || user.sales_id !== agentSalesId)) {
    refuse('A discount is approved by the agent\'s salesperson or an admin', 403, 'forbidden');
  }
}

export const usernameTaken = (username: string): never => refuse(`Username ${username} is taken`, 409, 'username_taken');

// ── Requests ──

const bad = (message: string): never => refuse(message, 400);
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value.trim() || null : bad(`${name} must be a string`);
};
const strings = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) bad(`${name} must be a list of strings`);
  return [...new Set(value as string[])];
};
const areas = (value: unknown): Area[] | null => {
  if (value === null) return null;
  const list = strings(value, 'edit_areas');
  const unknown = list.filter((area) => !(AREAS as readonly string[]).includes(area));
  if (unknown.length) bad(`edit_areas has unknown areas: ${unknown.join(', ')} (known: ${AREAS.join(', ')})`);
  return list as Area[];
};
const actions = (value: unknown): Action[] => {
  const list = strings(value, 'actions');
  const unknown = list.filter((action) => !(ACTIONS as readonly string[]).includes(action));
  if (unknown.length) bad(`actions has unknown rights: ${unknown.join(', ')} (known: ${ACTIONS.join(', ')})`);
  return list as Action[];
};
const role = (value: unknown): Role => (value === 'admin' || value === 'staff' ? value : bad('role must be admin or staff'));

/** A password this service accepts: legacy sets no rule, so only that it is not blank. */
export const password = (value: unknown, name = 'password'): string =>
  typeof value === 'string' && value.length > 0 ? value : bad(`${name} is required`);

const SERVER_OWNED: Record<string, string> = {
  password: 'POST /v1/users/{id}/password', pass_hash: 'POST /v1/users/{id}/password', username: 'nothing: a username is permanent',
  id: 'nothing', legacy_id: 'nothing', created_at: 'nothing', updated_at: 'nothing', disabled_at: '`disabled`', tokens_valid_after: 'POST /v1/logout',
};

/** `POST /v1/users`. Legacy's `editAreas`/`canEdit`/`salesId` spellings are accepted too. */
export function parseNewUser(body: Record<string, unknown>): Omit<NewUser, 'pass_hash'> & { password: string } {
  const username = text(body.username, 'username') ?? bad('username is required');
  const canEdit = body.can_edit ?? body.canEdit ?? true;
  if (typeof canEdit !== 'boolean') bad('can_edit must be true or false');
  return {
    username, password: password(body.password), name: text(body.name, 'name') ?? username,
    role: body.role === undefined ? 'staff' : role(body.role),
    can_edit: canEdit as boolean,
    edit_areas: (body.edit_areas ?? body.editAreas) === undefined ? null : areas(body.edit_areas ?? body.editAreas),
    actions: body.actions === undefined ? [] : actions(body.actions),
    view_perms: (body.view_perms ?? body.perms) == null ? null : strings(body.view_perms ?? body.perms, 'view_perms'),
    sales_id: text(body.sales_id ?? body.salesId, 'sales_id'), agent_id: text(body.agent_id ?? body.agentId, 'agent_id'),
    dept: text(body.dept, 'dept'), disabled_at: null, tokens_valid_after: null, legacy_id: null,
  };
}

/** `PATCH /v1/users/{id}`: client facts only; anything else is refused naming what to use. */
export function parseUserPatch(body: Record<string, unknown>, now: string): UserPatch {
  for (const key of Object.keys(body)) if (key in SERVER_OWNED) bad(`${key} cannot be changed here; use ${SERVER_OWNED[key]}`);
  const patch: UserPatch = {};
  if (body.name !== undefined) patch.name = text(body.name, 'name');
  if (body.role !== undefined) patch.role = role(body.role);
  const canEdit = body.can_edit ?? body.canEdit;
  if (canEdit !== undefined) patch.can_edit = typeof canEdit === 'boolean' ? canEdit : bad('can_edit must be true or false');
  const editAreas = body.edit_areas !== undefined ? body.edit_areas : body.editAreas;
  if (editAreas !== undefined) patch.edit_areas = areas(editAreas);
  if (body.actions !== undefined) patch.actions = actions(body.actions);
  const view = body.view_perms !== undefined ? body.view_perms : body.perms;
  if (view !== undefined) patch.view_perms = view === null ? null : strings(view, 'view_perms');
  const sales = body.sales_id !== undefined ? body.sales_id : body.salesId;
  if (sales !== undefined) patch.sales_id = text(sales, 'sales_id');
  const agent = body.agent_id !== undefined ? body.agent_id : body.agentId;
  if (agent !== undefined) patch.agent_id = text(agent, 'agent_id');
  if (body.dept !== undefined) patch.dept = text(body.dept, 'dept');
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== 'boolean') bad('disabled must be true or false');
    // Disabling ends the user's sessions too.
    Object.assign(patch, body.disabled ? { disabled_at: now, tokens_valid_after: now } : { disabled_at: null });
  }
  return patch;
}
