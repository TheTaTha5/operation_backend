/**
 * Refusing a save made from a stale copy (migration 028; README, "Edit conflicts").
 *
 * Bookings and seat locks carry a `version`: 1 on create, +1 on every write. A client sends back the
 * version it read, as `If-Match: "7"` (the `ETag` it was given) or `"version": 7` in the body. If the
 * record has moved on, the write is refused and nothing changes. Without either, the write goes
 * through as before (last write wins): optional until every client sends it.
 */
import { refuse } from './booking-actions.js';

/** The version a write expects, or undefined when it sends none. A malformed one is `400`. */
export function expectedVersion(ifMatch: unknown, bodyVersion: unknown): number | undefined {
  const header = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
  if (header !== undefined && header !== '' && header !== '*') {
    const match = /^(?:W\/)?"?(\d+)"?$/.exec(String(header).trim());
    const version = match ? Number(match[1]) : NaN;
    if (!(version >= 1)) refuse(`If-Match must be the version you read, e.g. "7" (got ${String(header)})`, 400);
    if (bodyVersion !== undefined && bodyVersion !== version) refuse('If-Match and version disagree; send one', 400);
    return version;
  }
  if (bodyVersion === undefined || bodyVersion === null) return undefined;
  if (!(typeof bodyVersion === 'number' && Number.isInteger(bodyVersion) && bodyVersion >= 1)) refuse('version must be the version you read, a positive integer', 400);
  return bodyVersion as number;
}

/** Throws `409 stale_version` unless `expected` is absent or is the record's current version. */
export function assertFresh(what: string, expected: number | undefined, current: number): void {
  if (expected === undefined || expected === current) return;
  refuse(`${what} has changed since you read it (you have version ${expected}, it is now ${current}); reload and try again`, 409, 'stale_version');
}
