/**
 * Reconfirmation (slice B of todo/trip-ops-and-vans-model.md, migration 035): what the customer said
 * when staff checked their pickup, and whether the agent's list was sent. Two separate facts, as
 * legacy keeps them since §rcSplit: setting or clearing the status never touches "sent", and sending
 * never touches the status. Legacy `rcSetStatus`, `bkV2Reconfirm`, `bkV2ReconfirmClear`,
 * `rcSendAgent`, `rcUnsendAgent`, `rcToggleBooking`. Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import type { HistoryLine } from './booking-actions.js';

export const RECONFIRM_STATUSES = ['wa', 'noans', 'off', 'callback', 'done'] as const;
export const RECONFIRM_VIAS = ['reconfirm', 'phone', 'list'] as const;
export type ReconfirmStatus = typeof RECONFIRM_STATUSES[number];
export type ReconfirmVia = typeof RECONFIRM_VIAS[number];
/** As stored. `null` for the whole record = nothing recorded. */
export type StoredReconfirm = {
  status: ReconfirmStatus | null; via: ReconfirmVia | null; at: string | null; by: string | null;
  sent_at: string | null; sent_by: string | null;
};
/** As a booking read shows it: `sent` is whether the agent's list went out. */
export type Reconfirm = StoredReconfirm & { sent: boolean };

/** Legacy RC_STATES labels, used in the history line. */
const LABEL: Record<ReconfirmStatus, string> = {
  wa: 'WhatsApp sent · awaiting', noans: 'Called · no answer', off: 'Called · phone off', callback: 'Call back later', done: 'Confirmed',
};
const bad = (message: string): never => refuse(message, 400);

export const reconfirmView = (r: StoredReconfirm | null | undefined): Reconfirm | null => (r ? { ...r, sent: r.sent_at !== null } : null);

export function parseReconfirmStatus(body: Record<string, unknown>): { status: ReconfirmStatus; via: ReconfirmVia } {
  const status = (RECONFIRM_STATUSES as readonly unknown[]).includes(body.status) ? body.status as ReconfirmStatus
    : bad(`status must be one of ${RECONFIRM_STATUSES.join(', ')}; DELETE /v1/bookings/{id}/reconfirm clears it`);
  const via = body.via === undefined || body.via === null ? 'reconfirm'
    : (RECONFIRM_VIAS as readonly unknown[]).includes(body.via) ? body.via as ReconfirmVia : bad(`via must be one of ${RECONFIRM_VIAS.join(', ')}`);
  return { status: status!, via: via! };
}

/**
 * What the customer said, stamped now by the login. From the Re-confirm page (`via: reconfirm`) whether
 * the list was sent stays as it was; from the ops board (`list`, `phone`) the record is replaced whole and
 * the sent mark goes, as legacy's `bkV2Reconfirm` does (decided 2026-10-09).
 */
export function withStatus(current: StoredReconfirm | null, status: ReconfirmStatus, via: ReconfirmVia, now: string, by: string | null): { record: StoredReconfirm; history: HistoryLine } {
  const record = { sent_at: null, sent_by: null, ...(via === 'reconfirm' ? current : {}), status, via, at: now, by };
  // Legacy's two wordings: the reconfirm page names the status, the ops board says where it was confirmed.
  const text = via === 'reconfirm' ? `Re-confirm: ${LABEL[status]}` : `Re-confirmed pickup (${via})`;
  return { record, history: { by, kind: 'notify', tag: 'Notify', text } };
}

/**
 * Clears what the customer said. From the Re-confirm page a list already sent stays sent (`rcSetStatus`);
 * the ops board's clear (`all`) drops the whole record, as legacy's `bkV2ReconfirmClear` does.
 */
export const withoutStatus = (current: StoredReconfirm | null, all = false): StoredReconfirm | null =>
  !all && current?.sent_at ? { ...current, status: null, via: null, at: null, by: null } : null;

/** The agent's list sent (again: a resend restamps it) or unsent. Unsent with no status leaves no record. */
export function withSent(current: StoredReconfirm | null, sent: boolean, now: string, by: string | null): { record: StoredReconfirm | null; history?: HistoryLine } {
  if (!sent) return { record: current?.status ? { ...current, sent_at: null, sent_by: null } : null };
  const record = { status: null, via: null, at: null, by: null, ...current, sent_at: now, sent_by: by };
  return { record, history: { by, kind: 'notify', tag: 'Notify', text: 'Re-confirm sent to agent' } };
}

export function parseSentRequest(body: Record<string, unknown>): { booking_ids: string[]; sent: boolean } {
  if (!Array.isArray(body.booking_ids) || body.booking_ids.length === 0 || body.booking_ids.some((id) => typeof id !== 'string' || !id)) {
    bad('booking_ids must be a list of booking ids, one or more');
  }
  if (typeof body.sent !== 'boolean') bad('sent must be true or false');
  return { booking_ids: [...new Set(body.booking_ids as string[])], sent: body.sent as boolean };
}

/**
 * The transition rule for `PATCH /v1/bookings/{id}`: a client that sends the booking back may echo
 * `reconfirm` unchanged; a different value is refused, naming the commands.
 */
export function assertReconfirmEcho(sent: unknown, stored: Reconfirm | null): void {
  if (sent === undefined) return;
  const fields = ['status', 'via', 'at', 'by', 'sent_at', 'sent_by'] as const;
  const instant = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : v ?? null);
  const same = sent === null ? stored === null
    : typeof sent === 'object' && stored !== null && fields.every((f) => instant((sent as Record<string, unknown>)[f]) === instant(stored[f]));
  if (!same) {
    bad('reconfirm cannot be changed with PATCH: use PUT or DELETE /v1/bookings/{id}/reconfirm, or POST /v1/reconfirm/sent');
  }
}
