/**
 * Legacy's pier money and after-trip decisions as rows for migrations 110–112 (todo/money-model.md
 * slices 2–4). Pure, so `test/legacy-pier-money.test.ts` checks the mapping on fixture rows;
 * `import-legacy.ts` writes what this returns. Every row hangs off an imported booking, so it goes
 * with it (`ON DELETE CASCADE`) and comes back on the next run: legacy stays master for money until
 * Money moves, as for invoices.
 *
 * - `sb_bookings.pierpayments` → `booking_pier_payments` (+ slips): ids `lg_`-prefixed. A card's fee is
 *   kept as legacy recorded it; `feePct` only on a card.
 * - `sb_extras` → `booking_tour_sales` (+ slips): `date` is when it was sold; a sale not `cot` counts
 *   as collected, with no time (legacy lost `collectedAt`).
 * - `ts_cot` → `booking_cot_decisions` (+ slips), `travel_sum` → `booking_noshow_charges`: keyed
 *   `<date>::<booking>`, imported as legacy has them (over the COT, on a day no longer travelled).
 * - Legacy lost `ops.pfm` on every save; its history lines say what was decided, so they become
 *   `booking_pfm_events`.
 */
import type { Report } from './legacy-records.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const num = (value: unknown): number | null => (str(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const json = (value: unknown): unknown => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
};
const list = (value: unknown): Row[] => { const v = json(value); return Array.isArray(v) ? v.filter((x): x is Row => x !== null && typeof x === 'object') : []; };
const slipId = (s: unknown): string => (typeof s === 'string' ? s : str((s as Row | null)?.id));

export type PierMoneyContext = {
  prefix: string;
  /** Imported bookings, by their id here. */
  bookings: ReadonlySet<string>;
  /** Attachments here (`import:attachments` copies legacy's files). */
  files: ReadonlySet<string>;
};
export type PierMoneyRows = {
  pierPayments: Row[]; pierSlips: Row[]; tourSales: Row[]; saleSlips: Row[]; cotDecisions: Row[]; cotSlips: Row[]; noshow: Row[]; pfmEvents: Row[];
};
export type LegacyPierMoney = { bookings: Row[]; extras: Row[]; tsCot: Row[]; travelSum: Row[]; history: Row[] };

export function mapLegacyPierMoney(src: LegacyPierMoney, ctx: PierMoneyContext, report: Report): PierMoneyRows {
  const out: PierMoneyRows = { pierPayments: [], pierSlips: [], tourSales: [], saleSlips: [], cotDecisions: [], cotSlips: [], noshow: [], pfmEvents: [] };
  const here = (legacyId: string): string | undefined => (ctx.bookings.has(ctx.prefix + legacyId) ? ctx.prefix + legacyId : undefined);
  const slips = (raw: unknown, what: string, row: (attachment: string, seq: number) => Row): Row[] => {
    const ids = (Array.isArray(raw) ? raw : list(raw)).map(slipId).filter(Boolean);
    const kept = ids.filter((id) => ctx.files.has(id));
    if (kept.length < ids.length) report.note(`${what} slips dropped: the file is not here (run import:attachments first, or legacy lost it)`);
    return kept.map((id, seq) => row(id, seq));
  };

  // ── Pier payments (bk.pierPayments) ──
  const seenPay = new Set<string>();
  for (const b of src.bookings) {
    const payments = list(b.pierpayments);
    if (!payments.length) continue;
    const bookingId = here(str(b.id));
    if (!bookingId) { report.skip('pier payment', str(b.id), 'booking not imported'); continue; }
    for (const p of payments) {
      const legacyId = str(p.id), id = ctx.prefix + legacyId, day = str(p.date), at = instant(p.at);
      const method = str(p.method), amount = num(p.amount), fee = num(p.fee) ?? 0;
      if (!legacyId || seenPay.has(id)) { report.skip('pier payment', `${str(b.id)}/${legacyId || '(no id)'}`, 'no id, or a second payment with it'); continue; }
      if (!isDay(day)) { report.skip('pier payment', legacyId, `bad date ${day || '(blank)'}`); continue; }
      if (!['cash', 'transfer', 'card'].includes(method)) { report.skip('pier payment', legacyId, `method ${method || '(blank)'}`); continue; }
      if (amount === null || amount <= 0) { report.skip('pier payment', legacyId, `amount ${str(p.amount) || '(blank)'}`); continue; }
      if (method !== 'card' && fee !== 0) { report.skip('pier payment', legacyId, `a fee on ${method}`); continue; }
      seenPay.add(id);
      const pct = method === 'card' ? num(p.feePct) : null;
      out.pierPayments.push({ id, booking_id: bookingId, service_date: day, method, amount, fee, fee_pct: pct, note: str(p.note) || null, by: str(p.by) || null,
        at: at ?? `${day}T00:00:00.000Z`, deleted_at: null, deleted_by: null, delete_reason: null });
      if (!at) report.note('pier payments with no time (their day, midnight UTC)');
      out.pierSlips.push(...slips(p.slips, 'pier payment', (attachment_id, seq) => ({ payment_id: id, seq, attachment_id })));
    }
  }

  // ── On-tour sales (SB_EXTRAS) ──
  for (const x of src.extras) {
    const legacyId = str(x.id), id = ctx.prefix + legacyId;
    const bookingId = here(str(x.bookingid));
    if (!bookingId) { report.skip('on-tour sale', legacyId, 'booking not imported'); continue; }
    const qty = num(x.qty) ?? 1, price = num(x.unitprice), total = num(x.total);
    if (!(price && price > 0) || !Number.isInteger(qty) || qty < 1) { report.skip('on-tour sale', legacyId, `qty ${str(x.qty)} × price ${str(x.unitprice)}`); continue; }
    if (total !== null && Math.abs(total - qty * price) > 0.005) report.note('on-tour sales whose total was not qty × unit price (worked out again)');
    const method = str(x.method) || 'cash';
    if (!['cash', 'transfer', 'card', 'cot'].includes(method)) { report.skip('on-tour sale', legacyId, `method ${method}`); continue; }
    const toCompany = Math.min(qty * price, Math.max(0, num(x.tocompany) ?? 0));
    const tripDay = str(x.tripdate);
    const soldAt = instant(x.date);
    if (!soldAt) { report.skip('on-tour sale', legacyId, 'no readable sale time'); continue; }
    const fee = method === 'card' ? num(x.fee) ?? 0 : 0;
    // Legacy §exCot: a `cot` sale is collected once settle is done; it then turned into cash.
    const collected = method !== 'cot' || str(x.settle) === 'done';
    if (method === 'cot' && collected) report.note('on-tour sales cot but settled (imported as cash, collected)');
    out.tourSales.push({
      id, booking_id: bookingId, trip_date: isDay(tripDay) ? tripDay : null, service: str(x.service) || 'Extra', qty, unit_price: price, to_company: toCompany,
      seller: str(x.seller) || null, method: method === 'cot' && collected ? 'cash' : method, fee_pct: method === 'card' ? num(x.feepct) ?? 0 : 0, fee,
      collected_at: null, collected_by: null, sold_at: soldAt, sold_by: null,
    });
    if (tripDay && !isDay(tripDay)) report.note('on-tour sales with a bad trip date (none kept)');
    out.saleSlips.push(...slips(x.slips, 'on-tour sale', (attachment_id, seq) => ({ sale_id: id, seq, attachment_id })));
  }

  // ── After the trip: TS_COT and travel_sum, keyed `<date>::<booking>` ──
  const keyed = (key: unknown): { day: string; bookingId?: string; legacy: string } => {
    const [day, legacy] = str(key).split('::');
    return { day: str(day), legacy: str(legacy), bookingId: here(str(legacy)) };
  };
  for (const c of src.tsCot) {
    const { day, bookingId, legacy } = keyed(c.key ?? c.id);
    if (!bookingId) { report.skip('COT decision', str(c.key), `booking ${legacy || '(blank)'} not imported`); continue; }
    if (!isDay(day)) { report.skip('COT decision', str(c.key), `bad date ${day}`); continue; }
    const mode = str(c.mode);
    if (!['full', 'part', 'none', 'payout', 'nocol'].includes(mode)) { report.skip('COT decision', str(c.key), `mode ${mode || '(blank)'}`); continue; }
    const at = instant(c.at);
    if (!at) { report.skip('COT decision', str(c.key), 'no readable time'); continue; }
    const by = str(c.by);
    out.cotDecisions.push({ booking_id: bookingId, service_date: day, mode, deduct: Math.max(0, num(c.deduct) ?? 0), payout: Math.max(0, num(c.payout) ?? 0),
      ref: str(c.ref) || null, by: by && by !== '—' ? by : null, at });
    out.cotSlips.push(...slips(c.slips, 'COT decision', (attachment_id, seq) => ({ booking_id: bookingId, service_date: day, seq, attachment_id })));
  }
  for (const t of src.travelSum) {
    const { day, bookingId, legacy } = keyed(t.key ?? t.id);
    if (!bookingId) { report.skip('no-show decision', str(t.key), `booking ${legacy || '(blank)'} not imported`); continue; }
    if (!isDay(day)) { report.skip('no-show decision', str(t.key), `bad date ${day}`); continue; }
    const decision = str(t.decision);
    if (!['full', 'partial', 'none', 'postpone'].includes(decision)) { report.skip('no-show decision', str(t.key), `decision ${decision || '(blank)'}`); continue; }
    const at = instant(t.at);
    if (!at) { report.skip('no-show decision', str(t.key), 'no readable time'); continue; }
    const by = str(t.by);
    out.noshow.push({ booking_id: bookingId, service_date: day, decision, amount: Math.max(0, num(t.amount) ?? 0), note: str(t.note) || null, by: by && by !== '—' ? by : null, at });
  }

  // ── Daily PFM decisions, from the history legacy wrote (`pfmApproveTravel`, `pfmHold`, `pfmRemindAll`) ──
  for (const h of src.history) {
    const text = str(h.text);
    if (!text.startsWith('PFM ')) continue;
    const bookingId = here(str(h.sb_bookings_id));
    if (!bookingId) continue;
    const at = instant(h.at);
    if (!at) { report.skip('PFM decision', str(h.sb_bookings_id), 'no readable time'); continue; }
    const by = str(h.by) || null;
    const extended = /^PFM unpaid · travel EXTENDED by (.*)$/.exec(text);
    if (extended) out.pfmEvents.push({ booking_id: bookingId, kind: 'approved', approver: extended[1].trim() || '—', by, at });
    else if (text === 'PFM unpaid · put on hold') out.pfmEvents.push({ booking_id: bookingId, kind: 'hold', approver: null, by, at });
    else if (text === 'PFM payment reminder sent') out.pfmEvents.push({ booking_id: bookingId, kind: 'reminded', approver: null, by, at });
    else report.note(`PFM history lines not understood: "${text.slice(0, 40)}"`);
  }
  return out;
}
