/**
 * Where the rest of Money keeps its rows (todo/money-model.md, "Design: the rest of Money";
 * migrations 160–161): the cost model, trip actuals, deposits and refund payouts. One interface, two
 * implementations, reached as `store.moneyRepo` on either store, as fleet's `fleetRepo` is.
 * `MemoryMoneyRepo` is the in-process one; `PostgresMoneyRepo` (money-postgres.ts) runs inside the
 * store's transaction.
 *
 * The repositories only read and write rows; the rules are in `costing.ts`, `trip-pl.ts` and
 * `credit.ts`, and lists are ordered here the same way in both.
 */
import type { BoatRent, CostPlan, MealVenue, StoredTemplate } from './costing.js';
import { copyActual, type TripActual } from './trip-actuals.js';
import type { RefundPayout, StoredDeposit } from './credit.js';

type Maybe<T> = T | Promise<T>;
export interface MoneyRepo {
  /** The template as stored; null = never saved (the default is used). */
  template(): Maybe<StoredTemplate | null>;
  putTemplate(t: StoredTemplate): Maybe<void>;
  /** By `sort`, then id. */
  plans(): Maybe<CostPlan[]>;
  plan(id: string): Maybe<CostPlan | undefined>;
  putPlan(p: CostPlan): Maybe<void>;
  deletePlan(id: string): Maybe<boolean>;
  /** Replaces every plan (the import). */
  replacePlans(plans: readonly CostPlan[]): Maybe<void>;
  rents(): Maybe<BoatRent[]>;
  putRent(r: BoatRent): Maybe<void>;
  deleteRent(boatId: string): Maybe<boolean>;
  replaceRents(rents: readonly BoatRent[]): Maybe<void>;
  /** In the order they were added. */
  venues(): Maybe<MealVenue[]>;
  putVenue(v: MealVenue): Maybe<void>;

  /** Every row of `from..to`, by date and boat. */
  tripActuals(from: string, to: string): Maybe<TripActual[]>;
  tripActual(date: string, boatId: string): Maybe<TripActual | undefined>;
  /** The row and its overnight choices, replaced whole. */
  putTripActual(a: TripActual): Maybe<void>;

  /** By `received_on`, then id; one agent's or everyone's. */
  deposits(q?: { agentId?: string }): Maybe<StoredDeposit[]>;
  deposit(id: string): Maybe<StoredDeposit | undefined>;
  putDeposit(d: StoredDeposit): Maybe<void>;
  /** Some refunds' payouts, or all. */
  payouts(refundIds?: readonly string[]): Maybe<RefundPayout[]>;
  putPayout(p: RefundPayout): Maybe<void>;
  deletePayout(refundId: string): Maybe<boolean>;
}

const clone = <T>(x: T): T => structuredClone(x);
const byDateBoat = (a: TripActual, b: TripActual) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : a.boat_id < b.boat_id ? -1 : a.boat_id > b.boat_id ? 1 : 0);
export const sortPlans = (ps: CostPlan[]): CostPlan[] => ps.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const sortDeposits = (ds: StoredDeposit[]): StoredDeposit[] =>
  ds.sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export class MemoryMoneyRepo implements MoneyRepo {
  private tpl: StoredTemplate | null = null;
  private planRows = new Map<string, CostPlan>();
  private rentRows = new Map<string, BoatRent>();
  private venueRows = new Map<string, MealVenue>();
  private actualRows = new Map<string, TripActual>();
  private depositRows = new Map<string, StoredDeposit>();
  private payoutRows = new Map<string, RefundPayout>();

  template(): StoredTemplate | null { return this.tpl && clone(this.tpl); }
  putTemplate(t: StoredTemplate): void { this.tpl = clone(t); }
  plans(): CostPlan[] { return sortPlans([...this.planRows.values()].map(clone)); }
  plan(id: string): CostPlan | undefined { const p = this.planRows.get(id); return p && clone(p); }
  putPlan(p: CostPlan): void { this.planRows.set(p.id, clone(p)); }
  deletePlan(id: string): boolean { return this.planRows.delete(id); }
  replacePlans(plans: readonly CostPlan[]): void { this.planRows = new Map(plans.map((p) => [p.id, clone(p)])); }
  rents(): BoatRent[] { return [...this.rentRows.values()].map(clone).sort((a, b) => (a.boat_id < b.boat_id ? -1 : 1)); }
  putRent(r: BoatRent): void { this.rentRows.set(r.boat_id, clone(r)); }
  deleteRent(boatId: string): boolean { return this.rentRows.delete(boatId); }
  replaceRents(rents: readonly BoatRent[]): void { this.rentRows = new Map(rents.map((r) => [r.boat_id, clone(r)])); }
  venues(): MealVenue[] { return [...this.venueRows.values()].map(clone); }
  putVenue(v: MealVenue): void { this.venueRows.set(v.id, clone(v)); }

  tripActuals(from: string, to: string): TripActual[] {
    return [...this.actualRows.values()].filter((a) => a.service_date >= from && a.service_date <= to).map(copyActual).sort(byDateBoat);
  }
  tripActual(date: string, boatId: string): TripActual | undefined { const a = this.actualRows.get(`${date}|${boatId}`); return a && copyActual(a); }
  putTripActual(a: TripActual): void { this.actualRows.set(`${a.service_date}|${a.boat_id}`, copyActual(a)); }

  deposits(q: { agentId?: string } = {}): StoredDeposit[] {
    return sortDeposits([...this.depositRows.values()].filter((d) => !q.agentId || d.agent_id === q.agentId).map(clone));
  }
  deposit(id: string): StoredDeposit | undefined { const d = this.depositRows.get(id); return d && clone(d); }
  putDeposit(d: StoredDeposit): void { this.depositRows.set(d.id, clone(d)); }
  payouts(refundIds?: readonly string[]): RefundPayout[] {
    return [...this.payoutRows.values()].filter((p) => !refundIds || refundIds.includes(p.refund_id)).map(clone).sort((a, b) => (a.refund_id < b.refund_id ? -1 : 1));
  }
  putPayout(p: RefundPayout): void { this.payoutRows.set(p.refund_id, clone(p)); }
  deletePayout(refundId: string): boolean { return this.payoutRows.delete(refundId); }
}
