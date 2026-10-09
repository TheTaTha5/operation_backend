/**
 * On-tour upgrades (slice E of todo/trip-ops-and-vans-model.md, migration 038): an upsell sold to the
 * customer ("Longtail · Join → เหมา (Charter)"), its price, what the company is owed, and how it was
 * paid. A booking field: the list replaces outright, like `passengers`. Legacy `bkV2UpgradeSave`.
 * Pure, so both stores decide identically.
 */
import { refuse, type HistoryLine } from './booking-actions.js';
import { parseAttachmentIds, type AttachmentRef } from './attachments.js';

export type StoredUpgrade = {
  id: string; label: string; sell_price: number; to_company: number | null; seller: string | null; note: string | null;
  collected: boolean | null; settle: 'pending' | 'done' | null; method: string | null;
  fee_pct: number | null; fee: number | null; customer_paid: number | null; at: string | null;
  /** Payment-slip attachment ids (migration 040). */
  slips: string[];
};
/** As a read shows it: `commission` is `sell_price − to_company`, never below 0; `slips` are the files. */
export type Upgrade = Omit<StoredUpgrade, 'slips'> & { commission: number; slips: AttachmentRef[] };

const bad = (message: string): never => refuse(message, 400);
/** Legacy `pckN`: money to the satang. */
const money = (n: number): number => Math.round(n * 100 + (n < 0 ? -1e-9 : 1e-9)) / 100;
/** Legacy `pckNum`: "2,000", or "1,995.50". */
const baht = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });

export const upgradeView = (u: StoredUpgrade, files: ReadonlyMap<string, AttachmentRef> = new Map()): Upgrade => ({
  ...u, commission: money(Math.max(0, u.sell_price - (u.to_company ?? 0))),
  slips: u.slips.map((id) => files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 }),
});
/** Back to what a store writes. */
export const upgradeStored = ({ commission: _c, slips, ...u }: Upgrade): StoredUpgrade => ({ ...u, slips: slips.map((s) => s.id) });

/** The client's fields. `commission`, `fee` and `customer_paid` are the server's and are not read. */
export type UpgradeInput = Omit<StoredUpgrade, 'fee' | 'customer_paid' | 'at'>;

export function parseUpgrades(value: unknown, label = 'upgrades'): UpgradeInput[] {
  if (value === null) return [];
  if (!Array.isArray(value)) bad(`${label} must be a list`);
  const list = (value as unknown[]).map((raw, i): UpgradeInput => {
    const at = `${label}[${i}]`;
    const u = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : bad(`${at} must be an object`);
    const get = (...keys: string[]) => keys.map((k) => u![k]).find((v) => v !== undefined);
    const text = (name: string, ...keys: string[]): string | null => {
      const v = get(...keys);
      if (v === undefined || v === null) return null;
      return typeof v === 'string' ? v.trim() || null : bad(`${at}.${name} must be text`);
    };
    const amount = (name: string, ...keys: string[]): number | null => {
      const v = get(...keys);
      if (v === undefined || v === null || v === '') return null;
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? money(n) : bad(`${at}.${name} must be a number ≥ 0`);
    };
    // Payment slips are uploaded files (POST /v1/attachments); the route checks they exist.
    const slips = parseAttachmentIds(get('slips'), `${at}.slips`).map((s) => s.id);
    const sell = amount('sell_price', 'sell_price', 'sellPrice');
    if (sell === null || sell <= 0) bad(`${at}.sell_price is required: legacy says "ใส่ราคาขาย"`);
    const feePct = amount('fee_pct', 'fee_pct', 'feePct');
    if (feePct !== null && feePct > 100) bad(`${at}.fee_pct must be 100 or less`);
    const collected = get('collected');
    if (collected !== undefined && collected !== null && typeof collected !== 'boolean') bad(`${at}.collected must be true or false`);
    const settle = get('settle');
    if (settle !== undefined && settle !== null && settle !== 'pending' && settle !== 'done') bad(`${at}.settle must be pending or done`);
    return {
      id: text('id', 'id') ?? `up_${Date.now()}_${i}`, label: text('label', 'label') ?? 'Upgrade', sell_price: sell!,
      to_company: amount('to_company', 'to_company', 'toCompany'), seller: text('seller', 'seller'), note: text('note', 'note'),
      collected: (collected as boolean | null | undefined) ?? null, settle: (settle as 'pending' | 'done' | null | undefined) ?? null,
      method: text('method', 'method'), fee_pct: feePct, slips,
    };
  });
  const ids = list.map((u) => u.id);
  if (new Set(ids).size !== ids.length) bad(`${label} names an id twice`);
  return list;
}

/**
 * The list to store: each sale keeps the time it was first saved (`at`), and the server works out its
 * card fee and what the customer paid (legacy `bkV2ExtraFee`: only a card pays a fee). A sale with no
 * payment method has neither, as legacy's older sales don't. Also answers the history lines legacy
 * writes: one per new sale and per edited one; removing one is not logged.
 */
export function storedUpgrades(input: readonly UpgradeInput[], current: readonly StoredUpgrade[], now: string, by: string | null): { upgrades: StoredUpgrade[]; history: HistoryLine[] } {
  const history: HistoryLine[] = [];
  const upgrades = input.map((u): StoredUpgrade => {
    const was = current.find((c) => c.id === u.id);
    const card = u.method === 'card';
    const feePct = u.method === null ? u.fee_pct : card ? u.fee_pct ?? 0 : 0;
    const fee = u.method === null ? null : card ? money(u.sell_price * (feePct ?? 0) / 100) : 0;
    const next: StoredUpgrade = {
      ...u, settle: u.settle ?? was?.settle ?? 'pending', fee_pct: feePct, fee, customer_paid: fee === null ? null : money(u.sell_price + fee), at: was?.at ?? now,
    };
    const commission = upgradeView(next).commission;
    const seller = next.seller ? ` · ${next.seller}` : '';
    if (!was) history.push({ by, kind: 'extra', tag: 'Extra', text: `Upgrade · ${next.label} · ขาย ฿${baht(next.sell_price)} · บริษัท ฿${baht(next.to_company ?? 0)} · คอม ฿${baht(commission)}${seller}` });
    else if (JSON.stringify({ ...was }) !== JSON.stringify({ ...was, ...next })) {
      history.push({ by, kind: 'extra', tag: 'Extra', text: `Edited upgrade · ${next.label} · ขาย ฿${baht(next.sell_price)} · คอม ฿${baht(commission)}${seller}` });
    }
    return next;
  });
  return { upgrades, history };
}

// ── Route upgrade: a trip moved to another programme (legacy `bkV2UpgApply`, `bkV2UpgUndo`) ──

/** A trip's route upgrade, kept after an undo (`undone_at`). */
export type TripUpgrade = {
  id: number; booking_trip_id: string; from_route_id: string; to_route_id: string; reason: string; charge: number;
  upgrade_id: string | null; at: string; by: string | null; undone_at: string | null; undone_by: string | null;
};
/** What a booking read shows on the trip: the upgrade in force, if any. */
export type TripUpgradeView = Omit<TripUpgrade, 'booking_trip_id' | 'undone_at' | 'undone_by'>;
export const activeUpgrade = (rows: readonly TripUpgrade[]): TripUpgradeView | null => {
  const live = rows.filter((r) => r.undone_at === null).sort((a, b) => b.id - a.id)[0];
  if (!live) return null;
  const { booking_trip_id: _t, undone_at: _u, undone_by: _b, ...view } = live;
  return view;
};

export function parseRouteUpgrade(body: Record<string, unknown>): { trip_id: string; to_route_id: string; reason: string; charge: number } {
  const tripId = typeof body.trip_id === 'string' && body.trip_id ? body.trip_id : bad('trip_id is required');
  const to = typeof body.to_route_id === 'string' && body.to_route_id ? body.to_route_id : bad('to_route_id is required: pick the destination programme');
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : bad('reason is required: legacy says "Enter a reason."');
  const raw = body.charge === undefined || body.charge === null || body.charge === '' ? 0 : typeof body.charge === 'string' ? Number(body.charge) : body.charge;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) bad('charge must be a number ≥ 0');
  return { trip_id: tripId!, to_route_id: to!, reason: reason!, charge: money(raw as number) };
}

/** Legacy's history lines, with its `toLocaleString` amounts. */
export const routeUpgradeLine = (by: string | null, from: string, to: string, reason: string, charge: number): HistoryLine =>
  ({ by, kind: 'edit', tag: 'Edit', text: `Upgrade route · ${from} > ${to} · ${reason}${charge > 0 ? ` · +THB ${charge.toLocaleString('en-US')}` : ' · no charge'}` });
export const upgradeUndoneLine = (by: string | null, from: string): HistoryLine => ({ by, kind: 'edit', tag: 'Edit', text: `Upgrade undone · back to ${from}` });

/** The sale a charged route upgrade adds: cash, not yet collected, all of it owed to the company. */
export const routeUpgradeSale = (id: string, charge: number, toName: string, reason: string, now: string): StoredUpgrade => ({
  id, label: `Upgrade > ${toName}`, sell_price: charge, to_company: charge, seller: null, note: reason, collected: false, settle: 'pending',
  method: 'cash', fee_pct: 0, fee: 0, customer_paid: charge, at: now, slips: [],
});
