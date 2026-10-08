/**
 * What a booking waits for before it is confirmed, and the rule that decides a booking's status.
 *
 * Legacy decides the status in the browser when a booking is saved (`bkV2SubmitBooking`,
 * `bkV2CommitBooking`): the user presses "Save as quote" or "Confirm", and the save turns that into
 * `quote`, `confirmed`, `pending_foc` or `pending_approval` from the facts. Here the client sends
 * only which it was — the **intent** — and the server decides (todo/booking-authority-model.md,
 * phase 2). Pure, so both stores decide identically.
 */
import { holdsSeats, type BookingStatus } from './booking-status.js';
import type { HistoryLine } from './booking-actions.js';

const refuse = (message: string, statusCode: number, code?: string): never => {
  const error = new Error(message) as Error & { statusCode: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  throw error;
};

/** The two save buttons: "Save as quote" and "Confirm". */
export const INTENTS = ['quote', 'confirm'] as const;
export type Intent = typeof INTENTS[number];

/** `approval`: over the allotment and/or a discount (legacy `approval`). `foc`: free passengers (legacy `focApproval`). */
export type ApprovalKind = 'approval' | 'foc';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'replaced';
/**
 * A day an over-allotment approval is about: the seats asked for, how many the allotment lacks, and
 * the registered seats left when it was asked (legacy `licFree`, "Real seats left"; never below
 * `need`). `licensed_free` is null on a day recorded before migration 025.
 */
export type ApprovalDay = { route_id: string; service_date: string; need: number; over_by: number; licensed_free: number | null };

export type BookingApproval = {
  kind: ApprovalKind; status: ApprovalStatus;
  over_capacity: boolean; over_total: number | null; discount: number | null; foc_count: number | null;
  target_status: BookingStatus;
  requested_by: string | null; requested_at: string; decided_by: string | null; decided_at: string | null; note: string | null;
  days: ApprovalDay[];
};
/** An approval about to be asked for. The store supplies `requested_at`; it starts `pending`. */
export type NewApproval = Omit<BookingApproval, 'status' | 'requested_at' | 'decided_by' | 'decided_at' | 'note'>;

/** The approval of `kind` still waiting, if any. A booking has at most one per kind: asking again replaces it. */
export const pendingApproval = (approvals: readonly BookingApproval[] | undefined, kind: ApprovalKind): BookingApproval | undefined =>
  [...(approvals ?? [])].reverse().find((a) => a.kind === kind && a.status === 'pending');

/**
 * Whether a booking holds its seats. Released statuses never do. A `pending_approval` booking that
 * is **over the allotment** does not either, while it waits: it has not been granted those seats,
 * and counting them would let it consume the very room it is waiting for (legacy `bkPendHoldsSeat`).
 * One waiting only for a discount approval does hold them, and so does one with no approval record
 * at all — legacy's seven imported `pending_approval` bookings, which legacy reads the same way.
 *
 * PostgreSQL's seat count applies the same rule in SQL (`WAITING_FOR_SEATS` in
 * `postgres-operations.ts`); the suite runs on both stores to keep them equal.
 */
export function bookingHoldsSeats(booking: { status: BookingStatus; approvals?: readonly BookingApproval[] }): boolean {
  if (!holdsSeats(booking.status)) return false;
  if (booking.status !== 'pending_approval') return true;
  return !pendingApproval(booking.approvals, 'approval')?.over_capacity;
}

/** Free (FOC) passengers across every trip. */
export const focCountOf = (trips: readonly { pax: readonly { category: string; count: number }[] }[]): number =>
  trips.reduce((sum, trip) => sum + trip.pax.filter((row) => row.category === 'foc').reduce((n, row) => n + row.count, 0), 0);

/**
 * The discount a booking carries, as a positive amount. Read from `price_discount` as the client
 * sent it (stored negative) until the server prices bookings itself.
 */
export const discountOf = (header: { price_discount?: number | null }): number => Math.abs(Number(header.price_discount ?? 0)) || 0;

/** What a status is decided from. `overDays` are the days over the allotment but within the licence. */
export type StatusFacts = { focCount: number; focReason?: string | null; discount: number; overDays: readonly ApprovalDay[] };
export type StatusDecision = { status: BookingStatus; approvals: NewApproval[]; history: HistoryLine[] };

const line = (by: string | undefined, kind: string, tag: string, text: string): HistoryLine => ({ by: by ?? null, kind, tag, text });
const baht = (amount: number): string => `฿${Math.round(amount).toLocaleString('en-US')}`;

/**
 * Legacy's save, decided here:
 *
 * - **Save as quote** → `quote`. **Confirm** → `confirmed`, or `pending_foc` when free passengers
 *   need an FOC approval first; confirming FOC passengers needs an FOC reason.
 * - Over the allotment on any day (within the licence; over it was refused before this) → the
 *   booking waits in `pending_approval`, holding no seats.
 * - A discount on a confirm → `pending_approval` too, approved by the agent's salesperson.
 * - When an approval is asked for, it remembers where the booking would otherwise have gone
 *   (`target_status`); approving moves it there.
 */
export function decideStatus(intent: Intent, facts: StatusFacts, by: string | undefined): StatusDecision {
  if (intent === 'confirm' && facts.focCount > 0 && !facts.focReason?.trim()) {
    refuse('foc_reason is required to confirm FOC (free) passengers', 400);
  }
  const base: BookingStatus = intent === 'quote' ? 'quote' : facts.focCount > 0 ? 'pending_foc' : 'confirmed';
  const approvals: NewApproval[] = [];
  const history: HistoryLine[] = [];
  const asker = by ?? null;

  if (intent === 'confirm' && facts.focCount > 0) {
    approvals.push({ kind: 'foc', over_capacity: false, over_total: null, discount: null, foc_count: facts.focCount, target_status: 'confirmed', requested_by: asker, days: [] });
  }
  const overCapacity = facts.overDays.length > 0;
  const discount = intent === 'confirm' && facts.discount > 0;
  if (overCapacity || discount) {
    const overTotal = facts.overDays.reduce((sum, day) => sum + day.over_by, 0);
    approvals.push({
      kind: 'approval', over_capacity: overCapacity, over_total: overCapacity ? overTotal : null, discount: discount ? facts.discount : null,
      foc_count: null, target_status: base, requested_by: asker, days: facts.overDays.map((day) => ({ ...day })),
    });
    const why = [
      ...(overCapacity ? [`over the allotment by ${overTotal} (${facts.overDays.map((d) => `${d.route_id} ${d.service_date} +${d.over_by}`).join(', ')})`] : []),
      ...(discount ? [`discount ${baht(facts.discount)}`] : []),
    ];
    history.push(line(by, 'approval', 'Approval', `Waiting for approval · ${why.join(' · ')}`));
    return { status: 'pending_approval', approvals, history };
  }
  if (base === 'pending_foc') history.push(line(by, 'foc', 'FOC', `Waiting for FOC approval · ${facts.focCount} FOC pax`));
  return { status: base, approvals, history };
}

/**
 * What an amendment that changes the itinerary does to the status, given the days now over the
 * allotment. `undefined` when nothing changes.
 *
 * - A booking holding its seats that grows past the allotment starts waiting: `pending_approval`,
 *   remembering where it was (`target_status`).
 * - A booking already waiting (over the allotment, holding nothing) is weighed again: still over →
 *   a new approval replaces the old one; fits now → it goes where it was going, unless a discount
 *   still needs approving.
 *
 * A discount on the waiting approval is carried over: an edit does not re-ask for it, and does not
 * clear it either. (Legacy re-asks on every "Confirm" save of a discounted booking; this service
 * weighs the discount when the booking is created or confirmed — todo/booking-authority-model.md.)
 */
export function reweigh(
  current: { status: BookingStatus; approvals?: readonly BookingApproval[] }, overDays: readonly ApprovalDay[], by: string | undefined,
): { status: BookingStatus; request?: NewApproval; history: HistoryLine[] } | undefined {
  const pending = current.status === 'pending_approval' ? pendingApproval(current.approvals, 'approval') : undefined;
  const target: BookingStatus = pending?.target_status ?? (current.status === 'pending_approval' ? 'confirmed' : current.status);
  const discount = pending?.discount ?? null;
  const asker = by ?? null;
  if (overDays.length === 0) {
    if (!pending?.over_capacity) return undefined;
    if (discount) {
      return {
        status: 'pending_approval',
        request: { kind: 'approval', over_capacity: false, over_total: null, discount, foc_count: null, target_status: target, requested_by: asker, days: [] },
        history: [line(by, 'approval', 'Approval', `Fits the allotment now · still waiting for approval · discount ${baht(discount)}`)],
      };
    }
    return { status: target, history: [line(by, 'approval', 'Approval', `Fits the allotment now · ${target}`)] };
  }
  const overTotal = overDays.reduce((sum, day) => sum + day.over_by, 0);
  return {
    status: 'pending_approval',
    request: {
      kind: 'approval', over_capacity: true, over_total: overTotal, discount, foc_count: null, target_status: target, requested_by: asker,
      days: overDays.map((day) => ({ ...day })),
    },
    history: [line(by, 'approval', 'Approval', `Waiting for approval · over the allotment by ${overTotal} (${overDays.map((d) => `${d.route_id} ${d.service_date} +${d.over_by}`).join(', ')})`)],
  };
}

/** A decision on a booking that had no approval record to decide (legacy's imported `pending_*` bookings): recorded for the audit trail. */
export function decidedRecord(
  kind: ApprovalKind, status: 'approved' | 'rejected', target: BookingStatus, focCount: number, by: string | undefined, now: string, note: string | null,
): BookingApproval {
  return {
    kind, status, over_capacity: false, over_total: null, discount: null, foc_count: kind === 'foc' ? focCount : null, target_status: target,
    requested_by: null, requested_at: now, decided_by: by ?? null, decided_at: now, note, days: [],
  };
}

/** A day an approval puts a booking over the boats' registered seats: legacy approves it with a warning ("add a boat"). */
export type ApprovalWarning = { code: 'over_licence'; route_id: string; service_date: string; over_by: number };

/** Approval days in the order both stores list them. */
export const sortApprovalDays = (days: readonly ApprovalDay[]): ApprovalDay[] =>
  [...days].sort((a, b) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : a.route_id < b.route_id ? -1 : a.route_id > b.route_id ? 1 : 0));

/**
 * `intent`, or the deprecated `status` it replaces on create. `quote`/`draft` mean "Save as quote";
 * `confirmed`/`pending_foc` mean "Confirm" — the server still decides the final status. Any other
 * status cannot be asked for on create. `viaStatus` says the deprecated field was used, so the route
 * can log it until both clients send `intent`.
 */
export function parseIntent(input: { intent?: unknown; status?: unknown }): { intent: Intent; viaStatus: boolean } {
  const fromStatus = (status: unknown): Intent => {
    if (status === 'quote' || status === 'draft') return 'quote';
    if (status === 'confirmed' || status === 'pending_foc') return 'confirm';
    return refuse(`status ${String(status)} cannot be asked for on create: send intent quote or confirm, and the server decides the status`, 400);
  };
  if (input.intent !== undefined && input.intent !== null) {
    if (!(INTENTS as readonly unknown[]).includes(input.intent)) refuse('intent must be quote or confirm', 400);
    if (input.status !== undefined && input.status !== null && fromStatus(input.status) !== input.intent) {
      refuse(`intent ${String(input.intent)} and status ${String(input.status)} disagree: send intent alone`, 400);
    }
    return { intent: input.intent as Intent, viaStatus: false };
  }
  if (input.status === undefined || input.status === null) return { intent: 'confirm', viaStatus: false };
  return { intent: fromStatus(input.status), viaStatus: true };
}
