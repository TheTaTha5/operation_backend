/**
 * Insurance (todo/sales-editing-model.md, decision 12; migration 093): each passenger's age for the
 * insurer, and who reviewed the row and when. Legacy's Insurance page (`ins*`, area `operations`)
 * keeps these apart from the booking, keyed by the passenger's position, so removing a passenger moved
 * an age onto the next one (bug 12). Here they live on the passenger: the lead on the booking header
 * (`lead_age`, `lead_insurance_reviewed_at`, `lead_insurance_reviewed_by`), every other passenger on
 * its `booking_passengers` row. Set by `PUT /v1/bookings/{id}/insurance` only. Pure, so both stores agree.
 */
import { refuse } from './booking-actions.js';
import { assertKnownKeys } from './server-owned.js';
import type { BookingPassenger, BookingPassengerInput } from './booking-passengers.js';

const bad = (message: string): never => refuse(message, 400);

/** What the command may change for one passenger: `age` (null clears) and the review tick. */
export type InsuranceUpdate = { passenger: 'lead' | number; age?: number | null; reviewed?: boolean };
/** One passenger's insurance fields after the command. */
export type InsuranceFields = { age: number | null; reviewed_at: string | null; reviewed_by: string | null };

/** An age: a number from 0, fractions allowed (an infant of 2.5); legacy stored them as text ("47"). */
export function parseAge(value: unknown, name: string): number | null {
  if (value === null || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n >= 1000) bad(`${name} must be a number from 0 to 999`);
  return Math.round(n * 100) / 100;
}

export function parseInsurance(body: Record<string, unknown>): InsuranceUpdate[] {
  assertKnownKeys(body, ['passengers', 'version'], 'An insurance update');
  if (!Array.isArray(body.passengers) || body.passengers.length === 0) bad('passengers must be a list of { passenger, age?, reviewed? }');
  const seen = new Set<string>();
  return (body.passengers as unknown[]).map((raw, i) => {
    const at = `passengers[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad(`${at} must be an object`);
    const row = raw as Record<string, unknown>;
    assertKnownKeys(row, ['passenger', 'age', 'reviewed'], at);
    const who = row.passenger === 'lead' ? 'lead' : typeof row.passenger === 'number' && Number.isInteger(row.passenger) && row.passenger >= 0 ? row.passenger
      : bad(`${at}.passenger must be "lead" or a passenger's seq`);
    if (seen.has(String(who))) bad(`${at}: passenger ${who} is listed twice`);
    seen.add(String(who));
    const update: InsuranceUpdate = { passenger: who };
    if (row.age !== undefined) update.age = parseAge(row.age, `${at}.age`);
    if (row.reviewed !== undefined) update.reviewed = typeof row.reviewed === 'boolean' ? row.reviewed : bad(`${at}.reviewed must be true or false`);
    return update;
  });
}

const apply = (current: InsuranceFields, update: InsuranceUpdate, now: string, by: string | null): InsuranceFields => ({
  age: update.age !== undefined ? update.age : current.age,
  // A tick stamps who and when (legacy kept only `at`); unticking clears both.
  reviewed_at: update.reviewed === undefined ? current.reviewed_at : update.reviewed ? now : null,
  reviewed_by: update.reviewed === undefined ? current.reviewed_by : update.reviewed ? by : null,
});

/**
 * The lead's and each named passenger's fields after the command. `400` for a passenger the booking
 * does not have. A review already ticked and ticked again keeps its first stamp.
 */
export function planInsurance(booking: { lead_age?: number; lead_insurance_reviewed_at?: string; lead_insurance_reviewed_by?: string; passengers: readonly BookingPassenger[] },
  updates: readonly InsuranceUpdate[], ctx: { now: string; by: string | null }): { lead: InsuranceFields | undefined; passengers: Map<number, InsuranceFields> } {
  let lead: InsuranceFields | undefined;
  const passengers = new Map<number, InsuranceFields>();
  for (const update of updates) {
    const keep = (u: InsuranceUpdate, reviewedAt: string | null): InsuranceUpdate => (u.reviewed === true && reviewedAt !== null ? { ...u, reviewed: undefined } : u);
    if (update.passenger === 'lead') {
      const current = { age: booking.lead_age ?? null, reviewed_at: booking.lead_insurance_reviewed_at ?? null, reviewed_by: booking.lead_insurance_reviewed_by ?? null };
      lead = apply(current, keep(update, current.reviewed_at), ctx.now, ctx.by);
      continue;
    }
    const p = booking.passengers.find((x) => x.seq === update.passenger) ?? bad(`The booking has no passenger ${update.passenger} (seq): send "lead" or one of its passengers' seq`);
    const current = { age: p.age ?? null, reviewed_at: p.insurance_reviewed_at ?? null, reviewed_by: p.insurance_reviewed_by ?? null };
    passengers.set(p.seq, apply(current, keep(update, current.reviewed_at), ctx.now, ctx.by));
  }
  return { lead, passengers };
}

const INSURANCE_KEYS = ['age', 'insurance_reviewed_at', 'insurance_reviewed_by'] as const;

/**
 * A passenger list a `PATCH` replaces keeps each passenger's insurance fields when the row at the same
 * position has the same name; a passenger who moved or was renamed loses them rather than handing them
 * to someone else (legacy bug 12).
 */
export function carryInsurance(stored: readonly BookingPassenger[], next: readonly BookingPassengerInput[]): BookingPassengerInput[] {
  return next.map((p, seq) => {
    const { age: _a, insurance_reviewed_at: _at, insurance_reviewed_by: _by, ...rest } = p;
    const was = stored.find((s) => s.seq === seq);
    if (!was || was.name.trim().toLowerCase() !== p.name.trim().toLowerCase()) return rest;
    return { ...rest, ...Object.fromEntries(INSURANCE_KEYS.filter((k) => was[k] !== undefined).map((k) => [k, was[k]])) };
  });
}

/**
 * `PATCH` passengers may echo the insurance fields they read; a different value is refused, naming the
 * command (CLAUDE.md, "Authority"). Compared with the stored passenger at the same position.
 */
export function assertInsuranceEcho(raw: unknown, stored: readonly BookingPassenger[]): void {
  if (!Array.isArray(raw)) return;
  raw.forEach((entry, seq) => {
    if (entry === null || typeof entry !== 'object') return;
    const row = entry as Record<string, unknown>;
    const was = stored.find((s) => s.seq === seq);
    for (const key of INSURANCE_KEYS) {
      if (row[key] === undefined) continue;
      const sent = row[key] === null || row[key] === '' ? undefined : key === 'age' ? Number(row[key]) : key === 'insurance_reviewed_at' ? Date.parse(String(row[key])) : row[key];
      const kept = was?.[key] === undefined ? undefined : key === 'insurance_reviewed_at' ? Date.parse(String(was[key])) : was[key];
      if (sent !== kept) bad(`passengers[${seq}].${key} cannot be changed here: use PUT /v1/bookings/{id}/insurance`);
    }
  });
}
