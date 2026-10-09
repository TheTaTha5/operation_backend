/**
 * Server-owned fields in a `PATCH` body (CLAUDE.md, "Authority"). A client that sends the record it
 * read back echoes them unchanged, and that is accepted and ignored; a different value is a claim the
 * client may not make, refused with `400` naming what to use instead. Never silently dropped, never
 * silently applied. The booking header has its own copy of this rule (`stripServerOwned`).
 */
import { refuse } from './booking-actions.js';

/** Two values are the same claim when their JSON is: `null`, a missing key and `''` are all "empty". */
const same = (sent: unknown, stored: unknown): boolean => {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  if (empty(sent) || empty(stored)) return empty(sent) && empty(stored);
  return JSON.stringify(sent) === JSON.stringify(stored);
};

/**
 * Refuses a body that changes a server-owned field; answers the body without them.
 * `owned` maps each field to what to use instead; `current` is the record as `GET` shows it.
 */
export function withoutServerOwned(body: Record<string, unknown>, current: Record<string, unknown>, owned: Record<string, string>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in owned)) { rest[key] = value; continue; }
    if (!same(value, current[key])) refuse(`${key} cannot be changed here: ${owned[key]}`, 400);
  }
  return rest;
}

/** `400` naming the first key `allowed` does not know. */
export function assertKnownKeys(body: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) refuse(`${what} has no field ${unknown.join(', ')}`, 400);
}
