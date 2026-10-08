/**
 * When a trip's passengers are collected (todo/pickup-window-model.md).
 *
 * Legacy's pickup-area table gives a trip one of two things: a hotel pickup **window**, `07:30-07:45`
 * (the van comes between these times), or a **pier deadline**, `Before 08:30 at pier` (the guest
 * makes their own way to the pier by then). Both are kept as fields rather than text:
 *
 * - a window is `pickup_time` and `pickup_time_end`; a single time is `pickup_time` alone;
 * - a pier deadline is `pickup_time_end` with `pickup_at_pier`, and no `pickup_time`.
 *
 * All three are client facts: the server checks only that they are times and that they agree.
 */
import { isIsoTime } from './calendar.js';

export type PickupWindow = { pickup_time?: string; pickup_time_end?: string; pickup_at_pier?: boolean };

/** Why a pickup window cannot be stored, as a message the screen can show; undefined when it can. */
export function pickupProblem(window: PickupWindow): string | undefined {
  const { pickup_time: start, pickup_time_end: end, pickup_at_pier: atPier } = window;
  if (start !== undefined && !isIsoTime(start)) return 'pickup_time must be an ISO time, HH:MM';
  if (end !== undefined && !isIsoTime(end)) return 'pickup_time_end must be an ISO time, HH:MM';
  if (atPier) {
    if (end === undefined) return 'pickup_at_pier needs pickup_time_end, the time to be at the pier';
    if (start !== undefined) return 'pickup_time does not apply at the pier; send only pickup_time_end, the time to be there';
    return undefined;
  }
  if (end === undefined) return undefined;
  if (start === undefined) return 'pickup_time_end needs pickup_time, the start of the window (or pickup_at_pier for a pier deadline)';
  if (end <= start) return 'pickup_time_end must be after pickup_time';
  return undefined;
}

/** The window with the unset fields left out, so both stores return the same keys. */
export const pickupFields = (window: PickupWindow): PickupWindow => ({
  ...(window.pickup_time ? { pickup_time: window.pickup_time } : {}),
  ...(window.pickup_time_end ? { pickup_time_end: window.pickup_time_end } : {}),
  ...(window.pickup_at_pier ? { pickup_at_pier: true } : {}),
});
