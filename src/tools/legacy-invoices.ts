/**
 * Legacy's invoices and payments as rows for migration 045 (todo/money-model.md slice 1). Pure, so
 * `test/legacy-invoices.test.ts` checks the mapping on fixture rows; `import-legacy.ts` writes what
 * this returns, replacing every invoice and payment it imported before.
 *
 * What legacy never stored stays empty: when, by whom and why an invoice was voided; who recorded a
 * payment. Its stored status is not imported: the payments decide it here (`invoices.ts`), and
 * `statusDiffers` counts the invoices where the two disagree. Legacy kept no lines for a booking
 * invoice: it showed the booking's price of the day. The line is rebuilt with the amount legacy
 * froze at issue (its subtotal), so the total never moves.
 */
import { invoiceState, livePayments, type StoredPayment } from '../domain/invoices.js';
import { todayInThailand } from '../domain/calendar.js';
import type { Report } from './legacy-records.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const money = (value: unknown): number | null => (str(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value));

export type LegacyMoney = { invoices: Row[]; bookingIds: Row[]; lineItems: Row[]; payments: Row[] };
export type MoneyContext = {
  prefix: string;
  /** Imported bookings by their id here, with what a line's label shows. */
  bookings: ReadonlyMap<string, { voucher_ref: string | null; legacy_id: string; route_id: string; service_date: string }>;
  agents: ReadonlySet<string>;
  files: ReadonlySet<string>;
  routeName: (id: string) => string | undefined;
};
export type MoneyRows = { invoices: Row[]; lines: Row[]; payments: Row[]; slips: Row[]; statusDiffers: Map<string, number> };

export function mapLegacyMoney(src: LegacyMoney, ctx: MoneyContext, report: Report): MoneyRows {
  const out: MoneyRows = { invoices: [], lines: [], payments: [], slips: [], statusDiffers: new Map() };
  const bookingsOf = new Map<string, string[]>();
  for (const r of [...src.bookingIds].sort((a, b) => Number(a.idx) - Number(b.idx))) {
    const id = str(r.sb_invoices_id);
    bookingsOf.set(id, [...(bookingsOf.get(id) ?? []), str(r.value)]);
  }
  const itemsOf = new Map<string, Row[]>();
  for (const r of [...src.lineItems].sort((a, b) => Number(a.idx) - Number(b.idx))) itemsOf.set(str(r.sb_invoices_id), [...(itemsOf.get(str(r.sb_invoices_id)) ?? []), r]);

  const numbers = new Set<string>();
  const legacyStatus = new Map<string, string>();
  const totals = new Map<string, { voided: boolean; total: number }>();
  const ordered = [...src.invoices].sort((a, b) => (str(a.issuedat) === str(b.issuedat) ? (str(a.id) < str(b.id) ? -1 : 1) : str(a.issuedat) < str(b.issuedat) ? -1 : 1));
  for (const inv of ordered) {
    const legacyId = str(inv.id);
    const issued = instant(inv.issuedat);
    if (!issued) { report.skip('invoice', legacyId, 'no readable issue time'); continue; }
    const feeType = str(inv.feetype);
    if (feeType && feeType !== 'cancellation' && feeType !== 'reschedule') { report.skip('invoice', legacyId, `fee type ${feeType}`); continue; }
    const subtotal = money(inv.subtotal), total = money(inv.total);
    if (subtotal === null || total === null) { report.skip('invoice', legacyId, 'no subtotal or total'); continue; }
    const legacyBookings = bookingsOf.get(legacyId) ?? [];
    if (!feeType && legacyBookings.length !== 1) { report.skip('invoice', legacyId, `${legacyBookings.length} bookings: legacy kept no amount per booking`); continue; }
    // Two invoices with one number (legacy numbered in the browser): the later one gets a suffix.
    let number = str(inv.number) || legacyId;
    for (let k = 2; numbers.has(number); k += 1) number = `${str(inv.number)}-${k}`;
    if (number !== str(inv.number)) report.note('invoice numbers given a suffix: a duplicate in legacy');
    numbers.add(number);

    const id = ctx.prefix + legacyId;
    const agent = str(inv.agentid);
    if (agent && !ctx.agents.has(agent)) report.note('invoice agents not in the catalogue (kept without one)');
    const vatMode = str(inv.vatmode);
    if (!vatMode) report.note('invoices with no VAT mode (issued before legacy recorded one)');
    const note = str(inv.note);
    out.invoices.push({
      id, number, agent_id: agent && ctx.agents.has(agent) ? agent : null,
      kind: feeType ? 'fee' : note === 'prepay' ? 'prepay' : 'booking', fee_type: feeType || null,
      vat_mode: vatMode === 'none' || vatMode === 'include' || vatMode === 'exclude' ? vatMode : null, vat_rate: money(inv.vatrate),
      subtotal, net_amount: money(inv.netamount), vat_amount: money(inv.vatamount), total, wht_amount: null,
      issued_at: issued, due_at: instant(inv.dueat) ?? issued, note: note === 'prepay' ? null : note || null,
      voided: str(inv.status) === 'void', created_by: str(inv.createdby) || null,
    });
    legacyStatus.set(id, str(inv.status));
    totals.set(id, { voided: str(inv.status) === 'void', total });

    const bookingOf = (legacyBooking: string): string | null => {
      const here = ctx.prefix + legacyBooking;
      if (ctx.bookings.has(here)) return here;
      report.note('invoice lines whose booking was not imported (kept without one)');
      return null;
    };
    if (feeType) {
      const bookingId = legacyBookings[0] ? bookingOf(legacyBookings[0]) : null;
      (itemsOf.get(legacyId) ?? []).forEach((item, seq) => out.lines.push({ invoice_id: id, seq, booking_id: bookingId, label: str(item.label) || 'Fee', amount: money(item.amount) ?? 0, discount: null }));
      if (!itemsOf.get(legacyId)?.length) out.lines.push({ invoice_id: id, seq: 0, booking_id: bookingId, label: note || 'Fee', amount: subtotal, discount: null });
    } else {
      const bookingId = bookingOf(legacyBookings[0]);
      const b = bookingId ? ctx.bookings.get(bookingId) : undefined;
      const label = b ? [b.voucher_ref ?? b.legacy_id, ctx.routeName(b.route_id) ?? b.route_id, b.service_date].join(' · ') : legacyBookings[0];
      out.lines.push({ invoice_id: id, seq: 0, booking_id: bookingId, label, amount: subtotal, discount: null });
    }
  }

  const imported = new Set(out.invoices.map((i) => String(i.id)));
  const paid = new Map<string, StoredPayment[]>();
  for (const p of src.payments) {
    const legacyId = str(p.id);
    const invoiceId = ctx.prefix + str(p.invoiceid);
    if (!imported.has(invoiceId)) { report.skip('payment', legacyId, `invoice ${str(p.invoiceid)} not imported`); continue; }
    if (str(p.type) && str(p.type) !== 'payment') { report.skip('payment', legacyId, `type ${str(p.type)}`); continue; }
    const amount = money(p.amount), at = instant(p.date), method = str(p.method);
    if (amount === null || amount <= 0) { report.skip('payment', legacyId, 'amount not above 0'); continue; }
    if (!at) { report.skip('payment', legacyId, 'no readable date'); continue; }
    if (method !== 'transfer' && method !== 'cash' && method !== 'card') { report.skip('payment', legacyId, `method ${method || '(blank)'}`); continue; }
    const row = { id: ctx.prefix + legacyId, invoice_id: invoiceId, amount, method, paid_on: todayInThailand(new Date(at)), ref: null, recorded_by: null, recorded_at: at };
    out.payments.push(row);
    let refs: unknown = [];
    try { refs = str(p.slips) ? JSON.parse(str(p.slips)) : []; } catch { report.note('payment slips dropped: unreadable JSON'); }
    (Array.isArray(refs) ? refs : []).forEach((ref) => {
      const fileId = str((ref as Row)?.id);
      if (!fileId || !ctx.files.has(fileId)) { report.note('payment slips dropped: the file is not here (run import:attachments first, or legacy lost it)'); return; }
      out.slips.push({ payment_id: row.id, seq: out.slips.filter((s) => s.payment_id === row.id).length, attachment_id: fileId });
    });
    paid.set(invoiceId, [...(paid.get(invoiceId) ?? []), { ...row, method: method as StoredPayment['method'], deleted_at: null, deleted_by: null, delete_reason: null, slips: [] }]);
  }
  for (const [id, legacy] of legacyStatus) {
    const t = totals.get(id)!;
    const computed = invoiceState(t, livePayments(paid.get(id) ?? []).reduce((s, p) => s + p.amount, 0)).status;
    if (computed !== legacy) out.statusDiffers.set(`${legacy || '(blank)'} → ${computed}`, (out.statusDiffers.get(`${legacy || '(blank)'} → ${computed}`) ?? 0) + 1);
  }
  return out;
}
