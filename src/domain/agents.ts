/**
 * Agents (resellers), markets and salespeople: the reference data the Agent List screen reads.
 *
 * Both stores hand back `StoredAgent` rows and nothing more. What the API says about an agent — its
 * wire shape, whether it is complete, whether it matches a search, and the order of the list — is
 * decided here, once, so the in-process store and PostgreSQL cannot drift (CLAUDE.md, "Logic that
 * both stores need goes in a pure function both call").
 */

/** Legacy SB_PAYMENT_TYPES (08-app.js:111). */
export const PAY_TYPES = ['invoice', 'proforma', 'bt', 'cot'] as const;
export type PayType = typeof PAY_TYPES[number];
export const VAT_MODES = ['none', 'include', 'exclude'] as const;
export type VatMode = typeof VAT_MODES[number];
export const isPayType = (value: unknown): value is PayType => (PAY_TYPES as readonly unknown[]).includes(value);
export const isVatMode = (value: unknown): value is VatMode => (VAT_MODES as readonly unknown[]).includes(value);

export type Market = { id: string; name: string; color: string | null; sort: number | null; subs: string[] };
export type SalesPerson = {
  id: string; code: string | null; name: string; full_name: string | null; designation: string | null;
  email: string | null; tel: string | null; color: string | null; active: boolean;
};

/** A programme the agent may sell. Book dates are the window sales entered by hand; null is open. */
export type AgentProgram = { route_id: string; book_from: string | null; book_to: string | null; note: string | null };
export type AgentActivity = { at: string; by: string | null; kind: string; text: string };

/**
 * An agent exactly as both stores hold it: one flat record, the columns of `agents`, plus its
 * programmes in order. Absent values are null, never undefined, so the two stores compare equal.
 */
export type StoredAgent = {
  id: string; code: string | null; name: string;
  market_id: string | null; sub_market: string | null; sales_id: string | null; color: string | null;
  pay_type: PayType | null; vat_mode: VatMode; credit_days: number | null; credit_limit: number | null;
  contact: string | null; email: string | null; phone: string | null; note: string | null;
  rate_type_id: string | null; contract_template_id: string | null;
  contract_status: string | null; contract_version: string | null; contract_start: string | null; contract_end: string | null;
  legal_name: string | null; tax_id: string | null; tat_license: string | null; address: string | null;
  company_tel: string | null; hotline: string | null; fax: string | null; website: string | null;
  signatory_name: string | null; signatory_designation: string | null; signatory_tel: string | null; signatory_signed_date: string | null;
  booking_method: string | null; booking_cutoff: string | null; booking_cancel_policy: string | null; booking_email: string | null; booking_phone: string | null;
  house: boolean; active: boolean; created_at: string; updated_at: string;
  programs: AgentProgram[];
};

/**
 * What a profile is missing before the agent can be sold correctly, in legacy's order
 * (`agIncompleteFields`, agents.js:1206). Contact is satisfied by any one of email, phone or contact.
 */
export const INCOMPLETE_FIELDS = ['market', 'sales', 'pay_type', 'rate_type', 'programs', 'contact'] as const;
export type IncompleteField = typeof INCOMPLETE_FIELDS[number];

const blank = (value: string | null): boolean => value === null || value.trim() === '';

export function agentIncomplete(agent: StoredAgent): IncompleteField[] {
  const missing: IncompleteField[] = [];
  if (blank(agent.market_id)) missing.push('market');
  if (blank(agent.sales_id)) missing.push('sales');
  if (agent.pay_type === null) missing.push('pay_type');
  if (blank(agent.rate_type_id)) missing.push('rate_type');
  if (agent.programs.length === 0) missing.push('programs');
  if (blank(agent.email) && blank(agent.phone) && blank(agent.contact)) missing.push('contact');
  return missing;
}

/** One row of `GET /v1/agents`: enough for the list, its filters and the header counts. */
export type AgentSummary = {
  id: string; code: string | null; name: string; market_id: string | null; sub_market: string | null; sales_id: string | null;
  color: string | null; pay_type: PayType | null; vat_mode: VatMode; credit_limit: number | null; rate_type_id: string | null;
  program_route_ids: string[]; contract_status: string | null; contract_end: string | null;
  incomplete: IncompleteField[]; house: boolean; active: boolean;
};

export function agentSummary(agent: StoredAgent): AgentSummary {
  return {
    id: agent.id, code: agent.code, name: agent.name, market_id: agent.market_id, sub_market: agent.sub_market, sales_id: agent.sales_id,
    color: agent.color, pay_type: agent.pay_type, vat_mode: agent.vat_mode, credit_limit: agent.credit_limit, rate_type_id: agent.rate_type_id,
    program_route_ids: agent.programs.map((program) => program.route_id),
    contract_status: agent.contract_status, contract_end: agent.contract_end,
    incomplete: agentIncomplete(agent), house: agent.house, active: agent.active,
  };
}

/** `GET /v1/agents/:id`: every column, with the company, signatory and booking channel grouped. */
export type Agent = Omit<AgentSummary, 'program_route_ids'> & {
  credit_days: number | null; contact: string | null; email: string | null; phone: string | null; note: string | null;
  contract_template_id: string | null; contract_version: string | null; contract_start: string | null;
  company: { legal_name: string | null; tax_id: string | null; tat_license: string | null; address: string | null; tel: string | null; hotline: string | null; fax: string | null; website: string | null };
  signatory: { name: string | null; designation: string | null; tel: string | null; signed_date: string | null };
  booking_channel: { method: string | null; cutoff: string | null; cancel_policy: string | null; email: string | null; phone: string | null };
  programs: AgentProgram[];
  created_at: string; updated_at: string;
};

export function agentView(agent: StoredAgent): Agent {
  const { program_route_ids: _routes, ...summary } = agentSummary(agent);
  return {
    ...summary,
    credit_days: agent.credit_days, contact: agent.contact, email: agent.email, phone: agent.phone, note: agent.note,
    contract_template_id: agent.contract_template_id, contract_version: agent.contract_version, contract_start: agent.contract_start,
    company: { legal_name: agent.legal_name, tax_id: agent.tax_id, tat_license: agent.tat_license, address: agent.address, tel: agent.company_tel, hotline: agent.hotline, fax: agent.fax, website: agent.website },
    signatory: { name: agent.signatory_name, designation: agent.signatory_designation, tel: agent.signatory_tel, signed_date: agent.signatory_signed_date },
    booking_channel: { method: agent.booking_method, cutoff: agent.booking_cutoff, cancel_policy: agent.booking_cancel_policy, email: agent.booking_email, phone: agent.booking_phone },
    programs: agent.programs.map((program) => ({ ...program })),
    created_at: agent.created_at, updated_at: agent.updated_at,
  };
}

/** `active: undefined` means both active and inactive agents. */
export type AgentListQuery = { marketId?: string; salesId?: string; q?: string; active?: boolean };

/**
 * The agents a list request asks for, A–Z by name.
 *
 * Search matches name, code, sub-market, market name and salesperson name, case-insensitively, as
 * legacy's list does (`agRenderList`, agents.js:1216). Unlike legacy, an agent with no code does not
 * throw. The sort is legacy's too (`localeCompare` in English, case- and accent-insensitive), with the
 * id breaking ties so the order is stable between calls and between stores.
 */
export function selectAgents(agents: readonly StoredAgent[], markets: readonly Market[], sales: readonly SalesPerson[], query: AgentListQuery): StoredAgent[] {
  const marketName = new Map(markets.map((market) => [market.id, market.name]));
  const salesName = new Map(sales.map((person) => [person.id, person.name]));
  const needle = query.q?.trim().toLowerCase();
  const matches = (agent: StoredAgent): boolean => {
    if (!needle) return true;
    const fields = [agent.name, agent.code, agent.sub_market,
      agent.market_id === null ? null : marketName.get(agent.market_id) ?? null,
      agent.sales_id === null ? null : salesName.get(agent.sales_id) ?? null];
    return fields.some((field) => field !== null && field.toLowerCase().includes(needle));
  };
  return agents
    .filter((agent) => (query.active === undefined || agent.active === query.active)
      && (query.marketId === undefined || agent.market_id === query.marketId)
      && (query.salesId === undefined || agent.sales_id === query.salesId)
      && matches(agent))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Markets in filter order: by `sort`, unsorted ones last, then id. */
export const sortMarkets = (markets: readonly Market[]): Market[] =>
  [...markets].sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Salespeople by name, then id. */
export const sortSalesPeople = (people: readonly SalesPerson[]): SalesPerson[] =>
  [...people].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Newest first; entries at the same instant keep the order they were written in (`seq`, later first). */
export type StoredActivity = AgentActivity & { seq: number };
export const latestActivity = (entries: readonly StoredActivity[], limit: number): AgentActivity[] =>
  [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.seq - a.seq)).slice(0, limit).map(({ seq: _seq, ...entry }) => entry);
