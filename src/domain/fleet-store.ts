/**
 * Where fleet part B keeps its rows (todo/fleet-maintenance-model.md, "Design — part B"): one
 * interface, two implementations, reached as `store.fleetRepo` on either store. `MemoryFleetRepo` is the
 * in-process one; `PostgresFleetRepo` (fleet-postgres.ts) runs inside the store's transaction.
 *
 * The repositories only read and write rows. Every decision is in the pure modules (`fleet-stock`,
 * `fleet-memos`, `fleet-projects`, `fleet-daily`, `fleet-safety`), and lists are sorted there, so
 * the two behave identically.
 */
import type { Consumable, Movement, NewMovement, StockItem } from './fleet-stock.js';
import type { Memo, MemoHistory, MemoReceipt } from './fleet-memos.js';
import type { Project, ProjectJobs, ProjectLog } from './fleet-projects.js';
import type { DailyBoat, DailyRequest, DailyRows, DayLock, Extra, FuelPrice, Issue, IssueItem, Meter, Water } from './fleet-daily.js';
import type { SafetyItem, SafetyLog } from './fleet-safety.js';

type Maybe<T> = T | Promise<T>;
export interface FleetRepo {
  items(): Maybe<StockItem[]>;
  item(id: string): Maybe<StockItem | undefined>;
  putItems(items: readonly StockItem[]): Maybe<void>;
  /** In order of `seq`; all of them, or those of some items, of a memo. */
  movements(q?: { itemIds?: readonly string[]; memoId?: string }): Maybe<Movement[]>;
  addMovements(rows: readonly NewMovement[]): Maybe<void>;
  /** Memo lines naming any of `from` name `to` instead (a merge, legacy `invDupMerge`). */
  repointMemoLines(from: readonly string[], to: string): Maybe<void>;

  consumables(): Maybe<Consumable[]>;
  consumable(id: string): Maybe<Consumable | undefined>;
  putConsumable(c: Consumable): Maybe<void>;

  memos(): Maybe<Memo[]>;
  memo(id: string): Maybe<Memo | undefined>;
  /** The memo and its lines, replaced whole. */
  putMemo(m: Memo): Maybe<void>;
  memoHistory(id: string): Maybe<MemoHistory[]>;
  addMemoHistory(rows: readonly MemoHistory[]): Maybe<void>;
  memoReceipts(id: string): Maybe<MemoReceipt[]>;
  addMemoReceipt(r: MemoReceipt): Maybe<void>;

  projects(): Maybe<Project[]>;
  project(id: string): Maybe<Project | undefined>;
  /** The project with its plan, documents and vendor visits, replaced whole. */
  putProject(p: Project): Maybe<void>;
  projectLog(id: string): Maybe<ProjectLog[]>;
  addProjectLog(rows: readonly ProjectLog[]): Maybe<void>;
  /** Projects whose documents name this file. */
  attachmentProjects(attachmentId: string): Maybe<string[]>;
  /**
   * A project's child maintenance jobs: part A's jobs, which this branch does not have. None until
   * the two are wired (flagged in the note).
   */
  projectJobs(projectId: string): Maybe<ProjectJobs>;

  daily(from: string, to: string): Maybe<DailyRows>;
  fuelPrices(from: string, to: string): Maybe<FuelPrice[]>;
  /** A boat's day; with neither fuel nor pax it is removed. */
  putDailyBoat(row: DailyBoat): Maybe<void>;
  /** A reading; null removes it. */
  putMeter(row: Omit<Meter, 'reading'> & { reading: number | null }): Maybe<void>;
  putFuelPrice(date: string, key: string, price: number | null): Maybe<void>;
  putLock(lock: DayLock): Maybe<void>;
  deleteLock(date: string, pier: string): Maybe<boolean>;
  /** Water readings; with neither, removed. */
  putWater(row: Water): Maybe<void>;
  putIssue(row: Omit<Issue, 'qty'> & { qty: number | null }): Maybe<void>;
  extra(id: string): Maybe<Extra | undefined>;
  putExtra(row: Extra): Maybe<void>;
  deleteExtra(id: string): Maybe<void>;
  request(id: string): Maybe<DailyRequest | undefined>;
  putRequest(row: DailyRequest): Maybe<void>;
  deleteRequest(id: string): Maybe<void>;
  issueItems(): Maybe<IssueItem[]>;
  putIssueItem(item: IssueItem): Maybe<void>;

  safetyItems(): Maybe<SafetyItem[]>;
  safetyItem(id: string): Maybe<SafetyItem | undefined>;
  /** The item and its inspections, replaced whole. */
  putSafety(item: SafetyItem): Maybe<void>;
  deleteSafety(id: string): Maybe<void>;
  safetyLog(id: string): Maybe<SafetyLog[]>;
  addSafetyLog(rows: readonly SafetyLog[]): Maybe<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** The in-process repository: plain maps, copied in and out so no caller holds a live row. */
export class MemoryFleetRepo implements FleetRepo {
  private itemRows = new Map<string, StockItem>();
  private moves: Movement[] = [];
  private seq = 0;
  private cons = new Map<string, Consumable>();
  private memoRows = new Map<string, Memo>();
  private memoLog: MemoHistory[] = [];
  private receipts: MemoReceipt[] = [];
  private projectRows = new Map<string, Project>();
  private projLog: ProjectLog[] = [];
  private boats = new Map<string, DailyBoat>();
  private meters = new Map<string, Meter>();
  private prices = new Map<string, FuelPrice>();
  private locks = new Map<string, DayLock>();
  private water = new Map<string, Water>();
  private issues = new Map<string, Issue>();
  private extras = new Map<string, Extra>();
  private requests = new Map<string, DailyRequest>();
  private catalogue = new Map<string, IssueItem>();
  private safety = new Map<string, SafetyItem>();
  private safetyLogRows: SafetyLog[] = [];

  items(): StockItem[] { return [...this.itemRows.values()].map(clone); }
  item(id: string): StockItem | undefined { const i = this.itemRows.get(id); return i && clone(i); }
  putItems(items: readonly StockItem[]): void { for (const i of items) this.itemRows.set(i.id, clone(i)); }
  movements(q: { itemIds?: readonly string[]; memoId?: string } = {}): Movement[] {
    const ids = q.itemIds && new Set(q.itemIds);
    return this.moves.filter((m) => (!ids || ids.has(m.item_id)) && (q.memoId === undefined || m.memo_id === q.memoId)).map(clone);
  }
  addMovements(rows: readonly NewMovement[]): void { for (const r of rows) this.moves.push({ ...clone(r), seq: ++this.seq }); }
  repointMemoLines(from: readonly string[], to: string): void {
    for (const m of this.memoRows.values()) for (const l of m.lines) if (l.item_id && from.includes(l.item_id)) l.item_id = to;
  }

  consumables(): Consumable[] { return [...this.cons.values()].map(clone); }
  consumable(id: string): Consumable | undefined { const c = this.cons.get(id); return c && clone(c); }
  putConsumable(c: Consumable): void { this.cons.set(c.id, clone(c)); }

  memos(): Memo[] { return [...this.memoRows.values()].map(clone); }
  memo(id: string): Memo | undefined { const m = this.memoRows.get(id); return m && clone(m); }
  putMemo(m: Memo): void { this.memoRows.set(m.id, clone(m)); }
  memoHistory(id: string): MemoHistory[] { return this.memoLog.filter((h) => h.memo_id === id).map(clone); }
  addMemoHistory(rows: readonly MemoHistory[]): void { this.memoLog.push(...rows.map(clone)); }
  memoReceipts(id: string): MemoReceipt[] { return this.receipts.filter((r) => r.memo_id === id).map(clone); }
  addMemoReceipt(r: MemoReceipt): void { this.receipts.push(clone(r)); }

  projects(): Project[] { return [...this.projectRows.values()].map(clone); }
  project(id: string): Project | undefined { const p = this.projectRows.get(id); return p && clone(p); }
  putProject(p: Project): void { this.projectRows.set(p.id, clone(p)); }
  projectLog(id: string): ProjectLog[] { return this.projLog.filter((l) => l.project_id === id).map(clone); }
  addProjectLog(rows: readonly ProjectLog[]): void { this.projLog.push(...rows.map(clone)); }
  attachmentProjects(attachmentId: string): string[] {
    return [...this.projectRows.values()].filter((p) => p.documents.some((d) => d.attachment_id === attachmentId)).map((p) => p.id);
  }
  projectJobs(_projectId: string): ProjectJobs { return { jobs: [] }; }

  daily(from: string, to: string): DailyRows {
    const inRange = <T extends { date: string }>(rows: Iterable<T>) => [...rows].filter((r) => r.date >= from && r.date <= to).map(clone);
    return {
      boats: inRange(this.boats.values()), meters: inRange(this.meters.values()), prices: inRange(this.prices.values()), locks: inRange(this.locks.values()),
      water: inRange(this.water.values()), issues: inRange(this.issues.values()), extras: inRange(this.extras.values()), requests: inRange(this.requests.values()),
    };
  }
  fuelPrices(from: string, to: string): FuelPrice[] { return [...this.prices.values()].filter((p) => p.date >= from && p.date <= to).map(clone); }
  putDailyBoat(row: DailyBoat): void {
    const key = `${row.date}|${row.boat_id}`;
    if (row.fuel_litres === null && row.pax_actual === null) this.boats.delete(key); else this.boats.set(key, clone(row));
  }
  putMeter(row: Omit<Meter, 'reading'> & { reading: number | null }): void {
    const key = `${row.date}|${row.boat_id}|${row.trip_type}|${row.engine_id}`;
    if (row.reading === null) this.meters.delete(key); else this.meters.set(key, { ...row, reading: row.reading });
  }
  putFuelPrice(date: string, key: string, price: number | null): void {
    if (price === null) this.prices.delete(`${date}|${key}`); else this.prices.set(`${date}|${key}`, { date, key, price });
  }
  putLock(lock: DayLock): void { this.locks.set(`${lock.date}|${lock.pier}`, clone(lock)); }
  deleteLock(date: string, pier: string): boolean { return this.locks.delete(`${date}|${pier}`); }
  putWater(row: Water): void {
    const key = `${row.date}|${row.boat_id}`;
    if (row.open_reading === null && row.close_reading === null) this.water.delete(key); else this.water.set(key, clone(row));
  }
  putIssue(row: Omit<Issue, 'qty'> & { qty: number | null }): void {
    const key = `${row.date}|${row.boat_id}|${row.item_id}`;
    if (row.qty === null) this.issues.delete(key); else this.issues.set(key, { ...row, qty: row.qty });
  }
  extra(id: string): Extra | undefined { const x = this.extras.get(id); return x && clone(x); }
  putExtra(row: Extra): void { this.extras.set(row.id, clone(row)); }
  deleteExtra(id: string): void { this.extras.delete(id); }
  request(id: string): DailyRequest | undefined { const r = this.requests.get(id); return r && clone(r); }
  putRequest(row: DailyRequest): void { this.requests.set(row.id, clone(row)); }
  deleteRequest(id: string): void { this.requests.delete(id); }
  issueItems(): IssueItem[] { return [...this.catalogue.values()].map(clone); }
  putIssueItem(item: IssueItem): void { this.catalogue.set(item.id, clone(item)); }

  safetyItems(): SafetyItem[] { return [...this.safety.values()].map(clone); }
  safetyItem(id: string): SafetyItem | undefined { const s = this.safety.get(id); return s && clone(s); }
  putSafety(item: SafetyItem): void { this.safety.set(item.id, clone(item)); }
  deleteSafety(id: string): void { this.safety.delete(id); this.safetyLogRows = this.safetyLogRows.filter((l) => l.item_id !== id); }
  safetyLog(id: string): SafetyLog[] { return this.safetyLogRows.filter((l) => l.item_id === id).map(clone); }
  addSafetyLog(rows: readonly SafetyLog[]): void { this.safetyLogRows.push(...rows.map(clone)); }
}
