/**
 * Creating and editing agents (todo/sales-editing-model.md, decided 2026-10-09). Legacy did all of
 * this in the browser (`agCreateSubmit`, `agEditSave`, `agProgSyncOnRate`, `_ctSyncMainRate`,
 * `ctRenewActivate` in allotment_v2/js/08-app.js) and its server stored whatever arrived.
 *
 * Every function here is pure: it takes the agent as stored and what the request and the store said,
 * and answers the agent to store and the activity lines to write. Both stores only save the result, so
 * the rules and the wording cannot drift between them.
 */
import { refuse } from './booking-actions.js';
import { isIsoDate } from './calendar.js';
import { isPayType, isVatMode, type AgentActivity, type AgentProgram, type Market, type StoredAgent } from './agents.js';
import { assertKnownKeys } from './server-owned.js';

/** The business's own accounts (decision 14 adds `a_company`). */
export const HOUSE_AGENT_IDS = ['a_walkin', 'a_staff', 'a_company', 'a_b2c'] as const;

const bad = (message: string): never => refuse(message, 400);

// ── Who may see which agent (decision 3) ─────────────────────────────────────────────────────────

/**
 * The salesperson a login is bound to, or undefined when it sees every agent. Legacy's
 * `laSalesScoped`: a login with a salesperson that is not an admin.
 */
export const salesScopeOf = (user: { role: string; sales_id: string | null } | undefined): string | undefined =>
  user && user.role !== 'admin' && user.sales_id ? user.sales_id : undefined;

/** Legacy `laAgentInScope`, refused rather than hidden: "not in your care". */
export function assertAgentInScope(agent: { sales_id: string | null }, scope: string | undefined): void {
  if (scope !== undefined && agent.sales_id !== scope) refuse('This agent belongs to another salesperson', 403, 'forbidden');
}

// ── The fields a client may write ────────────────────────────────────────────────────────────────

type Column = Exclude<keyof StoredAgent, 'programs' | 'created_at' | 'updated_at' | 'house' | 'active' | 'id'>;
/** The client facts: flat fields, and the three groups `GET` nests (`company.tel` is `company_tel`). */
const FLAT: Column[] = ['name', 'code', 'market_id', 'sub_market', 'sales_id', 'color', 'pay_type', 'vat_mode', 'credit_days', 'credit_limit',
  'contact', 'email', 'phone', 'note', 'contract_template_id'];
const GROUPS: Record<'company' | 'signatory' | 'booking_channel', Record<string, Column>> = {
  company: { legal_name: 'legal_name', tax_id: 'tax_id', tat_license: 'tat_license', address: 'address', tel: 'company_tel', hotline: 'hotline', fax: 'fax', website: 'website' },
  signatory: { name: 'signatory_name', designation: 'signatory_designation', tel: 'signatory_tel', signed_date: 'signatory_signed_date' },
  booking_channel: { method: 'booking_method', cutoff: 'booking_cutoff', cancel_policy: 'booking_cancel_policy', email: 'booking_email', phone: 'booking_phone' },
};
const LABEL: Partial<Record<Column, string>> = { legal_name: 'company.legal_name', address: 'company.address', company_tel: 'company.tel', signatory_signed_date: 'signatory.signed_date' };
const label = (column: Column): string => LABEL[column] ?? column;

/** The columns a request sets; a key it does not mention is absent, `null` clears. */
export type AgentFields = Partial<Pick<StoredAgent, Column>>;

/**
 * Server-owned fields a `PATCH` may echo but not change, and the command to use instead.
 * `credit_balance` is legacy's hand-typed balance: it is worked out here (`credit.used`).
 */
export const AGENT_SERVER_OWNED: Record<string, string> = {
  id: 'an agent\'s id never changes',
  rate_type_id: 'use PUT /v1/agents/{id}/rate-type',
  programs: 'use PUT /v1/agents/{id}/programs',
  active: 'use POST /v1/agents/{id}/deactivate or /activate',
  contract_status: 'use POST /v1/agents/{id}/renew', contract_version: 'use POST /v1/agents/{id}/renew',
  contract_start: 'use POST /v1/agents/{id}/renew', contract_end: 'use POST /v1/agents/{id}/renew',
  house: 'the house accounts are fixed',
  rate_seasons: 'use PUT /v1/agents/{id}/rate-seasons',
  credit_balance: 'credit is worked out from invoices and payments (credit.used)',
  incomplete: 'it is worked out by the server', credit: 'it is worked out by the server', contract_history: 'it is written by POST /v1/agents/{id}/renew',
  contract_template_effective_id: 'it is worked out by the server', created_at: 'it is worked out by the server', updated_at: 'it is worked out by the server',
};

const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(`${name} must be text`);
  return (value as string).trim() || null;
};
const count = (value: unknown, name: string, integer: boolean): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) bad(`${name} must be ${integer ? 'a whole number' : 'a number'} ≥ 0`);
  return n;
};

function fieldValue(column: Column, value: unknown): unknown {
  const name = label(column);
  switch (column) {
    case 'pay_type': {
      const v = text(value, name)?.toLowerCase() ?? null;
      // Legacy's edit form writes `bank` for Bank Transfer, which every reader calls `bt` (bug 9).
      const mapped = v === 'bank' ? 'bt' : v;
      if (mapped !== null && !isPayType(mapped)) bad('pay_type must be invoice, proforma, bt or cot');
      return mapped;
    }
    case 'vat_mode': {
      const v = text(value, name)?.toLowerCase() ?? null;
      if (v === null) bad('vat_mode is required: none, include or exclude');
      if (!isVatMode(v)) bad('vat_mode must be none, include or exclude');
      return v;
    }
    case 'credit_days': return count(value, name, true);
    case 'credit_limit': return count(value, name, false);
    case 'signatory_signed_date': {
      const v = text(value, name);
      if (v !== null && !isIsoDate(v)) bad('signatory.signed_date must be YYYY-MM-DD');
      return v;
    }
    case 'code': return text(value, name);
    default: return text(value, name);
  }
}

/** Reads the client facts out of a body: flat fields and the three groups, each checked for shape. */
export function parseAgentFields(body: Record<string, unknown>, extra: readonly string[]): AgentFields {
  assertKnownKeys(body, [...FLAT, ...Object.keys(GROUPS), 'pay_type', ...extra, 'payType', 'vatMode'], 'An agent');
  const fields: AgentFields = {};
  const set = (column: Column, value: unknown) => { (fields as Record<string, unknown>)[column] = fieldValue(column, value); };
  for (const column of FLAT) if (body[column] !== undefined) set(column, body[column]);
  if (body.payType !== undefined && body.pay_type === undefined) set('pay_type', body.payType);
  if (body.vatMode !== undefined && body.vat_mode === undefined) set('vat_mode', body.vatMode);
  for (const [group, columns] of Object.entries(GROUPS)) {
    const raw = body[group];
    if (raw === undefined) continue;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad(`${group} must be an object`);
    const values = raw as Record<string, unknown>;
    assertKnownKeys(values, Object.keys(columns), group);
    for (const [key, column] of Object.entries(columns)) if (values[key] !== undefined) set(column, values[key]);
  }
  return fields;
}

// ── What a write must check against the rest of the data ─────────────────────────────────────────

/** The data an agent write is checked against, read by the route from the store. */
export type AgentWriteContext = {
  /** Every agent, for codes and the duplicate check. */
  agents: readonly Pick<StoredAgent, 'id' | 'code' | 'name'>[];
  markets: readonly Market[];
  /** Salesperson id → name. */
  sales: ReadonlyMap<string, string>;
  /** Template id → name. */
  templates: ReadonlyMap<string, string>;
  /** The caller's salesperson when it is sales-bound. */
  scope: string | undefined;
};

const sameCode = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
const codeOwner = (code: string, agents: AgentWriteContext['agents'], exceptId?: string) => agents.find((a) => a.id !== exceptId && sameCode(a.code, code));
const codeTaken = (code: string, owner: { id: string; name: string }): never =>
  refuse(`Code ${code} is already agent ${owner.name} (${owner.id})'s`, 409, 'code_taken');

/**
 * Legacy's import normalisation (`_agImpNorm`), which `agFindDup` uses: brackets opened, company
 * words dropped (co, ltd, dmc, thailand…), everything but letters, digits and Thai a space.
 */
export const normalizeAgentName = (name: string): string => name.toLowerCase()
  .replace(/\(([^)]*)\)/g, ' $1 ')
  .replace(/\b(co|company|ltd|limited|llc|inc|dmc|thailand)\b\.?/g, ' ')
  .replace(/[^a-z0-9฀-๿]+/g, ' ').trim().replace(/\s+/g, ' ');

/** Legacy `agFindDup` by name: the same once normalised, or the same with the spaces taken out. */
export function similarAgent(name: string, agents: AgentWriteContext['agents'], exceptId?: string): Pick<StoredAgent, 'id' | 'code' | 'name'> | undefined {
  const n = normalizeAgentName(name);
  if (n.length < 2) return undefined;
  const compact = n.replace(/\s+/g, '');
  return agents.find((a) => { if (a.id === exceptId) return false; const an = normalizeAgentName(a.name); return an === n || an.replace(/\s+/g, '') === compact; });
}

/** Legacy's code: the first 8 letters and digits of the name, uppercased, else the id; a clash gets a number. */
export function generateAgentCode(name: string, id: string, agents: AgentWriteContext['agents']): string {
  const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || id.toUpperCase();
  let code = base;
  for (let n = 2; codeOwner(code, agents); n++) code = `${base}${n}`;
  return code;
}

/** `market_id`, `sales_id` and `contract_template_id` must name something that exists. */
function assertLinks(fields: AgentFields, ctx: AgentWriteContext): void {
  if (fields.market_id !== undefined && fields.market_id !== null && !ctx.markets.some((m) => m.id === fields.market_id)) bad(`market_id ${fields.market_id} is not a market (GET /v1/markets)`);
  if (fields.sales_id !== undefined && fields.sales_id !== null && !ctx.sales.has(fields.sales_id)) bad(`sales_id ${fields.sales_id} is not a salesperson (GET /v1/sales)`);
  if (fields.contract_template_id !== undefined && fields.contract_template_id !== null && !ctx.templates.has(fields.contract_template_id)) {
    bad(`contract_template_id ${fields.contract_template_id} is not a contract template (GET /v1/contract-templates)`);
  }
}

/**
 * A sub-market new to its market joins the market's list (legacy `agSubMarketRemember`): the list is
 * where the next agent's picker reads from. Answers the market to save, or undefined.
 */
export function marketWithSub(markets: readonly Market[], marketId: string | null, sub: string | null): Market | undefined {
  if (!marketId || !sub) return undefined;
  const market = markets.find((m) => m.id === marketId);
  if (!market || market.subs.some((s) => s.toLowerCase() === sub.toLowerCase())) return undefined;
  return { ...market, subs: [...market.subs, sub] };
}

// ── Create ───────────────────────────────────────────────────────────────────────────────────────

/** What `POST /v1/agents` carries beyond the client facts. */
export type AgentCreate = { fields: AgentFields; rate_type_id: string; create_anyway: boolean };
/** The rate type a create or a rate change names: what the programmes and the wording need of it. */
export type RateTypeRef = { id: string; name: string; code: string | null; owner: string | null; priced_routes: readonly string[] };

const REQUIRED: [Column | 'rate_type_id', string][] = [['name', 'name'], ['legal_name', 'company.legal_name'], ['address', 'company.address'], ['market_id', 'market_id'],
  ['rate_type_id', 'rate_type_id'], ['pay_type', 'pay_type'], ['vat_mode', 'vat_mode']];

export function parseAgentCreate(body: Record<string, unknown>): AgentCreate {
  if (body.id !== undefined) bad('id cannot be sent: the server makes it');
  for (const key of Object.keys(AGENT_SERVER_OWNED)) if (key !== 'rate_type_id' && body[key] !== undefined) bad(`${key} cannot be set on create: ${AGENT_SERVER_OWNED[key]}`);
  const fields = parseAgentFields(body, ['rate_type_id', 'rateTypeId', 'create_anyway']);
  const rate = text(body.rate_type_id ?? body.rateTypeId, 'rate_type_id');
  // Legacy's create form refuses these (`agCreateSubmit`), naming every one missing.
  const missing = REQUIRED.filter(([column]) => (column === 'rate_type_id' ? rate : (fields as Record<string, unknown>)[column]) == null).map(([, name]) => name);
  if (missing.length) bad(`Missing: ${missing.join(', ')}`);
  if (body.create_anyway !== undefined && typeof body.create_anyway !== 'boolean') bad('create_anyway must be true or false');
  return { fields, rate_type_id: rate!, create_anyway: body.create_anyway === true };
}

/** Adds a year less a day: a contract that starts on 2026-10-09 ends on 2027-10-08. */
export function yearLater(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** A rate type as legacy names it in activity: `name (code)`, else its id, else `—`. */
export const rateLabel = (rate: Pick<RateTypeRef, 'id' | 'name' | 'code'> | undefined, id: string | null): string =>
  rate ? `${rate.name}${rate.code ? ` (${rate.code})` : ''}` : id ?? '—';

/** A rate type's owner must be the agent's salesperson, or nobody (shared): legacy `rtForSales`. */
function assertRateFor(rate: RateTypeRef, salesId: string | null): void {
  if (rate.owner !== null && rate.owner !== salesId) bad(`Rate type ${rate.name || rate.id} belongs to another salesperson; choose a shared one or the agent's salesperson's own`);
}

/**
 * `POST /v1/agents` (legacy `agCreateSubmit` and `_seedAgentContractDefaults`). Answers the agent,
 * its first activity line and the market to save when the sub-market is new.
 */
export function planAgentCreate(input: AgentCreate, rate: RateTypeRef, ctx: AgentWriteContext & { id: string; now: string; today: string; by: string | null }):
  { agent: StoredAgent; activity: AgentActivity[]; market: Market | undefined } {
  const f = input.fields;
  // A sales-bound login creates agents for itself (decision 3).
  if (ctx.scope !== undefined && f.sales_id != null && f.sales_id !== ctx.scope) refuse('A salesperson creates agents for themselves only', 403, 'forbidden');
  const salesId = ctx.scope ?? f.sales_id ?? null;
  assertLinks({ ...f, sales_id: salesId }, ctx);
  assertRateFor(rate, salesId);
  const name = f.name!;
  let code: string;
  if (f.code) {
    const owner = codeOwner(f.code, ctx.agents);
    if (owner) codeTaken(f.code, owner);
    code = f.code;
  } else {
    code = generateAgentCode(name, ctx.id, ctx.agents);
  }
  // Legacy asks before creating a second agent with a near-identical name (`agFindDup`).
  const similar = similarAgent(name, ctx.agents);
  if (similar && !input.create_anyway) {
    refuse(`An agent with a similar name exists: ${similar.name}${similar.code ? ` (${similar.code})` : ''}. Send create_anyway: true to create another`, 409, 'possible_duplicate');
  }
  const credit = f.pay_type === 'invoice';
  const contractStart = ctx.today, contractEnd = yearLater(ctx.today);
  const programs: AgentProgram[] = rate.priced_routes.map((route_id) => ({ route_id, book_from: contractStart, book_to: contractEnd, note: null }));
  const agent: StoredAgent = {
    id: ctx.id, code, name, market_id: f.market_id ?? null, sub_market: f.sub_market ?? null, sales_id: salesId, color: f.color ?? null,
    pay_type: f.pay_type ?? null, vat_mode: f.vat_mode ?? 'none',
    // Legacy clears credit on create unless the agent pays by invoice; an edit keeps it (decision 8).
    credit_days: credit ? f.credit_days ?? 0 : 0, credit_limit: credit ? f.credit_limit ?? 0 : 0,
    contact: f.contact ?? null, email: f.email ?? null, phone: f.phone ?? null, note: f.note ?? null,
    rate_type_id: rate.id, contract_template_id: f.contract_template_id ?? null,
    contract_status: 'active', contract_version: `v${contractStart.slice(0, 4)}-1`, contract_start: contractStart, contract_end: contractEnd,
    legal_name: f.legal_name ?? null, tax_id: f.tax_id ?? null, tat_license: f.tat_license ?? null, address: f.address ?? null,
    company_tel: f.company_tel !== undefined ? f.company_tel : f.phone ?? null, hotline: f.hotline ?? null, fax: f.fax ?? null, website: f.website ?? null,
    signatory_name: f.signatory_name ?? f.contact ?? null,
    signatory_designation: f.signatory_designation ?? 'Authorized Signatory',
    signatory_tel: f.signatory_tel ?? f.phone ?? null, signatory_signed_date: f.signatory_signed_date ?? null,
    booking_method: f.booking_method !== undefined ? f.booking_method : 'Email',
    booking_cutoff: f.booking_cutoff !== undefined ? f.booking_cutoff : '1 วันก่อน 18:00 น.',
    booking_cancel_policy: f.booking_cancel_policy !== undefined ? f.booking_cancel_policy : '< 1 day = 50% · No-show = 100%',
    booking_email: f.booking_email !== undefined ? f.booking_email : 'book@loveandaman.com',
    booking_phone: f.booking_phone !== undefined ? f.booking_phone : '+66 88 765 4678',
    house: (HOUSE_AGENT_IDS as readonly string[]).includes(ctx.id), active: true, created_at: ctx.now, updated_at: ctx.now, programs,
  };
  const text = `Agent created · rate type ${rate.name || rate.id}${programs.length ? ` · programs ตามเรทอัตโนมัติ ${programs.length} เส้นทาง` : ''}`;
  return { agent, activity: [{ at: ctx.now, by: ctx.by, kind: 'created', text }], market: marketWithSub(ctx.markets, agent.market_id, agent.sub_market) };
}

// ── Edit ─────────────────────────────────────────────────────────────────────────────────────────

const shown = (value: string | null): string => value ?? '—';
const money = (value: number | null): string => (value ?? 0).toLocaleString('en-US');

/**
 * `PATCH /v1/agents/{id}`: the client facts it names. One activity line per section legacy's edit
 * modals have (`agEditSave`), in legacy's wording; the code and contact fields, which legacy edited
 * only in its table view without a line, get one too (decision 7).
 */
export function planAgentPatch(stored: StoredAgent, fields: AgentFields, ctx: AgentWriteContext & { now: string; by: string | null }):
  { agent: StoredAgent; activity: AgentActivity[]; market: Market | undefined } {
  if (fields.sales_id !== undefined && ctx.scope !== undefined && fields.sales_id !== ctx.scope) refuse('A salesperson cannot hand an agent to another salesperson', 403, 'forbidden');
  for (const [column, name] of [['name', 'name'], ['legal_name', 'company.legal_name'], ['market_id', 'market_id'], ['pay_type', 'pay_type']] as const) {
    if (fields[column] === null) bad(`${name} cannot be cleared`);
  }
  if (fields.code === null) bad('code cannot be cleared');
  assertLinks(fields, ctx);
  if (fields.code != null && !sameCode(fields.code, stored.code)) {
    const owner = codeOwner(fields.code, ctx.agents, stored.id);
    if (owner) codeTaken(fields.code, owner);
  }
  const next: StoredAgent = { ...stored, ...fields, programs: stored.programs.map((p) => ({ ...p })) };
  const changed = (...columns: Column[]) => columns.some((c) => next[c] !== stored[c]);
  const lines: { kind: string; text: string }[] = [];
  const salesName = (id: string | null) => (id === null ? '—' : ctx.sales.get(id) ?? id);
  const templateName = (id: string | null) => (id === null ? 'ค่าตั้งต้น' : ctx.templates.get(id) ?? id);

  if (changed('sales_id')) lines.push({ kind: 'sales', text: `Salesperson: ${salesName(stored.sales_id)} → ${salesName(next.sales_id)}` });
  const profile: string[] = [];
  if (next.pay_type !== stored.pay_type) profile.push(`payment ${shown(stored.pay_type)}→${shown(next.pay_type)}`);
  if ((next.credit_limit ?? 0) !== (stored.credit_limit ?? 0)) profile.push(`credit limit ${money(stored.credit_limit)}→${money(next.credit_limit)}`);
  if ((next.credit_days ?? 0) !== (stored.credit_days ?? 0)) profile.push(`credit days ${stored.credit_days ?? 0}→${next.credit_days ?? 0}`);
  if (next.vat_mode !== stored.vat_mode) profile.push(`VAT ${stored.vat_mode}→${next.vat_mode}`);
  if (profile.length) lines.push({ kind: 'credit', text: `Profile · ${profile.join(' · ')}` });
  if (changed('name', 'market_id', 'sub_market', 'color', 'legal_name', 'tax_id', 'tat_license', 'address', 'company_tel', 'hotline', 'fax', 'website')) {
    const parts: string[] = [];
    if (next.name !== stored.name) parts.push(`name "${stored.name}"→"${next.name}"`);
    if (next.market_id !== stored.market_id) parts.push(`market ${shown(stored.market_id)}→${shown(next.market_id)}`);
    if (next.sub_market !== stored.sub_market) parts.push(`sub "${shown(stored.sub_market)}"→"${shown(next.sub_market)}"`);
    lines.push({ kind: 'company', text: parts.length ? `Company · ${parts.join(' · ')}` : 'Company info updated' });
  }
  if (changed('code')) lines.push({ kind: 'edit', text: `Code: ${shown(stored.code)} → ${shown(next.code)}` });
  const contact = (['contact', 'email', 'phone'] as const).filter((c) => next[c] !== stored[c]).map((c) => `${c} "${shown(stored[c])}"→"${shown(next[c])}"`);
  if (contact.length) lines.push({ kind: 'edit', text: `Contact · ${contact.join(' · ')}` });
  if (changed('signatory_name', 'signatory_designation', 'signatory_tel', 'signatory_signed_date')) lines.push({ kind: 'edit', text: 'Signatory updated' });
  if (changed('booking_method', 'booking_cutoff', 'booking_cancel_policy', 'booking_email', 'booking_phone')) lines.push({ kind: 'edit', text: 'Booking channel updated' });
  if (changed('note')) lines.push({ kind: 'note', text: 'Notes updated' });
  if (changed('contract_template_id')) lines.push({ kind: 'contract', text: `Contract template: ${templateName(stored.contract_template_id)} → ${templateName(next.contract_template_id)}` });

  if (lines.length) next.updated_at = ctx.now;
  return {
    agent: next,
    activity: lines.map((line) => ({ at: ctx.now, by: ctx.by, ...line })),
    market: changed('market_id', 'sub_market') ? marketWithSub(ctx.markets, next.market_id, next.sub_market) : undefined,
  };
}

// ── Programmes ───────────────────────────────────────────────────────────────────────────────────

/**
 * `PUT /v1/agents/{id}/programs`: the whole list, in order, one row per route. A bare route id keeps
 * the stored window and note of that route (legacy's table picker wrote route ids only). `routes` is
 * the catalogue's ids, or undefined when there is none to check against (the in-process store unseeded).
 */
export function parsePrograms(body: Record<string, unknown>, stored: readonly AgentProgram[], routes: ReadonlySet<string> | undefined): AgentProgram[] {
  assertKnownKeys(body, ['programs'], 'The programmes');
  if (!Array.isArray(body.programs)) bad('programs must be a list');
  const seen = new Set<string>();
  return (body.programs as unknown[]).map((raw, i): AgentProgram => {
    const at = `programs[${i}]`;
    const row = typeof raw === 'string' ? { route_id: raw } : raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : bad(`${at} must be a route id or an object`);
    assertKnownKeys(row, ['route_id', 'book_from', 'book_to', 'note'], at);
    const routeId = typeof row.route_id === 'string' && row.route_id.trim() ? row.route_id.trim() : bad(`${at}.route_id is required`);
    if (routes && !routes.has(routeId)) bad(`${at}.route_id ${routeId} is not a route`);
    if (seen.has(routeId)) bad(`${at}: route ${routeId} is listed twice; an agent has one programme per route`);
    seen.add(routeId);
    if (typeof raw === 'string') {
      const kept = stored.find((p) => p.route_id === routeId);
      return kept ? { ...kept } : { route_id: routeId, book_from: null, book_to: null, note: null };
    }
    const date = (value: unknown, name: string): string | null => {
      if (value === undefined || value === null || value === '') return null;
      return typeof value === 'string' && isIsoDate(value) ? value : bad(`${at}.${name} must be YYYY-MM-DD`);
    };
    const program = { route_id: routeId, book_from: date(row.book_from, 'book_from'), book_to: date(row.book_to, 'book_to'), note: text(row.note, `${at}.note`) };
    if (program.book_from && program.book_to && program.book_to < program.book_from) bad(`${at} ends (${program.book_to}) before it starts (${program.book_from})`);
    return program;
  });
}

const sameProgram = (a: AgentProgram, b: AgentProgram | undefined): boolean =>
  !!b && a.route_id === b.route_id && a.book_from === b.book_from && a.book_to === b.book_to && a.note === b.note;

/** Legacy's line for the programmes section (`agEditSave`), written only when the list changed. */
export function planPrograms(stored: StoredAgent, programs: AgentProgram[], ctx: { now: string; by: string | null }): { agent: StoredAgent; activity: AgentActivity[] } {
  const same = programs.length === stored.programs.length && programs.every((p, i) => sameProgram(p, stored.programs[i]));
  if (same) return { agent: stored, activity: [] };
  const text = programs.length !== stored.programs.length ? `Programs updated (${stored.programs.length} → ${programs.length} routes)` : 'Programs / periods updated';
  return { agent: { ...stored, programs, updated_at: ctx.now }, activity: [{ at: ctx.now, by: ctx.by, kind: 'programs', text }] };
}

// ── Rate type ────────────────────────────────────────────────────────────────────────────────────

/** A main contract, as the rate sync needs it. */
export type MainContract = { id: string; kind: string; status: string; rate_type_id: string | null };

/**
 * Legacy `_ctSyncMainRate`: the agent's main contracts that are not expired or void take the new rate,
 * so the contract card and the documents printed from it say what the agent is billed at.
 */
export function mainContractsToSync(contracts: readonly MainContract[], rateTypeId: string | null): string[] {
  return contracts.filter((c) => c.kind === 'main' && c.status !== 'expired' && c.status !== 'void' && c.rate_type_id !== rateTypeId).map((c) => c.id);
}
const syncLine = (n: number, why: string): string => `สัญญา MAIN ${n} ใบ · Rate Type ตามไปด้วย (${why})`;

export type RateTypeChange = { rate_type_id: string | null; drop_unpriced: boolean | undefined };
export function parseRateTypeChange(body: Record<string, unknown>): RateTypeChange {
  assertKnownKeys(body, ['rate_type_id', 'drop_unpriced'], 'A rate type change');
  if (!('rate_type_id' in body)) bad('rate_type_id is required (null removes the rate type)');
  const id = text(body.rate_type_id, 'rate_type_id');
  if (body.drop_unpriced !== undefined && typeof body.drop_unpriced !== 'boolean') bad('drop_unpriced must be true or false');
  return { rate_type_id: id, drop_unpriced: body.drop_unpriced as boolean | undefined };
}

/**
 * `PUT /v1/agents/{id}/rate-type` (legacy `agEditSave` section `ratetype`): the rate, the main
 * contracts' rate (`_ctSyncMainRate`), and the programmes (`agProgSyncOnRate`): a route the rate
 * prices joins silently; one it does not price is removed only when `drop_unpriced` is true, and the
 * caller must say which (legacy's confirm).
 */
export function planRateTypeChange(stored: StoredAgent, change: RateTypeChange, rate: RateTypeRef | undefined, current: RateTypeRef | undefined,
  contracts: readonly MainContract[], ctx: { now: string; by: string | null; routeName: (id: string) => string }):
  { agent: StoredAgent; activity: AgentActivity[]; contracts: string[] } {
  if (change.rate_type_id === stored.rate_type_id) return { agent: stored, activity: [], contracts: [] };
  if (rate) assertRateFor(rate, stored.sales_id);
  const cover = rate?.priced_routes ?? [];
  const have = stored.programs.map((p) => p.route_id);
  const add = rate ? cover.filter((r) => !have.includes(r)) : [];
  const drop = rate ? have.filter((r) => !cover.includes(r)) : [];
  if (drop.length && change.drop_unpriced === undefined) {
    refuse(`Rate type ${rate!.name || rate!.id} has no price for ${drop.length} programme(s): ${drop.map(ctx.routeName).join(', ')}. `
      + 'Send drop_unpriced: true to remove them from the programmes, or false to keep them (booking those routes stays blocked)', 409, 'unpriced_programs');
  }
  const line = (kind: string, text: string): AgentActivity => ({ at: ctx.now, by: ctx.by, kind, text });
  const activity = [line('rate', `Rate type: ${rateLabel(current, stored.rate_type_id)} → ${rateLabel(rate, change.rate_type_id)}`)];
  const synced = mainContractsToSync(contracts, change.rate_type_id);
  if (synced.length) activity.push(line('contract', syncLine(synced.length, 'เปลี่ยน Rate Type')));
  let programs = stored.programs.map((p) => ({ ...p }));
  const removing = change.drop_unpriced === true && drop.length > 0;
  if (add.length || removing) {
    programs = [...programs, ...add.map((route_id) => ({ route_id, book_from: stored.contract_start, book_to: stored.contract_end, note: null }))];
    if (removing) programs = programs.filter((p) => !drop.includes(p.route_id));
    const parts: string[] = [];
    if (add.length) parts.push(`+${add.length} ${add.map(ctx.routeName).join(' · ')}`);
    if (removing) parts.push(`-${drop.length} ${drop.map(ctx.routeName).join(' · ')}`);
    activity.push(line('programs', `Programs ตามเรทอัตโนมัติ · ${parts.join(' · ')}`));
  }
  return { agent: { ...stored, rate_type_id: change.rate_type_id, programs, updated_at: ctx.now }, activity, contracts: synced };
}

// ── Renewal ──────────────────────────────────────────────────────────────────────────────────────

/** One archived contract (migration 090): the agent's contract fields before a renewal. */
export type ContractHistoryEntry = {
  version: string | null; archived_at: string; contract_start: string | null; contract_end: string | null; rate_type_id: string | null;
  programs: AgentProgram[]; signatory: { name: string | null; designation: string | null; tel: string | null; signed_date: string | null } | null;
  archived_by: string | null;
};

export type Renewal = {
  version: string; start: string; end: string; rate_type_id: string | undefined;
  carry: { programs: boolean; booking: boolean; signatory: boolean; company: boolean };
};

/** `POST /v1/agents/{id}/renew`: legacy's wizard (`ctOpenRenewal`). `prices` and `addons` have nothing to carry here. */
export function parseRenewal(body: Record<string, unknown>): Renewal {
  assertKnownKeys(body, ['version', 'start', 'end', 'rate_type_id', 'carry'], 'A renewal');
  const version = text(body.version, 'version') ?? bad('version is required, e.g. v2027-1');
  const date = (value: unknown, name: string): string => (typeof value === 'string' && isIsoDate(value) ? value : bad(`${name} must be YYYY-MM-DD`));
  const start = date(body.start, 'start'), end = date(body.end, 'end');
  // Legacy's step 1: "วันสิ้นสุดต้องอยู่หลังวันเริ่ม".
  if (end <= start) bad('End must be after start');
  const carryRaw = body.carry === undefined ? {} : body.carry !== null && typeof body.carry === 'object' && !Array.isArray(body.carry) ? body.carry as Record<string, unknown> : bad('carry must be an object');
  assertKnownKeys(carryRaw, ['programs', 'booking', 'signatory', 'company', 'prices', 'addons'], 'carry');
  const flag = (key: string): boolean => {
    const v = carryRaw[key];
    if (v === undefined) return true;
    return typeof v === 'boolean' ? v : bad(`carry.${key} must be true or false`);
  };
  for (const key of ['prices', 'addons']) flag(key);
  const rate = body.rate_type_id === undefined || body.rate_type_id === null || body.rate_type_id === '' ? undefined : text(body.rate_type_id, 'rate_type_id')!;
  return { version, start, end, rate_type_id: rate, carry: { programs: flag('programs'), booking: flag('booking'), signatory: flag('signatory'), company: flag('company') } };
}

const shiftDate = (date: string | null, days: number): string | null => {
  if (date === null || days === 0) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Legacy `ctRenewActivate`: archive the contract fields, take the new ones, apply a new rate (with the
 * main contracts, not the programmes), move every programme's booking window by as many days as the
 * contract start moved, and clear what is not carried over. No contract row is made (decision 6).
 */
export function planRenewal(stored: StoredAgent, renewal: Renewal, rate: RateTypeRef | undefined, current: RateTypeRef | undefined, contracts: readonly MainContract[],
  ctx: { now: string; today: string; by: string | null }): { agent: StoredAgent; history: ContractHistoryEntry; activity: AgentActivity[]; contracts: string[] } {
  const hasSignatory = [stored.signatory_name, stored.signatory_designation, stored.signatory_tel, stored.signatory_signed_date].some((v) => v !== null);
  const history: ContractHistoryEntry = {
    version: stored.contract_version, archived_at: ctx.today, contract_start: stored.contract_start, contract_end: stored.contract_end,
    rate_type_id: stored.rate_type_id, programs: stored.programs.map((p) => ({ ...p })),
    signatory: hasSignatory ? { name: stored.signatory_name, designation: stored.signatory_designation, tel: stored.signatory_tel, signed_date: stored.signatory_signed_date } : null,
    archived_by: ctx.by,
  };
  const line = (kind: string, text: string): AgentActivity => ({ at: ctx.now, by: ctx.by, kind, text });
  const activity = [line('contract', `Contract renewed · ${shown(stored.contract_version)} → ${renewal.version} · ${renewal.start} → ${renewal.end}`)];
  const next: StoredAgent = { ...stored, contract_version: renewal.version, contract_start: renewal.start, contract_end: renewal.end, contract_status: 'active', updated_at: ctx.now };
  let synced: string[] = [];
  if (renewal.rate_type_id !== undefined && renewal.rate_type_id !== stored.rate_type_id) {
    if (rate) assertRateFor(rate, stored.sales_id);
    next.rate_type_id = renewal.rate_type_id;
    activity.push(line('rate', `Rate type: ${rateLabel(current, stored.rate_type_id)} → ${rateLabel(rate, renewal.rate_type_id)}`));
    synced = mainContractsToSync(contracts, renewal.rate_type_id);
    if (synced.length) activity.push(line('contract', syncLine(synced.length, 'ต่อสัญญา')));
  }
  const shift = stored.contract_start ? daysBetween(stored.contract_start, renewal.start) : 0;
  next.programs = renewal.carry.programs ? stored.programs.map((p) => ({ ...p, book_from: shiftDate(p.book_from, shift), book_to: shiftDate(p.book_to, shift) })) : [];
  if (!renewal.carry.booking) Object.assign(next, { booking_method: null, booking_cutoff: null, booking_cancel_policy: null, booking_email: null, booking_phone: null });
  if (!renewal.carry.signatory) next.signatory_signed_date = null;
  if (!renewal.carry.company) Object.assign(next, { legal_name: null, tat_license: null, address: null, company_tel: null, hotline: null, fax: null, website: null });
  return { agent: next, history, activity, contracts: synced };
}

// ── Active ───────────────────────────────────────────────────────────────────────────────────────

/** Deactivate or activate (decision 1). Doing it twice changes nothing and writes no line. */
export function planActive(stored: StoredAgent, active: boolean, ctx: { now: string; by: string | null }): { agent: StoredAgent; activity: AgentActivity[] } {
  if (stored.active === active) return { agent: stored, activity: [] };
  return { agent: { ...stored, active, updated_at: ctx.now }, activity: [{ at: ctx.now, by: ctx.by, kind: 'edit', text: active ? 'Agent activated' : 'Agent deactivated' }] };
}

/** What still names an agent. Any of them stops a delete: deactivate it instead (decision 1). */
export type AgentUsage = { bookings: number; contracts: number; seat_locks: number; invoices: number; logins: number };
export function assertAgentDeletable(id: string, usage: AgentUsage): void {
  const named = Object.entries(usage).filter(([, n]) => n > 0).map(([what, n]) => `${n} ${what.replace('_', ' ')}`);
  if (named.length) refuse(`Agent ${id} cannot be deleted: ${named.join(', ')} name it. Deactivate it instead`, 409, 'in_use');
}

/** A booking for an inactive agent is refused (decision 1); legacy's form only hid the agent. */
export function assertAgentBookable(agent: { id: string; name: string; active: boolean } | undefined): void {
  if (agent && !agent.active) refuse(`Agent ${agent.name} (${agent.id}) is inactive; activate it or choose another agent`, 409, 'agent_inactive');
}

/** Legacy `LA_UID('a')`: a prefix, the time and some randomness, base 36. */
export const newLegacyStyleId = (prefix: string): string =>
  `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`;
