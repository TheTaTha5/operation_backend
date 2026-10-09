/**
 * Legacy's partner van bills, Transfer Fleet's van rates and the daily report's settings, as rows for
 * migration 120 (todo/money-model.md slices 5 and 6). Pure, so `test/legacy-van-bills.test.ts` checks
 * the mapping on fixture rows; `import-legacy.ts` writes what this returns.
 *
 * - `van_bill` (key `partner|YYYY-MM|period`, a JSON value) → `van_bills` and its route rates, row
 *   overrides and extra lines. Upserted on the address: staff inputs are replaced, the sent and paid
 *   state (ours; legacy had none) is kept. A key with four parts (`partner|van|month|period`) is an
 *   older shape legacy's own code no longer reads: skipped.
 * - `app_meta.van_rates` → `van_rates`, replaced whole; a route not in the catalogue is dropped.
 * - `app_meta.dr_cfg` → `daily_report_settings`; 0 or blank = the default.
 */
import type { Report } from './legacy-records.js';
import { VB_CODES, type ExtraLine, type RowOverride } from '../domain/van-bills.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const ROW_KEY = /^\d{4}-\d{2}-\d{2}~[^~]+~[^~]+(~R)?$/;
const isObject = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A money amount legacy kept (it stored them positive), or null when it kept none. */
const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(0, n) * 100) / 100 : null;
};
const count = (v: unknown, dflt: number): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : dflt; };
/** app_meta values are JSON text, sometimes JSON text of JSON text. */
export function metaJson(value: unknown): unknown {
  let v: unknown = value;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch { return undefined; } }
  return v;
}

export type ImportedVanBill = {
  partner: string; month: string; period: number; per_pax: number; rate: number; seen: string[] | null; updated_at: string | null; updated_by: string | null;
  route_rates: Record<string, number>; row_overrides: Record<string, RowOverride>; extra_lines: ExtraLine[];
};

export function mapLegacyVanBills(rows: readonly Row[], report: Report): ImportedVanBill[] {
  const out: ImportedVanBill[] = [];
  for (const r of rows) {
    const key = str(r.key ?? r.id);
    const parts = key.split('|');
    if (parts.length === 4) { report.skip('van bill', key, 'older key (partner|van|month|period): legacy no longer reads it'); continue; }
    const [partner, month, period] = parts.map((p) => p.trim());
    if (parts.length !== 3 || !partner || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !['1', '2', '3'].includes(period)) { report.skip('van bill', key, 'key is not partner|YYYY-MM|period'); continue; }
    const v = metaJson(r.value);
    if (!isObject(v)) { report.skip('van bill', key, 'value is not a JSON object'); continue; }
    const route_rates: Record<string, number> = {};
    for (const [code, rate] of Object.entries(isObject(v.rateC) ? v.rateC : {})) {
      const n = money(rate);
      if (!(VB_CODES as readonly string[]).includes(code)) { report.note(`van bill route rates dropped: code ${code}`); continue; }
      if (n !== null) route_rates[code] = n;
    }
    const row_overrides: Record<string, RowOverride> = {};
    for (const [rk, o] of Object.entries(isObject(v.rows) ? v.rows : {})) {
      if (!ROW_KEY.test(rk) || !isObject(o)) { report.note('van bill row overrides dropped: bad row key or value'); continue; }
      const ov = { rate: money(o.rate), ex: money(o.ex), cut: money(o.cut), per: money(o.per) };
      if (Object.values(ov).every((x) => x === null)) { report.note('van bill row overrides dropped: empty'); continue; }
      row_overrides[rk] = ov;
    }
    const ids = new Set<string>();
    const extra_lines: ExtraLine[] = (Array.isArray(v.extra) ? v.extra : []).filter(isObject).map((x, i) => {
      let id = str(x.id) || `x${i}`;
      while (ids.has(id)) id = `${id}_${i}`;
      ids.add(id);
      const date = str(x.date);
      if (date && !isDay(date)) report.note('van bill extra line dates dropped: not a date');
      return { id, date: isDay(date) ? date : null, note: str(x.note) || null, vans: count(x.van, 1), pax: count(x.pax, 0),
        rate: money(x.rate) ?? 0, ex: money(x.ex) ?? 0, cut: money(x.cut) ?? 0, per_pax: money(x.per) ?? 0 };
    });
    const seen = Array.isArray(v.seen) ? v.seen.map(str).filter((k) => ROW_KEY.test(k)) : null;
    out.push({
      partner, month, period: Number(period), per_pax: money(v.perPax) ?? 0, rate: money(v.rate) ?? 0, seen, updated_at: instant(v.at), updated_by: str(v.by) || null,
      route_rates, row_overrides, extra_lines,
    });
  }
  return out;
}

export type ImportedVanRate = { group_key: string; route_id: string | null; field: 'base' | 'PK' | 'KL'; rate: number };
export function mapLegacyVanRates(value: unknown, routes: ReadonlySet<string>, report: Report): ImportedVanRate[] {
  const v = metaJson(value);
  if (v === undefined || v === null) return [];
  if (!isObject(v)) { report.skip('van rates', 'van_rates', 'not a JSON object'); return []; }
  const out: ImportedVanRate[] = [];
  for (const [gk, g] of Object.entries(v)) {
    if (!(gk === 'own' || (gk.startsWith('p:') && gk.length > 2)) || !isObject(g)) { report.skip('van rates', gk, 'not a van group'); continue; }
    const base = money(g.base);
    if (base !== null) out.push({ group_key: gk, route_id: null, field: 'base', rate: base });
    for (const [rid, cells] of Object.entries(isObject(g.rt) ? g.rt : {})) {
      if (!routes.has(rid)) { report.note(`van rates dropped: route ${rid} not in catalogue`); continue; }
      if (!isObject(cells)) continue;
      for (const field of ['base', 'PK', 'KL'] as const) {
        const n = money(cells[field]);
        if (n !== null) out.push({ group_key: gk, route_id: rid, field, rate: n });
      }
    }
  }
  return out;
}

export function mapLegacyDailySettings(value: unknown): { van_cost: number | null; van_quota: number | null; target_per_pax: number | null } | null {
  const v = metaJson(value);
  if (!isObject(v)) return null;
  const pos = (x: unknown) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  return { van_cost: pos(v.vanCost), van_quota: pos(v.vanQuota), target_per_pax: pos(v.targetPerPax) };
}
