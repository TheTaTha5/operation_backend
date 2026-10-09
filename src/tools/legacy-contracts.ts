/**
 * Legacy's `sb_contracts` rows, with their `__programperiods`, as this service's contracts
 * (todo/contracts-model.md, migration 029). Pure, so `test/legacy-contracts.test.ts` checks the
 * mapping without a legacy database; `import-contracts.ts` reads the source and writes these.
 *
 * Legacy's pricing is copied as it is (decided 2026-10-09), so a row is changed only where the
 * schema cannot hold it, and only where legacy would price the same either way: a contract whose
 * agent is gone is skipped, a rate type that no longer exists becomes none, a period whose window
 * runs backwards (it can never match) is dropped. Each is noted.
 */
import type { Contract, ContractPeriod, ContractSeatPrice } from '../domain/contracts.js';

type Row = Record<string, unknown>;
export type ContractCatalogue = { agentIds: ReadonlySet<string>; rateTypeIds: ReadonlySet<string>; routeIds: ReadonlySet<string> };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (value: unknown): string | null => { const s = value == null ? '' : String(value).trim(); return s || null; };
const json = (value: unknown): unknown => { const s = str(value); if (!s) return null; try { return JSON.parse(s); } catch { return undefined; } };
/** Legacy's own-price keys, in the booking pax vocabulary rate types use. */
const PRICE_KEYS: Record<string, Pick<ContractSeatPrice, 'category' | 'residency'>> = {
  'adult-thai': { category: 'ad', residency: 'thai' }, 'child-thai': { category: 'chd', residency: 'thai' },
  'adult-fr': { category: 'ad', residency: 'foreign' }, 'child-fr': { category: 'chd', residency: 'foreign' },
};

export function contractFromLegacy(row: Row, periodRows: readonly Row[], catalogue: ContractCatalogue): { contract: Contract; notes: string[] } | { skip: string } {
  const id = str(row.id);
  if (!id) return { skip: 'no id' };
  const agentId = str(row.agentid);
  if (!agentId || !catalogue.agentIds.has(agentId)) return { skip: `agent ${agentId ?? '(none)'} does not exist` };
  const kind = row.kind === 'main' || row.kind === 'promo' ? row.kind : undefined;
  if (!kind) return { skip: `kind ${String(row.kind)} is neither main nor promo` };
  const status = row.status === 'active' || row.status === 'expired' || row.status === 'void' ? row.status : undefined;
  if (!status) return { skip: `status ${String(row.status)} is not active, expired or void` };
  const notes: string[] = [];
  const day = (value: unknown, name: string): string | null => {
    const s = str(value);
    if (s && !ISO_DAY.test(s)) { notes.push(`${name} ${s} is not a date: dropped`); return null; }
    return s;
  };

  let rateTypeId = str(row.ratetypeid);
  if (rateTypeId && !catalogue.rateTypeIds.has(rateTypeId)) { notes.push(`rate type ${rateTypeId} does not exist: none`); rateTypeId = null; }

  // Legacy reads a promo with no price mode as 'rate' (`c.priceMode || 'rate'`).
  const mode = kind === 'promo' ? (str(row.pricemode) ?? 'rate') : null;
  if (mode !== null && mode !== 'rate' && mode !== 'own' && mode !== 'discount') return { skip: `price mode ${mode} is unknown` };

  let discount: Contract['discount'] = null;
  if (mode === 'discount') {
    const d = json(row.discount) as { mode?: unknown; value?: unknown } | null | undefined;
    const value = Number(d?.value);
    if (!(value > 0)) return { skip: 'a discount promo without a discount above 0 (legacy prices it as no promo)' };
    discount = { mode: d?.mode === 'amt' ? 'amt' : 'pct', value };
  }

  let bonus: Contract['bonus'] = null;
  const b = json(row.bonus) as { on?: unknown; buy?: unknown; free?: unknown; basis?: unknown } | null | undefined;
  if (b && b.on && Number(b.buy) >= 1) bonus = { buy: Number(b.buy), free: Number(b.free) >= 1 ? Number(b.free) : 1, basis: str(b.basis) };

  const seatPrices: ContractSeatPrice[] = [];
  if (mode === 'own') {
    const rates = json(row.rates);
    if (rates === undefined) notes.push('own prices are not JSON: none');
    for (const [routeId, zones] of Object.entries((rates ?? {}) as Record<string, Record<string, Record<string, unknown>>>)) {
      if (!catalogue.routeIds.has(routeId)) { notes.push(`own prices for unknown route ${routeId}: dropped`); continue; }
      for (const [zone, cells] of Object.entries(zones ?? {})) {
        for (const [key, raw] of Object.entries(cells ?? {})) {
          const cell = PRICE_KEYS[key];
          const price = Number(raw);
          if (!cell || !Number.isFinite(price) || price < 0) { notes.push(`own price ${routeId}/${zone}/${key} = ${String(raw)}: dropped`); continue; }
          seatPrices.push({ route_id: routeId, zone, ...cell, price });
        }
      }
    }
  }

  const periods: ContractPeriod[] = [];
  for (const p of [...periodRows].sort((a, b) => Number(a.idx) - Number(b.idx))) {
    const routeId = str(p.routeid);
    const bookFrom = day(p.bookfrom, 'book_from'), bookTo = day(p.bookto, 'book_to');
    const travelFrom = day(p.travelfrom, 'travel_from'), travelTo = day(p.travelto, 'travel_to');
    const where = `period ${routeId ?? '?'} ${bookFrom ?? '?'}..${bookTo ?? '?'}`;
    if (!routeId || !catalogue.routeIds.has(routeId)) { notes.push(`${where}: unknown route, dropped`); continue; }
    if (!bookFrom || !bookTo) { notes.push(`${where}: no booking window, dropped`); continue; }
    if (bookTo < bookFrom || (travelFrom && travelTo && travelTo < travelFrom)) { notes.push(`${where}: window runs backwards (never matches), dropped`); continue; }
    periods.push({ route_id: routeId, book_from: bookFrom, book_to: bookTo, travel_from: travelFrom, travel_to: travelTo, note: str(p.note) });
  }

  let activeFrom = day(row.activefrom, 'active_from'), activeTo = day(row.activeto, 'active_to');
  if (activeFrom && activeTo && activeTo < activeFrom) { notes.push(`active ${activeFrom}..${activeTo} runs backwards: dates dropped`); activeFrom = activeTo = null; }

  return {
    contract: {
      id, agent_id: agentId, kind, status, rate_type_id: rateTypeId, active_from: activeFrom, active_to: activeTo,
      priority: Number(row.priority) || 0, version: str(row.version), price_mode: mode as Contract['price_mode'], discount, bonus,
      book_window: Boolean(Number(row.bookwin)), created_date: day(row.createddate, 'created_date'), created_by: str(row.createdby),
      note: str(row.note), doc_id: str(row.docid), voided_at: null, voided_by: null, program_periods: periods, seat_prices: seatPrices,
    },
    notes,
  };
}
