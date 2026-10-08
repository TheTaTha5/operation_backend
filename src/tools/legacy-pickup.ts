/**
 * Legacy's pickup text as this service's pickup window (todo/pickup-window-model.md). Pure, so
 * `test/legacy-pickup.test.ts` checks it without a legacy database.
 *
 * Legacy keeps the pickup as free text, filled from its pickup-area table. On production it takes
 * these shapes, and each maps to fields without loss:
 *
 * - `07:30`, `7:30`, `07.30`, `07:30:00`, `08.00 a.m.`: one time;
 * - `07:30-07:45`: a window; `08:20-`: a window with no end yet, kept as its start;
 * - `Before 08:30 at pier`: a pier deadline.
 *
 * Anything else is not guessed: the caller drops it and counts it.
 */
import { pickupProblem, type PickupWindow } from '../domain/pickup.js';

const TIME = String.raw`(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?`;
const ONE = new RegExp(`^${TIME}$`, 'i');
const WINDOW = new RegExp(`^${TIME}\\s*[-–]\\s*(?:${TIME})?$`, 'i');
const PIER = new RegExp(`^before\\s+${TIME}\\s+at\\s+(?:the\\s+)?pier$`, 'i');

/** `HH:MM` from a matched hour, minute and optional a.m./p.m.; undefined when it is not a clock time. */
function clock(hour?: string, minute?: string, half?: string): string | undefined {
  if (hour === undefined || minute === undefined) return undefined;
  let h = Number(hour);
  const m = Number(minute);
  if (half) {
    if (h < 1 || h > 12) return undefined;
    const pm = /^p/i.test(half);
    h = pm ? (h % 12) + 12 : h % 12;
  }
  if (h > 23 || m > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${minute}`;
}

/**
 * The window a legacy pickup text means. `{}` for an empty text; undefined when the text is none
 * of legacy's shapes, or is one but breaks a window rule (an end before its start).
 */
export function legacyPickup(value: unknown): PickupWindow | undefined {
  const text = value == null ? '' : String(value).trim();
  if (!text) return {};
  let window: PickupWindow | undefined;
  let m: RegExpExecArray | null;
  if ((m = ONE.exec(text))) {
    const start = clock(m[1], m[2], m[3]);
    window = start ? { pickup_time: start } : undefined;
  } else if ((m = WINDOW.exec(text))) {
    const start = clock(m[1], m[2], m[3]);
    const end = m[4] === undefined ? undefined : clock(m[4], m[5], m[6]);
    window = !start || (m[4] !== undefined && !end) ? undefined : { pickup_time: start, ...(end ? { pickup_time_end: end } : {}) };
  } else if ((m = PIER.exec(text))) {
    const end = clock(m[1], m[2], m[3]);
    window = end ? { pickup_time_end: end, pickup_at_pier: true } : undefined;
  }
  return window && pickupProblem(window) === undefined ? window : undefined;
}
