/**
 * An agent's contracts: one `main` and time-boxed `promo` overlays (todo/contracts-model.md,
 * migration 029). The quote prices from them; promos are written by `contract-writes.ts`. Pure, so
 * both stores list and order them identically.
 */
import { refuse } from './booking-actions.js';

export const CONTRACT_KINDS = ['main', 'promo'] as const;
export const CONTRACT_STATUSES = ['active', 'expired', 'void'] as const;
export type ContractKind = typeof CONTRACT_KINDS[number];
export type ContractStatus = typeof CONTRACT_STATUSES[number];

export type ContractPeriod = { route_id: string; book_from: string; book_to: string; travel_from: string | null; travel_to: string | null; note: string | null };
export type ContractSeatPrice = { route_id: string; zone: string; category: 'ad' | 'chd'; residency: 'foreign' | 'thai'; price: number };
export type Contract = {
  id: string; agent_id: string; kind: ContractKind; status: ContractStatus; rate_type_id: string | null;
  active_from: string | null; active_to: string | null; priority: number; version: string | null;
  price_mode: 'rate' | 'own' | 'discount' | null;
  discount: { mode: 'pct' | 'amt'; value: number } | null;
  bonus: { buy: number; free: number; basis: string | null } | null;
  book_window: boolean; created_date: string | null; created_by: string | null; note: string | null; doc_id: string | null;
  /** When and by whom a promo was voided (`POST /v1/contracts/{id}/void`); null otherwise, and on legacy's two. */
  voided_at: string | null; voided_by: string | null;
  /** In legacy's order. */
  program_periods: ContractPeriod[];
  /** An own-price promo's prices; empty otherwise. */
  seat_prices: ContractSeatPrice[];
};

export type ContractListQuery = { agentId?: string; kind?: ContractKind; status?: ContractStatus };

export function parseContractListQuery(query: Record<string, unknown>): ContractListQuery {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined => {
    if (value === undefined || value === '') return undefined;
    return (allowed as readonly unknown[]).includes(value) ? value as T : refuse(`${name} must be one of ${allowed.join(', ')}`, 400);
  };
  const agentId = typeof query.agent_id === 'string' && query.agent_id !== '' ? query.agent_id : undefined;
  return { agentId, kind: pick(query.kind, CONTRACT_KINDS, 'kind'), status: pick(query.status, CONTRACT_STATUSES, 'status') };
}

/** By agent, then main before promo, then the latest `active_from` first, then id. */
export function selectContracts(contracts: readonly Contract[], query: ContractListQuery): Contract[] {
  return contracts
    .filter((c) => (query.agentId === undefined || c.agent_id === query.agentId)
      && (query.kind === undefined || c.kind === query.kind) && (query.status === undefined || c.status === query.status))
    .sort((a, b) => cmp(a.agent_id, b.agent_id) || cmp(a.kind, b.kind)
      || cmp(b.active_from ?? '', a.active_from ?? '') || cmp(a.id, b.id));
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A contract as both stores hand it out: copied, so a caller cannot change the stored one. */
export const contractView = (c: Contract): Contract => ({
  ...c, discount: c.discount && { ...c.discount }, bonus: c.bonus && { ...c.bonus },
  voided_at: c.voided_at ?? null, voided_by: c.voided_by ?? null,
  program_periods: c.program_periods.map((p) => ({ ...p })),
  seat_prices: c.seat_prices.map((p) => ({ ...p }))
    .sort((a, b) => cmp(a.route_id, b.route_id) || cmp(a.zone, b.zone) || cmp(a.category, b.category) || cmp(a.residency, b.residency)),
});
