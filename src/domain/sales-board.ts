/**
 * The Sales Board (todo/sales-editing-model.md, "Design — extras"): a salesperson's monthly pax target
 * (legacy `salesSetTarget`, `sbEditTarget`), the follow-up marks on their agents (`salesToggleFollow`),
 * and the board legacy draws from them (`salesPaxAgg`, `salesStreak`, `agentTrend`, `renderSalesBoard`
 * in allotment_v2/js/04-data-core.js and 08-app.js). Pure, so both stores answer the same board.
 */
import { refuse } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { assertKnownKeys } from './server-owned.js';
import type { Booking } from './operations.js';

const bad = (message: string): never => refuse(message, 400);

export type SalesTarget = { sales_id: string; month: string; pax: number; set_at: string; set_by: string | null };
export const FOLLOWUP_KINDS = ['agent', 'foc'] as const;
export type FollowupKind = typeof FOLLOWUP_KINDS[number];
export type SalesFollowup = { sales_id: string; month: string; agent_id: string; kind: FollowupKind; marked_at: string; marked_by: string | null };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const parseMonth = (value: unknown, name = 'month'): string => (typeof value === 'string' && MONTH.test(value) ? value : bad(`${name} must be a month, YYYY-MM`));
/** Legacy `_ymShift`. */
export function monthShift(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** The month's last day, as a date. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** `PUT /v1/sales/{id}/targets/{month}`: a whole number of pax, 0 or `null` clears (legacy deletes a 0). */
export function parseTarget(body: Record<string, unknown>): number {
  assertKnownKeys(body, ['pax'], 'A target');
  if (body.pax === null) return 0;
  return Number.isInteger(body.pax) && (body.pax as number) >= 0 ? body.pax as number : bad('pax must be a whole number, 0 or more (0 clears the target)');
}

/** `PUT /v1/sales/{id}/followups`: set or clear one mark (legacy toggles; a retry here cannot undo it). */
export function parseFollowup(body: Record<string, unknown>): { month: string; agent_id: string; kind: FollowupKind; marked: boolean } {
  assertKnownKeys(body, ['month', 'agent_id', 'kind', 'marked'], 'A follow-up mark');
  const agentId = typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : bad('agent_id is required');
  const kind = body.kind === undefined ? 'agent' : (FOLLOWUP_KINDS as readonly unknown[]).includes(body.kind) ? body.kind as FollowupKind : bad('kind must be agent or foc');
  const marked = typeof body.marked === 'boolean' ? body.marked : bad('marked must be true or false');
  return { month: parseMonth(body.month), agent_id: agentId, kind, marked };
}

/** Legacy `agentTrend` (+25 % up, −20 % down, a base under 5 shown as a difference). */
export type Trend = { category: 'new' | 'gone' | 'flat' | 'up' | 'down'; pct: number | null; change: number };
export function agentTrend(pax: number, previous: number): Trend {
  if (previous <= 0 && pax > 0) return { category: 'new', pct: null, change: pax };
  if (previous > 0 && pax <= 0) return { category: 'gone', pct: null, change: -previous };
  if (previous < 5) return { category: 'flat', pct: null, change: pax - previous };
  const pct = Math.round((pax / previous - 1) * 100);
  return { category: pct >= 25 ? 'up' : pct <= -20 ? 'down' : 'flat', pct, change: pax - previous };
}

const STREAK_MONTHS = 24;
/** The trip months the board reads: back from `month` as far as a streak could reach, and last month. */
export function boardRange(month: string, targets: readonly SalesTarget[]): { from: string; to: string } {
  const has = new Set(targets.map((t) => `${t.sales_id}|${t.month}`));
  let earliest = monthShift(month, -1);
  for (const sid of new Set(targets.map((t) => t.sales_id))) {
    let cur = month;
    for (let i = 0; i < STREAK_MONTHS && has.has(`${sid}|${cur}`); i++) { if (cur < earliest) earliest = cur; cur = monthShift(cur, -1); }
  }
  return { from: `${earliest}-01`, to: monthEnd(month) };
}

type BoardSales = { id: string; name: string; code: string | null; color: string | null; active: boolean };
type BoardAgent = { id: string; name: string; sales_id: string | null };
export type SalesBoardRow = {
  sales_id: string; name: string; code: string | null; color: string | null; pax: number; foc: number; target: number | null; target_pct: number | null;
  reached: boolean; streak: number; rank: number; previous_rank: number; bookings: number; agents: number; agents_with_sales: number;
};
export type SalesBoardAgent = { agent_id: string; name: string; sales_id: string | null; pax: number; previous_pax: number; foc: number; trend: Trend; followed: boolean; feedback_collected: boolean };
export type SalesBoard = { month: string; previous_month: string; total_pax: number; sales: SalesBoardRow[]; agents: SalesBoardAgent[] };

const sumAll = (pax: Record<string, number>): number => Object.values(pax).reduce((s, n) => s + n, 0);
const focOf = (pax: Record<string, number>): number => (pax.foc ?? 0) + (pax.foc_fr ?? 0) + (pax.foc_th ?? 0);
const add = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);

/**
 * Legacy's board. Pax count by trip month (every passenger, infants and FOC included), bookings that
 * still hold seats, credited to the agent's salesperson today. `sales` is every active salesperson in
 * legacy's order (by id), most pax first; `scope` (a sales-bound login) limits `agents` to its own.
 */
export function salesBoard(input: {
  month: string; sales: readonly BoardSales[]; agents: readonly BoardAgent[]; bookings: readonly Booking[];
  targets: readonly SalesTarget[]; followups: readonly SalesFollowup[]; scope?: string;
}): SalesBoard {
  const { month } = input;
  const previous = monthShift(month, -1);
  const salesOf = new Map(input.agents.map((a) => [a.id, a.sales_id]));
  const bySales = new Map<string, number>(), focBySales = new Map<string, number>(), byAgent = new Map<string, number>(), focByAgent = new Map<string, number>();
  const bookingsBySales = new Map<string, number>();
  for (const b of input.bookings) {
    if ((SEAT_RELEASING_STATUSES as readonly string[]).includes(b.status)) continue;
    const sid = b.agent_id ? salesOf.get(b.agent_id) ?? null : null;
    if (sid && b.trips.some((t) => t.service_date.slice(0, 7) === month)) add(bookingsBySales, sid, 1);
    for (const t of b.trips) {
      const ym = t.service_date.slice(0, 7);
      const px = sumAll(t.pax);
      if (!px) continue;
      const foc = focOf(t.pax);
      if (b.agent_id) { add(byAgent, `${ym}|${b.agent_id}`, px); if (foc) add(focByAgent, `${ym}|${b.agent_id}`, foc); }
      if (sid) { add(bySales, `${ym}|${sid}`, px); if (foc) add(focBySales, `${ym}|${sid}`, foc); }
    }
  }
  const target = new Map(input.targets.map((t) => [`${t.sales_id}|${t.month}`, t.pax]));
  const paxOf = (sid: string, ym: string) => bySales.get(`${ym}|${sid}`) ?? 0;
  const streak = (sid: string): number => {
    let n = 0, cur = month;
    for (let i = 0; i < STREAK_MONTHS; i++) {
      const tgt = target.get(`${sid}|${cur}`);
      if (!tgt || paxOf(sid, cur) < tgt) break;
      n++; cur = monthShift(cur, -1);
    }
    return n;
  };
  const active = [...input.sales].filter((s) => s.active).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ranked = (ym: string) => new Map([...active].sort((a, b) => paxOf(b.id, ym) - paxOf(a.id, ym)).map((s, i) => [s.id, i + 1]));
  const rank = ranked(month), previousRank = ranked(previous);
  const sales = [...active].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).map((s): SalesBoardRow => {
    const pax = paxOf(s.id, month), tgt = target.get(`${s.id}|${month}`) ?? null;
    const mine = input.agents.filter((a) => a.sales_id === s.id);
    return {
      sales_id: s.id, name: s.name, code: s.code, color: s.color, pax, foc: focBySales.get(`${month}|${s.id}`) ?? 0,
      target: tgt, target_pct: tgt ? Math.round((pax / tgt) * 100) : null, reached: tgt !== null && pax >= tgt, streak: streak(s.id),
      rank: rank.get(s.id)!, previous_rank: previousRank.get(s.id)!, bookings: bookingsBySales.get(s.id) ?? 0,
      agents: mine.length, agents_with_sales: mine.filter((a) => (byAgent.get(`${month}|${a.id}`) ?? 0) > 0).length,
    };
  });
  const marked = new Set(input.followups.filter((f) => f.month === month).map((f) => `${f.sales_id}|${f.agent_id}|${f.kind}`));
  const agents = input.agents
    .filter((a) => a.sales_id !== null && (input.scope === undefined || a.sales_id === input.scope))
    .map((a): SalesBoardAgent => {
      const pax = byAgent.get(`${month}|${a.id}`) ?? 0, previousPax = byAgent.get(`${previous}|${a.id}`) ?? 0;
      return {
        agent_id: a.id, name: a.name, sales_id: a.sales_id, pax, previous_pax: previousPax, foc: focByAgent.get(`${month}|${a.id}`) ?? 0,
        trend: agentTrend(pax, previousPax), followed: marked.has(`${a.sales_id}|${a.id}|agent`), feedback_collected: marked.has(`${a.sales_id}|${a.id}|foc`),
      };
    })
    .filter((a) => a.pax > 0 || a.previous_pax > 0)
    .sort((a, b) => b.pax - a.pax || (a.agent_id < b.agent_id ? -1 : 1));
  return { month, previous_month: previous, total_pax: sales.reduce((s, r) => s + r.pax, 0), sales, agents };
}
