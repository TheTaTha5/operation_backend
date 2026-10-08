/**
 * Legacy's approvals as rows for `booking_approvals` and `booking_approval_days`
 * (todo/approvals-import-model.md, approved 2026-10-08). Pure, so `test/legacy-approvals.test.ts`
 * checks the mapping on fixture rows; `import-legacy.ts` writes what these return.
 *
 * Legacy keeps one approval of each kind on the booking row, overwritten by the next request:
 * `approval_*` (over the allotment and/or a discount) and `focapproval_*` (free passengers). Each
 * becomes one row here, replaced on every import like the booking's other children.
 *
 * What legacy itself never stored stays empty: an approval's discount amount and sale name, an FOC
 * rejection's reason. A request legacy left `pending` on a booking that no longer waits for it (a
 * quote saved with FOC passengers, a booking cancelled while waiting) is imported as it is and
 * counted: it holds nothing, because only a `pending_approval` booking is weighed by its approval.
 */
import { isBookingStatus } from '../domain/booking-status.js';
import type { Report } from './legacy-records.js';

type Row = Record<string, unknown>;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const instant = (value: unknown): string | null => { const s = str(value); return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const whole = (value: unknown): number | null => { if (str(value) === '') return null; const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null; };

/** A day an approval is about. `booking_id` and `kind` find the approval row once it has an id. */
export type ApprovalDayRow = { booking_id: string; kind: 'approval'; route_id: string; service_date: string; need: number; over_by: number; licensed_free?: number };

/**
 * The booking's approval rows and the days of its over-allotment approval.
 *
 * `fallbackAt` is when a request with no time of its own was asked: the booking's `booked_at`.
 * `withLicensedFree` writes legacy's `licFree` (the registered seats free when it was asked) to
 * `booking_approval_days.licensed_free`, on a schema that has the column (migration 025).
 */
export function approvalRows(
  booking: Row, bookingId: string, fallbackAt: string, report: Report, withLicensedFree = false,
): { approvals: Row[]; days: ApprovalDayRow[] } {
  const approvals: Row[] = [], days: ApprovalDayRow[] = [];
  const legacyId = str(booking.id);
  const stale = (kind: string, waitsIn: string) => {
    if (str(booking.status) !== waitsIn) report.note(`${kind} approvals still pending on a booking no longer ${waitsIn} (imported as is)`);
  };

  // ── over the allotment and/or a discount ──
  const status = str(booking.approval_status);
  if (status) {
    if (!STATUSES.has(status)) report.skip('approval', legacyId, `status ${status}`);
    else {
      const reason = str(booking.approval_reason) || null;
      let over: Row[] = [];
      const overText = str(booking.approval_over);
      if (overText) {
        try { const parsed = JSON.parse(overText); if (Array.isArray(parsed)) over = parsed as Row[]; else report.note('approval days dropped: approval_over is not a list'); }
        catch { report.note('approval days dropped: approval_over is not JSON'); }
      }
      for (const d of over) {
        const route = str(d.routeId), date = str(d.date), need = whole(d.need) ?? 0, overBy = whole(d.overBy) ?? 0;
        if (!route || !ISO_DAY.test(date) || need <= 0 || overBy <= 0) { report.note('approval days dropped: no route, bad date, or nothing over'); continue; }
        if (days.some((x) => x.route_id === route && x.service_date === date)) { report.note('approval days dropped: repeated day'); continue; }
        const row: ApprovalDayRow = { booking_id: bookingId, kind: 'approval', route_id: route, service_date: date, need, over_by: overBy };
        const free = whole(d.licFree);
        if (withLicensedFree && free !== null) row.licensed_free = free;
        days.push(row);
      }
      const overCapacity = /over_cap/.test(reason ?? '') || days.length > 0;
      let target = str(booking.approval_targetstatus) || 'confirmed';
      if (!isBookingStatus(target)) { report.note(`approval target "${target}" read as confirmed`); target = 'confirmed'; }
      if (!str(booking.approval_targetstatus)) report.note('approval target blank → confirmed');
      const decided = status !== 'pending';
      approvals.push({
        booking_id: bookingId, kind: 'approval', status, reason, over_capacity: overCapacity,
        over_total: overCapacity ? whole(booking.approval_totover) : null, discount: null, foc_count: null, target_status: target,
        requested_by: str(booking.approval_requestedby) || null, requested_at: instant(booking.approval_requestedat) ?? fallbackAt,
        decided_by: decided ? str(booking.approval_approvedby) || null : null, decided_at: decided ? instant(booking.approval_approvedat) : null,
        note: str(booking.approval_note) || null,
      });
      if (status === 'pending') stale('over-allotment/discount', 'pending_approval');
    }
  }

  // ── free (FOC) passengers ──
  const focStatus = str(booking.focapproval_status);
  if (focStatus) {
    if (!STATUSES.has(focStatus)) report.skip('FOC approval', legacyId, `status ${focStatus}`);
    else {
      const decided = focStatus !== 'pending';
      approvals.push({
        booking_id: bookingId, kind: 'foc', status: focStatus, reason: null, over_capacity: false, over_total: null, discount: null,
        foc_count: whole(booking.focapproval_count), target_status: 'confirmed',
        requested_by: str(booking.focapproval_requestedby) || null, requested_at: instant(booking.focapproval_requestedat) ?? fallbackAt,
        decided_by: decided ? str(booking.focapproval_approvedby) || null : null, decided_at: decided ? instant(booking.focapproval_approvedat) : null,
        note: null,
      });
      if (focStatus === 'pending') stale('FOC', 'pending_foc');
    }
  }
  return { approvals, days };
}

/** The booking's FOC reason: its own, else the one written on its FOC approval. */
export function focReason(booking: Row, report: Report): string | null {
  const own = str(booking.focreason);
  if (own) return own;
  const onApproval = str(booking.focapproval_reason);
  if (onApproval) { report.note('foc_reason taken from the FOC approval (focapproval_reason)'); return onApproval; }
  return null;
}
