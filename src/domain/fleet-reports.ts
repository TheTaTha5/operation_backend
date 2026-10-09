/**
 * Fleet reports, computed on read (legacy `05-fleet.js` `costAggregate`, `renderConsumables`,
 * `_fuelAgg`/`_fuelWkAgg`/`renderFuelIntel`, `flRenderDashboard`; todo/fleet-maintenance-model.md,
 * "Design — extras" 4). Pure: the routes gather rows, these decide every number, so both stores agree.
 */
import { addDays, dayGap, round2 } from './fleet-common.js';
import { jobCost, jobLane, silentDays, type Incident, type Job, type LinkedMemo } from './fleet-jobs.js';
import type { Memo } from './fleet-memos.js';
import type { Consumable, StockView } from './fleet-stock.js';
import type { Booked, DailyBoat, FuelPrice, Meter } from './fleet-daily.js';

type BoatLite = { id: string; name: string; pier: string | null; ownership: string; retired: boolean; capacity: number };
const company = <T extends Pick<BoatLite, 'ownership' | 'retired'>>(boats: readonly T[]): T[] => boats.filter((b) => b.ownership !== 'charter' && !b.retired);
const monthOf = (d: string | null | undefined): string => String(d ?? '').slice(0, 7);
/** The `n` months ending at `month`, oldest first. */
export function monthsEnding(month: string, n: number): string[] {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7));
}
const daysIn = (month: string): number => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const r0 = (n: number) => Math.round(n);

// ── Cost analytics (`costAggregate`) ──

export const COST_CATS = [
  { k: 'hull', label: 'เรือ' }, { k: 'engine', label: 'เครื่องยนต์' }, { k: 'gearbox', label: 'เกียร์' }, { k: 'propeller', label: 'ใบจักร' },
  { k: 'other', label: 'อื่น ๆ' }, { k: 'memo', label: 'memo ตรง' },
] as const;
export const COST_PERIODS = ['all', 'ytd', 'last30', 'month'] as const;
export type CostPeriod = typeof COST_PERIODS[number];
const catOf = (type: string): string => (['hull', 'engine', 'gearbox', 'propeller'].includes(type) ? type : 'other');
/** Legacy `laMemoDirectShare`: the part of a memo not bought into stock (lines with no stock item). */
export function directShare(m: Pick<Memo, 'lines'>): number {
  if (!m.lines.length) return 1;
  const amount = (l: Memo['lines'][number]) => (l.qty ?? 1) * (l.price || 0);
  const sub = m.lines.reduce((s, l) => s + amount(l), 0);
  const direct = m.lines.filter((l) => !l.item_id).reduce((s, l) => s + amount(l), 0);
  if (sub <= 0) return m.lines.every((l) => !l.item_id) ? 1 : 0;
  return Math.min(1, Math.max(0, direct / sub));
}
const COUNTED = ['paid', 'received', 'approved'];
const OUTCOME_ORDER = ['success', 'limited', 'rework', 'decommission', 'cancelled'];

/**
 * `GET /v1/fleet/reports/cost`: jobs done or in progress, their cost split equally over the categories
 * of the assets they touch; memos with a boat and no job as "direct memo" (the share not bought into
 * stock); the rest is "central" (no boat, or stock purchases), kept out of the total.
 */
export function costReport(input: { jobs: readonly Job[]; memos: readonly Memo[]; memosOf: (jobId: string) => LinkedMemo[]; boats: readonly BoatLite[]; today: string; period: CostPeriod }) {
  const { today, period } = input;
  const boatName = new Map(input.boats.map((b) => [b.id, b.name]));
  const l30 = addDays(today, -30), ytd = `${today.slice(0, 4)}-01-01`, thisMonth = today.slice(0, 7);
  const inScope = (d: string) => period === 'all' || (period === 'ytd' ? d >= ytd : period === 'month' ? d.startsWith(thisMonth) : d >= l30);
  type Row = { kind: 'job' | 'memo'; id: string; no: string; boat_id: string | null; title: string; type: string; status: string; date: string; cost: number; parts: number; memo: number; cats: string[]; done: boolean; outcome: string | null };
  const all: Row[] = [];
  const units = new Map<string, { asset_id: string; cat: string; boat_id: string; label: string; cost: number; n: number }>();
  const unitShares: { row: Row; uid: string; cat: string; label: string; share: number }[] = [];
  for (const j of input.jobs) {
    if (j.status !== 'done' && j.status !== 'inprogress') continue;
    const c = jobCost(j.parts, input.memosOf(j.id));
    const cats = j.assets.length ? j.assets.map((a) => catOf(a.type)) : ['other'];
    const row: Row = {
      kind: 'job', id: j.id, no: j.no, boat_id: j.boat_id, title: j.title, type: j.type, status: j.status, date: j.end_date ?? j.start_date ?? '', cost: c.cost,
      parts: c.parts_cost, memo: c.memo_cost, cats, done: j.status === 'done', outcome: j.status === 'done' ? j.outcome ?? 'success' : null,
    };
    all.push(row);
    j.assets.forEach((a, i) => {
      if (!a.asset_id || !['engine', 'gearbox', 'propeller'].includes(a.type)) return;
      unitShares.push({ row, uid: a.asset_id, cat: cats[i], label: a.label || a.asset_id, share: c.cost / cats.length });
    });
  }
  const central: { id: string; no: string; title: string; memo_type: string; status: string; date: string; amount: number; full_amount: number }[] = [];
  for (const m of input.memos) {
    if (m.job_id || !COUNTED.includes(m.status)) continue;
    const date = m.memo_date || m.approved_date || '';
    const share = m.boat_id ? directShare(m) : 0;
    const amt = Math.round(m.amount * share), rest = m.amount - amt;
    if ((rest > 0.5 || !m.boat_id) && inScope(date)) central.push({ id: m.id, no: m.no, title: m.title, memo_type: m.memo_type, status: m.status, date, amount: round2(m.boat_id ? rest : m.amount), full_amount: m.amount });
    if (!m.boat_id || amt <= 0) continue;
    all.push({ kind: 'memo', id: m.id, no: m.no, boat_id: m.boat_id, title: m.title, type: m.memo_type, status: m.status, date, cost: amt, parts: 0, memo: amt, cats: ['memo'], done: m.status === 'paid', outcome: null });
  }
  const rows = all.filter((r) => inScope(r.date));
  const inRows = new Set(rows);
  const total = { done: 0, proc: 0, n_done: 0, n_proc: 0 };
  const byCat = new Map<string, { done: number; proc: number; n: number }>(COST_CATS.map((c) => [c.k, { done: 0, proc: 0, n: 0 }]));
  const byType = new Map<string, { done: number; proc: number; n: number }>(['corrective', 'preventive', 'scheduled'].map((t) => [t, { done: 0, proc: 0, n: 0 }]));
  const boats = new Map<string, { boat_id: string; name: string; done: number; proc: number; n: number; cats: Record<string, number> }>();
  for (const r of rows) {
    const k = r.done ? 'done' : 'proc';
    total[k] += r.cost; total[r.done ? 'n_done' : 'n_proc'] += 1;
    if (r.kind === 'job') { const t = byType.get(r.type); if (t) { t[k] += r.cost; t.n += 1; } }
    const share = r.cost / r.cats.length;
    for (const c of new Set(r.cats)) byCat.get(c)!.n += 1;
    for (const c of r.cats) byCat.get(c)![k] += share;
    if (r.boat_id) {
      const b = boats.get(r.boat_id) ?? { boat_id: r.boat_id, name: boatName.get(r.boat_id) ?? r.boat_id, done: 0, proc: 0, n: 0, cats: {} };
      b[k] += r.cost; b.n += 1;
      for (const c of r.cats) b.cats[c] = (b.cats[c] ?? 0) + share;
      boats.set(r.boat_id, b);
    }
  }
  for (const u of unitShares) {
    if (!inRows.has(u.row)) continue;
    const x = units.get(u.uid) ?? { asset_id: u.uid, cat: u.cat, boat_id: u.row.boat_id!, label: u.label, cost: 0, n: 0 };
    x.cost += u.share; x.n += 1;
    units.set(u.uid, x);
  }
  const outcomes = OUTCOME_ORDER.map((o) => {
    const list = rows.filter((r) => r.kind === 'job' && r.done && r.outcome === o);
    const cost = list.reduce((s, r) => s + r.cost, 0);
    return { outcome: o, count: list.length, cost: round2(cost), average: list.length ? round2(cost / list.length) : 0 };
  });
  const months = monthsEnding(thisMonth, 12).map((month) => {
    const list = all.filter((r) => monthOf(r.date) === month);
    return { month, done: round2(list.filter((r) => r.done).reduce((s, r) => s + r.cost, 0)), proc: round2(list.filter((r) => !r.done).reduce((s, r) => s + r.cost, 0)) };
  });
  const sum = total.done + total.proc;
  const boatList = [...boats.values()].map((b) => ({ ...b, done: round2(b.done), proc: round2(b.proc), total: round2(b.done + b.proc), pct: sum ? r0(((b.done + b.proc) / sum) * 100) : 0,
    cats: Object.fromEntries(Object.entries(b.cats).map(([k, v]) => [k, round2(v)])) })).sort((a, b) => b.total - a.total);
  return {
    period, total: round2(sum), done: round2(total.done), proc: round2(total.proc), n_done: total.n_done, n_proc: total.n_proc, n_jobs: total.n_done + total.n_proc,
    boats_serviced: boatList.length, average_per_job: total.n_done + total.n_proc ? round2(sum / (total.n_done + total.n_proc)) : 0,
    central: { n: central.length, amount: round2(central.reduce((s, c) => s + c.amount, 0)), memos: central.sort((a, b) => b.full_amount - a.full_amount) },
    categories: COST_CATS.map((c) => { const x = byCat.get(c.k)!; return { key: c.k, label: c.label, done: round2(x.done), proc: round2(x.proc), total: round2(x.done + x.proc), n: x.n, pct: sum ? r0(((x.done + x.proc) / sum) * 100) : 0 }; }),
    by_type: [...byType].map(([type, x]) => ({ type, done: round2(x.done), proc: round2(x.proc), total: round2(x.done + x.proc), n: x.n })),
    outcomes, months, boats: boatList,
    units: [...units.values()].map((u) => ({ ...u, cost: round2(u.cost) })).sort((a, b) => b.cost - a.cost).slice(0, 10),
    rows: rows.map(({ outcome: _o, ...r }) => ({ ...r, cost: round2(r.cost) })).sort((a, b) => b.cost - a.cost || b.date.localeCompare(a.date)),
  };
}

// ── Upkeep (`renderConsumables`) ──

/** Legacy `flBoatRepairCostMonth`: a boat's jobs started that month, any status. */
const repairsOf = (jobs: readonly Job[], memosOf: (id: string) => LinkedMemo[], boatId: string, month: string): number =>
  r0(jobs.filter((j) => j.boat_id === boatId && monthOf(j.start_date ?? j.end_date) === month).reduce((s, j) => s + jobCost(j.parts, memosOf(j.id)).cost, 0));

/** `GET /v1/fleet/reports/upkeep?month=`: per boat, the month's repairs plus what was drawn for it. */
export function upkeepReport(input: { month: string; consumables: readonly Consumable[]; jobs: readonly Job[]; memosOf: (id: string) => LinkedMemo[]; boats: readonly BoatLite[] }) {
  const { month } = input;
  const draws = input.consumables.filter((c) => !c.voided_at && monthOf(c.date) === month).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const costOf = (c: Consumable) => r0(c.qty * c.unit_cost);
  const name = new Map(input.boats.map((b) => [b.id, b.name]));
  const ids = [...new Set([...input.boats.map((b) => b.id), ...draws.map((c) => c.boat_id)])];
  const rows = ids.map((id) => {
    const cons = draws.filter((c) => c.boat_id === id).reduce((s, c) => s + costOf(c), 0);
    const rep = repairsOf(input.jobs, input.memosOf, id, month);
    return { boat_id: id, name: name.get(id) ?? id, repairs: rep, consumables: cons, upkeep: rep + cons };
  }).filter((r) => r.repairs > 0 || r.consumables > 0).sort((a, b) => b.upkeep - a.upkeep);
  const consumables = draws.reduce((s, c) => s + costOf(c), 0);
  const repairs = rows.reduce((s, r) => s + r.repairs, 0);
  return {
    month, draws: draws.map((c) => ({ ...c, cost: costOf(c) })), consumables, repairs, upkeep: repairs + consumables,
    oil_drawn: round2(draws.filter((c) => /oil|น้ำมัน/i.test(c.item_name)).reduce((s, c) => s + c.qty, 0)), boats: rows,
  };
}

// ── Fuel intelligence (`_fuelAgg`, `_fuelWkAgg`, `renderFuelIntel`) ──

export type FuelInput = {
  month: string; today: string;
  boats: readonly BoatLite[];
  /** The Daily Log's boat-days from the first of the six months to the end of `month`. */
  daily: readonly DailyBoat[]; meters: readonly Meter[]; prices: readonly FuelPrice[];
  prevMeter: (engineId: string, date: string) => number | null;
  engines: readonly { id: string; boat_id: string | null }[];
  booked: (date: string) => ReadonlyMap<string, Booked>;
  familyOf: (routeId: string) => { id: string; name: string };
  routeName: (routeId: string) => string;
  /** Revenue of the month's trips by programme family (legacy: every booking, any boat). */
  revenue: ReadonlyMap<string, number>;
  budget: number | null;
};
type Acc = { days: number; fuel: number; cost: number; pax: number; run_hours: number };
const blank = (): Acc => ({ days: 0, fuel: 0, cost: 0, pax: 0, run_hours: 0 });
const metrics = (a: Acc) => ({
  days: a.days, fuel: round2(a.fuel), cost: round2(a.cost), pax: a.pax, run_hours: round2(a.run_hours),
  l_per_hour: a.run_hours > 0 ? round2(a.fuel / a.run_hours) : null, l_per_day: a.days ? round2(a.fuel / a.days) : null, l_per_pax: a.pax > 0 ? round2(a.fuel / a.pax) : null,
});

/**
 * `GET /v1/fleet/reports/fuel?month=`: the company boats' fuel. A boat-day counts when the boat ran
 * (booked pax, a route, or fuel); its cost is fuel × the boat's price that day, else its home pier's
 * (legacy `flFuelPriceForBoat`: no other fallback, a missing price costs 0 and is said).
 */
export function fuelReport(input: FuelInput) {
  const boats = new Map(company(input.boats).map((b) => [b.id, b]));
  const priceOn = new Map<string, number>(input.prices.map((p) => [`${p.date}|${p.key}`, p.price]));
  const normal = new Map<string, number>();
  for (const m of input.meters) if (m.trip_type === 'normal' && m.reading !== null) normal.set(`${m.date}|${m.boat_id}|${m.engine_id}`, m.reading);
  const enginesOf = (boatId: string) => input.engines.filter((e) => e.boat_id === boatId).map((e) => e.id);
  type Day = { boat_id: string; date: string; fuel: number; cost: number; pax: number; run_hours: number; routes: Record<string, number>; price_missing: boolean };
  const dayCache = new Map<string, Day[]>();
  const daysOf = (month: string): Day[] => {
    if (dayCache.has(month)) return dayCache.get(month)!;
    const out: Day[] = [];
    for (const d of input.daily.filter((x) => monthOf(x.date) === month).sort((a, b) => a.date.localeCompare(b.date) || a.boat_id.localeCompare(b.boat_id))) {
      const b = boats.get(d.boat_id);
      if (!b) continue;
      const fuel = d.fuel_litres ?? 0;
      const info = input.booked(d.date).get(d.boat_id) ?? { pax: 0, routes: {} };
      if (!(info.pax > 0 || Object.keys(info.routes).length > 0 || fuel > 0)) continue;
      const price = priceOn.get(`${d.date}|${b.id}`) ?? (b.pier ? priceOn.get(`${d.date}|${b.pier}`) : undefined);
      let run = 0;
      for (const e of enginesOf(b.id)) {
        const cur = normal.get(`${d.date}|${b.id}|${e}`);
        const prev = input.prevMeter(e, d.date);
        if (cur !== undefined && prev !== null) run = Math.max(run, cur - prev);
      }
      out.push({ boat_id: b.id, date: d.date, fuel, cost: fuel && price !== undefined ? fuel * price : 0, pax: info.pax, run_hours: run, routes: info.routes, price_missing: fuel > 0 && price === undefined });
    }
    dayCache.set(month, out);
    return out;
  };
  const sumOf = (list: readonly Day[]): Acc => list.reduce((a, d) => ({ days: a.days + 1, fuel: a.fuel + d.fuel, cost: a.cost + d.cost, pax: a.pax + d.pax, run_hours: a.run_hours + d.run_hours }), blank());

  const { month, today } = input;
  const days = daysOf(month);
  const prevMonth = monthsEnding(month, 2)[0];
  const all = sumOf(days), prev = sumOf(daysOf(prevMonth));
  const cpp = all.pax > 0 ? all.cost / all.pax : 0, pcpp = prev.pax > 0 ? prev.cost / prev.pax : 0;
  const dim = daysIn(month);
  const elapsed = month === today.slice(0, 7) ? Number(today.slice(8, 10)) : dim;
  const projection = elapsed > 0 ? (all.cost / elapsed) * dim : all.cost;
  const name = (id: string) => boats.get(id)?.name ?? id;

  const anomalies: { boat_id: string; name: string; date: string; fuel: number; average: number; pct: number }[] = [];
  const missing: { boat_id: string; name: string; date: string; route: string | null }[] = [];
  const byBoat = new Map<string, Acc & { missing: number; routes: Map<string, Acc> }>();
  const byFam = new Map<string, { family_id: string; name: string; fuel: number; cost: number; pax: number }>();
  const weekly = [0, 0, 0, 0, 0];
  for (const d of days) {
    const b = byBoat.get(d.boat_id) ?? { ...blank(), missing: 0, routes: new Map<string, Acc>() };
    b.days += 1; b.fuel += d.fuel; b.cost += d.cost; b.pax += d.pax; b.run_hours += d.run_hours;
    const rk = Object.keys(d.routes);
    if (d.fuel <= 0) { b.missing += 1; missing.push({ boat_id: d.boat_id, name: name(d.boat_id), date: d.date, route: rk.length ? input.routeName(rk[0]) : null }); }
    for (const rid of rk) {
      const share = d.pax > 0 ? d.routes[rid] / d.pax : 1 / rk.length;
      const fam = input.familyOf(rid);
      const f = byFam.get(fam.id) ?? { family_id: fam.id, name: fam.name, fuel: 0, cost: 0, pax: 0 };
      f.fuel += d.fuel * share; f.cost += d.cost * share; f.pax += d.routes[rid];
      byFam.set(fam.id, f);
      const r = b.routes.get(rid) ?? blank();
      r.days += 1; r.fuel += d.fuel * share; r.cost += d.cost * share; r.pax += d.routes[rid];
      b.routes.set(rid, r);
    }
    if (d.fuel > 0 && !rk.length) {
      const r = b.routes.get('') ?? blank();
      r.days += 1; r.fuel += d.fuel; r.cost += d.cost;
      b.routes.set('', r);
    }
    weekly[Math.min(4, Math.ceil(Number(d.date.slice(8, 10)) / 7) - 1)] += d.cost;
    byBoat.set(d.boat_id, b);
  }
  for (const [id] of byBoat) {
    const fdays = days.filter((d) => d.boat_id === id && d.fuel > 0);
    if (fdays.length < 3) continue;
    const avg = fdays.reduce((s, d) => s + d.fuel, 0) / fdays.length;
    for (const d of fdays) if (d.fuel > avg * 1.3) anomalies.push({ boat_id: id, name: name(id), date: d.date, fuel: r0(d.fuel), average: r0(avg), pct: r0((d.fuel / avg - 1) * 100) });
  }
  anomalies.sort((a, b) => b.pct - a.pct);
  const eff = [...byBoat].filter(([, b]) => b.run_hours > 0).map(([id, b]) => ({ boat_id: id, name: name(id), l_per_hour: round2(b.fuel / b.run_hours) })).sort((a, b) => a.l_per_hour - b.l_per_hour);
  const median = eff.length ? eff[Math.floor(eff.length / 2)].l_per_hour : null;

  const weekOf = (date: string) => Math.min(4, Math.ceil(Number(date.slice(8, 10)) / 7) - 1);
  const ids = [...byBoat.keys()].sort((a, b) => byBoat.get(b)!.fuel - byBoat.get(a)!.fuel);
  const six = monthsEnding(month, 6);
  const trend = ids.map((id) => ({
    boat_id: id, name: name(id),
    base: metrics(sumOf(daysOf(prevMonth).filter((d) => d.boat_id === id))),
    weeks: [0, 1, 2, 3, 4].map((w) => metrics(sumOf(days.filter((d) => d.boat_id === id && weekOf(d.date) === w)))),
    months: six.map((m) => ({ month: m, ...metrics(sumOf(daysOf(m).filter((d) => d.boat_id === id))) })),
  }));
  const families = [...new Set([...byFam.keys(), ...input.revenue.keys()])].map((fid) => {
    const f = byFam.get(fid) ?? { family_id: fid, name: input.familyOf(fid).name, fuel: 0, cost: 0, pax: 0 };
    const rev = input.revenue.get(fid) ?? 0;
    return { family_id: fid, name: f.name, fuel: round2(f.fuel), cost: round2(f.cost), pax: f.pax, revenue: round2(rev),
      l_per_pax: f.pax > 0 ? round2(f.fuel / f.pax) : null, baht_per_pax: f.pax > 0 ? round2(f.cost / f.pax) : null, pct_of_revenue: rev > 0 ? r0((f.cost / rev) * 100) : null };
  }).filter((f) => f.fuel > 0 || f.revenue > 0).sort((a, b) => b.fuel - a.fuel);

  return {
    month, days_in_month: dim, elapsed, current: month === today.slice(0, 7),
    cost: round2(all.cost), fuel: round2(all.fuel), pax: all.pax, trip_days: all.days, cost_per_pax: round2(cpp),
    previous: { month: prevMonth, cost: round2(prev.cost), pax: prev.pax, cost_per_pax: round2(pcpp) },
    change_pct: pcpp > 0 ? r0((cpp / pcpp - 1) * 100) : null,
    projection: round2(projection), budget: input.budget, over_budget: input.budget === null ? null : projection > input.budget,
    price_missing: days.some((d) => d.price_missing),
    anomalies, missing, logged_pct: all.days ? r0(((all.days - missing.length) / all.days) * 100) : 100,
    boats: ids.map((id) => {
      const b = byBoat.get(id)!;
      const cap = boats.get(id)!.capacity;
      return {
        boat_id: id, name: name(id), ...metrics(b), missing: b.missing, pax_per_day: b.days ? r0(b.pax / b.days) : 0, load_pct: b.days && cap ? r0((b.pax / b.days / cap) * 100) : null,
        routes: [...b.routes].map(([rid, r]) => ({ route_id: rid || null, name: rid ? input.routeName(rid) : 'ไม่ระบุเส้นทาง', ...metrics(r) })),
      };
    }),
    efficiency: eff.map((e, i) => ({ ...e, best: i === 0, thirsty: i === eff.length - 1 && median !== null && e.l_per_hour > median * 1.25 })), efficiency_median: median,
    families, weekly: weekly.map((c, i) => ({ week: `W${i + 1}`, cost: round2(c) })), trend,
  };
}

/** Legacy's revenue by family: each booking's trips that month share what it owes, or carry their own subtotal. */
export function revenueByFamily(bookings: readonly { status: string; total?: number; fee_items: readonly { amount: number }[]; trips: readonly { service_date: string; route_id: string; subtotal?: number }[] }[],
  month: string, familyOf: (routeId: string) => { id: string }): Map<string, number> {
  const out = new Map<string, number>();
  for (const bk of bookings) {
    if (['cancelled', 'rejected', 'cancelled_weather'].includes(bk.status)) continue;
    const trs = bk.trips.filter((t) => monthOf(t.service_date) === month);
    if (!trs.length) continue;
    const tot = (bk.total ?? 0) + bk.fee_items.reduce((s, f) => s + f.amount, 0);
    for (const t of trs) {
      const fid = familyOf(t.route_id).id;
      out.set(fid, (out.get(fid) ?? 0) + ((t.subtotal ?? 0) > 0 ? t.subtotal! : tot / trs.length));
    }
  }
  return out;
}

// ── The dashboard (`flRenderDashboard`, `flBoardHTML`) ──

export type DashboardInput = {
  date: string; today: string;
  boats: readonly (BoatLite & { pier_on_date: string | null; blocked: boolean })[];
  jobs: readonly Job[]; incidents: readonly Incident[]; memos: readonly Memo[]; memosOf: (id: string) => LinkedMemo[];
  engines: readonly { id: string; boat_id: string | null; model: string | null; brand: string | null; hours: number }[];
  gearboxes: readonly { id: string; status: string; spare_location: string | null }[];
  propellers: readonly { id: string; status: string; spare_location: string | null }[];
  stock: readonly StockView[];
};
const MEMO_RANK: Record<string, number> = { paid: 4, received: 3, approved: 2, pending_approval: 1 };
export const SERVICE_INTERVAL = 500;

/** `GET /v1/fleet/dashboard?date=`: every tile legacy's dashboard draws. */
export function dashboard(input: DashboardInput) {
  const { date, today } = input;
  const own = company(input.boats);
  const boatById = new Map(input.boats.map((b) => [b.id, b]));
  const costOf = (j: Job) => jobCost(j.parts, input.memosOf(j.id)).cost;
  const blocks = (j: Job) => boatById.get(j.boat_id)?.blocked ?? false;

  const piers: Record<string, number> = { tublamu: 0, panwa: 0, ranong: 0 };
  for (const b of own) if (b.pier_on_date && b.pier_on_date in piers) piers[b.pier_on_date] += 1;

  const open = input.jobs.filter((j) => j.status !== 'done' && !j.parked_on);
  const card = (j: Job) => ({
    id: j.id, no: j.no, boat_id: j.boat_id, boat_name: boatById.get(j.boat_id)?.name ?? j.boat_id, title: j.title, owner: j.owner, due_date: j.due_date,
    late: !!(j.due_date && j.due_date < today), silent_days: silentDays(j, today), cost: costOf(j), blocks_boat: blocks(j),
    steps_done: j.steps.filter((s) => s.done).length, steps_total: j.steps.length, pinned: j.pinned,
  });
  const lanes: Record<string, ReturnType<typeof card>[]> = { decide: [], wait: [], doing: [], close: [] };
  for (const j of open) lanes[jobLane(j, blocks(j), today)].push(card(j));
  for (const l of Object.values(lanes)) l.sort((a, b) => Number(b.blocks_boat) - Number(a.blocks_boat) || b.silent_days - a.silent_days);
  const blocking = open.filter(blocks);
  const board = {
    boats_down: new Set(blocking.map((j) => j.boat_id)).size, company_boats: own.length, money_tied: round2(blocking.reduce((s, j) => s + costOf(j), 0)),
    open: open.length, silent_over_60: open.filter((j) => silentDays(j, today) > 60).length, no_owner: open.filter((j) => !j.owner).length,
    parked: input.jobs.filter((j) => j.parked_on && j.status !== 'done').length, lanes,
  };

  const openJobs = input.jobs.filter((j) => j.status !== 'done');
  const jobById = new Map(input.jobs.map((j) => [j.id, j]));
  const openIncidents = input.incidents.filter((i) => {
    if (i.status !== 'open' && i.status !== 'inprogress') return false;
    const linked = [i.job_id, ...i.related_job_ids].filter((x): x is string => !!x).map((x) => jobById.get(x)).filter((x): x is Job => !!x);
    return !(linked.length && linked.every((j) => j.status === 'done'));
  });
  const pending = own.map((b) => {
    const jobs = openJobs.filter((j) => j.boat_id === b.id);
    const incs = openIncidents.filter((i) => i.boat_id === b.id);
    const memos = new Map<string, { job_id: string; no: string; status: string; amount: number }>();
    for (const m of input.memos) {
      if (!m.job_id || !jobs.some((j) => j.id === m.job_id) || m.status === 'cancelled') continue;
      const key = `${m.job_id}|${m.no}`;
      const was = memos.get(key);
      if (!was || (MEMO_RANK[m.status] ?? 0) > (MEMO_RANK[was.status] ?? 0)) memos.set(key, { job_id: m.job_id, no: m.no, status: m.status, amount: m.after_discount || m.amount || m.subtotal });
    }
    return {
      boat_id: b.id, name: b.name, pier: b.pier_on_date, jobs: jobs.length, incidents: incs.length, load: jobs.length + incs.length,
      cost: round2(jobs.reduce((s, j) => s + costOf(j), 0)), oldest_days: Math.max(0, ...jobs.map((j) => (j.start_date ? dayGap(j.start_date, today) : 0))),
      job_list: jobs.map((j) => ({ id: j.id, no: j.no, title: j.title, status: j.status })), memos: [...memos.values()],
    };
  });
  const loaded = pending.filter((p) => p.load > 0).sort((a, b) => b.load - a.load || b.oldest_days - a.oldest_days || b.cost - a.cost);

  const models = new Map<string, number>();
  for (const e of input.engines) models.set(e.model ?? '—', (models.get(e.model ?? '—') ?? 0) + 1);
  const brandPct = (re: RegExp) => (input.engines.length ? r0((input.engines.filter((e) => re.test(e.brand ?? '')).length / input.engines.length) * 100) : 0);
  const spares = [...input.gearboxes.map((g) => ({ ...g, kind: 'gearbox' })), ...input.propellers.map((p) => ({ ...p, kind: 'propeller' }))].filter((x) => x.spare_location || x.status === 'spare');
  const onBoard = spares.filter((x) => (x.spare_location ?? '').startsWith('boat:'));
  const low = input.stock.filter((i) => !i.deleted_at && !i.merged_into && i.below_min).sort((a, b) => a.total_qty / (a.min_qty || 1) - b.total_qty / (b.min_qty || 1));
  const service = input.engines.filter((e) => e.boat_id && boatById.has(e.boat_id)).map((e) => {
    const pct = ((e.hours % SERVICE_INTERVAL) / SERVICE_INTERVAL) * 100;
    return { engine_id: e.id, boat_id: e.boat_id, boat_name: boatById.get(e.boat_id!)!.name, model: e.model, hours: round2(e.hours), remaining: round2((Math.floor(e.hours / SERVICE_INTERVAL) + 1) * SERVICE_INTERVAL - e.hours), pct: r0(pct), critical: pct >= 95 };
  }).filter((e) => e.pct >= 70).sort((a, b) => b.pct - a.pct);
  const trend = monthsEnding(date.slice(0, 7), 6).map((month) => {
    const list = input.jobs.filter((j) => monthOf(j.start_date ?? j.end_date) === month);
    return { month, cost: round2(list.reduce((s, j) => s + costOf(j), 0)), jobs: list.length };
  });
  const pendingMemos = input.memos.filter((m) => m.status === 'pending_approval');
  const ordered = input.memos.filter((m) => m.status === 'ordered');

  return {
    date, piers, board,
    pending_work: { boats: loaded, clear: pending.filter((p) => p.load === 0).map((p) => ({ boat_id: p.boat_id, name: p.name })), boats_with_work: loaded.length, company_boats: own.length,
      open_jobs: openJobs.length, total_jobs: input.jobs.length, open_cost: round2(openJobs.reduce((s, j) => s + costOf(j), 0)) },
    engines: { total: input.engines.length, by_model: [...models].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n), honda_pct: brandPct(/honda/i), suzuki_pct: brandPct(/suzuki/i) },
    spares: { total: spares.length, gearboxes: spares.filter((x) => x.kind === 'gearbox').length, propellers: spares.filter((x) => x.kind === 'propeller').length,
      on_board: onBoard.length, on_board_boats: new Set(onBoard.map((x) => x.spare_location)).size, in_repair: spares.filter((x) => (x.spare_location ?? '').startsWith('shop:')).length },
    low_stock: { count: low.length, top: low.slice(0, 3).map((i) => ({ id: i.id, part_no: i.part_no, name: i.name, qty: i.total_qty, min_qty: i.min_qty })) },
    memos: { pending: pendingMemos.length, pending_amount: round2(pendingMemos.reduce((s, m) => s + m.amount, 0)), ordered: ordered.length,
      chips: [...pendingMemos.map((m) => ({ id: m.id, no: m.no, status: m.status, amount: m.amount })), ...ordered.map((m) => ({ id: m.id, no: m.no, status: m.status, amount: m.amount }))].slice(0, 2) },
    incidents: { open: openIncidents.length, top: [...openIncidents].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3)
      .map((i) => ({ id: i.id, no: i.no, boat_id: i.boat_id, title: i.title, date: i.date, severity: i.severity, job_id: i.job_id })) },
    service_due: { interval: SERVICE_INTERVAL, count: service.length, engines: service.slice(0, 5) },
    cost_trend: { months: trend, total: round2(trend.reduce((s, m) => s + m.cost, 0)), jobs: trend.reduce((s, m) => s + m.jobs, 0) },
  };
}

/** `GET /v1/fleet/repair-history?boat_id=`: the boat's done jobs in legacy's `repairHistory` row shape, latest first. */
export function repairHistory(jobs: readonly Job[], memosOf: (id: string) => LinkedMemo[], boatId: string) {
  return jobs.filter((j) => j.boat_id === boatId && j.status === 'done')
    .sort((a, b) => (b.end_date ?? '').localeCompare(a.end_date ?? '') || b.no.localeCompare(a.no))
    .map((j) => ({
      job_id: j.id, job_no: j.no, date: j.end_date, title: j.title, detail: j.detail, type: j.type, location: j.location, cost: jobCost(j.parts, memosOf(j.id)).cost,
      assets: j.assets.map((a) => a.label), start_date: j.start_date, end_date: j.end_date, outcome: j.outcome, close_note: j.close_note,
    }));
}
