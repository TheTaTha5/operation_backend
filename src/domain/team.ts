/**
 * Salespeople and markets: legacy's "Team & Markets" screen (`renderTeamMkt`, `tmSaveModal`,
 * `tmDeleteSales`, `tmDeleteMarket`, `tmApplyMarketOrder` in allotment_v2/js/08-app.js), edited under
 * the `config` area (decision 2). Pure, so both stores decide alike.
 */
import { refuse } from './booking-actions.js';
import type { Market, SalesPerson } from './agents.js';
import { assertKnownKeys } from './server-owned.js';

const bad = (message: string): never => refuse(message, 400);
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(`${name} must be text`);
  return (value as string).trim() || null;
};

// ── Salespeople ──────────────────────────────────────────────────────────────────────────────────

/** A salesperson as stored: the list's fields and the signature printed on contracts. */
export type StoredSalesPerson = SalesPerson & { signature: string | null };
/** `GET /v1/sales` rows say only whether there is a signature: one can be several hundred KB. */
export type SalesPersonSummary = SalesPerson & { has_signature: boolean };
export const salesSummary = ({ signature, ...person }: StoredSalesPerson): SalesPersonSummary => ({ ...person, has_signature: signature !== null });

/** Legacy shrinks a signature to a 900 px PNG before saving; 1 MB is far above what that makes (682 KB today). */
export const MAX_SIGNATURE_LENGTH = 1_000_000;
const SALES_FIELDS = ['code', 'name', 'full_name', 'designation', 'email', 'tel', 'color', 'signature', 'active'] as const;
type SalesFields = Partial<Omit<StoredSalesPerson, 'id'>>;

function parseSalesFields(body: Record<string, unknown>): SalesFields {
  assertKnownKeys(body, [...SALES_FIELDS, 'fullName'], 'A salesperson');
  const fields: SalesFields = {};
  if (body.code !== undefined) {
    // Legacy's input: "Code (2-3 ตัวอักษร)", uppercased as it is typed.
    const code = text(body.code, 'code')?.toUpperCase() ?? bad('code is required');
    if (code.length > 3) bad('code must be at most 3 characters');
    fields.code = code;
  }
  if (body.name !== undefined) fields.name = text(body.name, 'name') ?? bad('name is required');
  const fullName = body.full_name !== undefined ? body.full_name : body.fullName;
  if (fullName !== undefined) fields.full_name = text(fullName, 'full_name');
  for (const key of ['designation', 'email', 'tel', 'color'] as const) if (body[key] !== undefined) fields[key] = text(body[key], key);
  if (body.signature !== undefined) {
    const signature = text(body.signature, 'signature');
    if (signature !== null && !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(signature)) bad('signature must be a PNG or JPEG data URL (data:image/png;base64,…)');
    if (signature !== null && signature.length > MAX_SIGNATURE_LENGTH) bad('signature is too large: at most 1 MB');
    fields.signature = signature;
  }
  if (body.active !== undefined) fields.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  return fields;
}

const codeClash = (code: string | null | undefined, people: readonly SalesPerson[], exceptId?: string) =>
  code ? people.find((p) => p.id !== exceptId && p.code !== null && p.code.toUpperCase() === code.toUpperCase()) : undefined;
const assertCodeFree = (code: string | null | undefined, people: readonly SalesPerson[], exceptId?: string): void => {
  const clash = codeClash(code, people, exceptId);
  // Legacy: `Code "NK" ถูกใช้แล้วโดย Nok`.
  if (clash) refuse(`Code "${code}" is already ${clash.name}'s`, 409, 'code_taken');
};

/** `POST /v1/sales`: code and name required, code unique (legacy `tmSaveModal`). */
export function planSalesCreate(body: Record<string, unknown>, id: string, people: readonly SalesPerson[]): StoredSalesPerson {
  if (body.id !== undefined) bad('id cannot be sent: the server makes it');
  const f = parseSalesFields(body);
  if (!f.code) bad('code is required');
  if (!f.name) bad('name is required');
  assertCodeFree(f.code, people);
  return {
    id, code: f.code!, name: f.name!, full_name: f.full_name ?? null, designation: f.designation === undefined ? 'Sales Executive' : f.designation,
    email: f.email ?? null, tel: f.tel ?? null, color: f.color ?? null, active: f.active ?? true, signature: f.signature ?? null,
  };
}

/** `PATCH /v1/sales/{id}`: the fields it names. */
export function planSalesPatch(stored: StoredSalesPerson, body: Record<string, unknown>, people: readonly SalesPerson[]): StoredSalesPerson {
  if (body.id !== undefined && body.id !== stored.id) bad('id cannot be changed');
  const { id: _id, has_signature: _has, ...rest } = body;
  const f = parseSalesFields(rest);
  if (f.code !== undefined && f.code !== stored.code) assertCodeFree(f.code, people, stored.id);
  return { ...stored, ...f };
}

/** A salesperson a login or a rate type still names cannot go: those would point at nobody. */
export function assertSalesDeletable(id: string, usage: { logins: number; rate_types: number }): void {
  const named = [usage.logins ? `${usage.logins} login(s)` : '', usage.rate_types ? `${usage.rate_types} rate type(s)` : ''].filter(Boolean);
  if (named.length) refuse(`Salesperson ${id} cannot be deleted: ${named.join(' and ')} name them. Make them inactive instead, or reassign those first`, 409, 'in_use');
}

// ── Markets ──────────────────────────────────────────────────────────────────────────────────────

const subsOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) bad('subs must be a list of names');
  const out: string[] = [];
  for (const [i, raw] of (value as unknown[]).entries()) {
    const name = text(raw, `subs[${i}]`);
    // Legacy splits the text box by line and drops blanks; a repeat would break the list's key.
    if (name && !out.some((s) => s.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
};

/** `POST /v1/markets`: id lowercase letters and digits, fixed after create, unique (legacy `tmSaveModal`). */
export function planMarketCreate(body: Record<string, unknown>, markets: readonly Market[]): Market {
  assertKnownKeys(body, ['id', 'name', 'color', 'subs'], 'A market');
  const id = text(body.id, 'id') ?? bad('id is required');
  if (!/^[a-z0-9]+$/.test(id)) bad('id must be lowercase letters and digits only, e.g. ru, ota');
  if (markets.some((m) => m.id === id)) refuse(`Market ID "${id}" is taken`, 409, 'exists');
  const name = text(body.name, 'name') ?? bad('name is required');
  const sort = markets.reduce((max, m) => Math.max(max, m.sort ?? 0), 0) + 1;
  return { id, name, color: text(body.color, 'color'), sort, subs: body.subs === undefined ? [] : subsOf(body.subs) };
}

/** `PATCH /v1/markets/{id}`: name, colour and the sub-market list. The id never changes. */
export function planMarketPatch(stored: Market, body: Record<string, unknown>): Market {
  if (body.id !== undefined && body.id !== stored.id) bad('A market\'s id cannot change after it is created');
  if (body.sort !== undefined && body.sort !== stored.sort) bad('sort cannot be changed here: use PUT /v1/markets/order');
  const { id: _id, sort: _sort, ...rest } = body;
  assertKnownKeys(rest, ['name', 'color', 'subs'], 'A market');
  const next = { ...stored, subs: [...stored.subs] };
  if (rest.name !== undefined) next.name = text(rest.name, 'name') ?? bad('name is required');
  if (rest.color !== undefined) next.color = text(rest.color, 'color');
  if (rest.subs !== undefined) next.subs = subsOf(rest.subs);
  return next;
}

/** `PUT /v1/markets/order`: legacy's drag-to-reorder (`tmApplyMarketOrder`) sends every market once. */
export function planMarketOrder(body: Record<string, unknown>, markets: readonly Market[]): Market[] {
  assertKnownKeys(body, ['ids'], 'The market order');
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) bad('ids must be a list of market ids');
  const ids = body.ids as string[];
  const known = new Set(markets.map((m) => m.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) bad(`Not markets: ${unknown.join(', ')}`);
  if (new Set(ids).size !== ids.length || ids.length !== markets.length) bad('ids must list every market exactly once');
  return ids.map((id, i) => ({ ...markets.find((m) => m.id === id)!, sort: i + 1 }));
}

/** Legacy `tmDeleteMarket`: "ย้าย agents ไปตลาดอื่นก่อน". */
export function assertMarketDeletable(market: Market, agents: number): void {
  if (agents > 0) refuse(`Cannot delete "${market.name}": ${agents} agent(s) are in this market. Move them to another market first`, 409, 'in_use');
}
