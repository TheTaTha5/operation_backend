/**
 * A booking's readable number (decided 2026-10-10): legacy `bkV2GenerateBookingCode`'s `BK-YYMM`
 * month and sequence, numbered by the server so two creates can never get the same one. Legacy added
 * a random suffix (`BK-YYMMNNNN-XXXX`) because each browser counted on its own; a server counter per
 * Bangkok month needs none, as invoice numbers (`invoices.ts`). The sequence continues past every code
 * of the month already given, legacy's imported ones included, so a new code never reads like an old
 * one. The id (`booking_<uuid>`) stays the key; the code is what staff and agents see.
 *
 * Server-owned: computed on create, never taken from a client.
 */
import { refuse } from './booking-actions.js';

/** `BK-2610` + the sequence, at least four digits. */
export const bookingCode = (month: string, n: number): string => `BK-${month}${String(n).padStart(4, '0')}`;

/** The sequence a code has in `month` (YYMM), or 0 for another month's or another shape. Legacy's `BK-26100452-J6YM` is 452. */
export function codeSequence(code: string | undefined, month: string): number {
  const match = new RegExp(`^BK-${month}(\\d+)`).exec(code ?? '');
  return match ? Number(match[1]) : 0;
}

const HOW = 'the server numbers each booking (BK-YYMMNNNN) when it is created';

/** A create may not name its code. */
export function assertNoCode(body: Record<string, unknown>): void {
  if (body.code !== undefined && body.code !== null && body.code !== '') refuse(`code cannot be set: ${HOW}`, 400);
}

/** An edit may echo the code it read, and nothing else. */
export function assertCodeEcho(body: Record<string, unknown>, stored: string | undefined): void {
  if (body.code !== undefined && body.code !== stored) refuse(`code cannot be changed: ${HOW}`, 400);
}
