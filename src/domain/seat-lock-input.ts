/**
 * Request bodies of the seat-lock endpoints, checked for shape (todo/seat-lock-extras-model.md). The
 * rules a value must meet against the data (an agent that exists, seats that are free) are the
 * service's; this only says whether a request is well formed, and refuses a server-owned field.
 */
import { isIsoTime } from './calendar.js';
import { refuse } from './booking-actions.js';
import { isHolderType, type HolderType, type PendingChoice, type SeatLock, type SeatLockGroup } from './seat-locks.js';
import type { AddInput, GroupChanges, LockChanges, NewGroupInput, NewLockInput, SubGroupInput } from './seat-lock-service.js';

const bad = (message: string): never => refuse(message, 400);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const body = (value: unknown): Record<string, unknown> => (value === undefined || value === null ? {} : isRecord(value) ? value : bad('Request body must be an object'));
const text = (value: unknown, name: string): string => (typeof value === 'string' && value.trim() ? value.trim() : bad(`${name} is required`));
const seats = (value: unknown, name = 'pax'): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : bad(`${name} must be a positive integer`));
/** A real calendar day: `2048-02-30` is refused, not rolled into March. */
export function isoDay(value: unknown, name: string): string {
  const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  return day && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value as string) ? value as string : bad(`${name} must be a YYYY-MM-DD date`);
}
/** Free text, `null` or `''` to clear. */
function note(value: unknown, name: string, max: number): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return bad(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) bad(`${name} must be ${max} characters or fewer`);
  return trimmed || null;
}
const optional = <T>(input: Record<string, unknown>, key: string, parse: (value: unknown) => T): T | undefined => (input[key] === undefined ? undefined : parse(input[key]));
const holderType = (value: unknown): HolderType => (isHolderType(value) ? value : bad('holder_type must be agent, office or global'));
const agentId = (value: unknown): string | null => (value === null || value === '' ? null : typeof value === 'string' ? value : bad('agent_id must be text'));
function pending(value: unknown): PendingChoice | undefined {
  if (value === undefined || value === null) return undefined;
  return value === 'split' || value === 'all' ? value : bad('pending must be "split" (lock what is free, the rest pending) or "all" (keep it all pending)');
}
const MAX_REASON = 500;

/** A new lock's holder: `agent_id` alone means an agent lock, nothing means office (legacy's default). */
function holderOf(input: Record<string, unknown>): { holder_type: HolderType; agent_id: string | null } {
  const agent_id = optional(input, 'agent_id', agentId) ?? null;
  const holder_type = optional(input, 'holder_type', holderType) ?? (agent_id ? 'agent' : 'office');
  if (holder_type === 'agent' && !agent_id) bad('An agent lock needs agent_id');
  if (holder_type !== 'agent' && agent_id) bad(`agent_id is for an agent lock (holder_type "agent"), not ${holder_type}`);
  return { holder_type, agent_id };
}

export function parseNewLock(raw: unknown): NewLockInput {
  const input = body(raw);
  return {
    route_id: text(input.route_id, 'route_id'), service_date: isoDay(input.service_date ?? input.date, 'service_date'), pax: seats(input.pax), ...holderOf(input),
    reason: optional(input, 'reason', (v) => note(v, 'reason', MAX_REASON)) ?? null,
    expiry: input.expiry === undefined || input.expiry === null || input.expiry === '' ? null : isoDay(input.expiry, 'expiry'),
    pending: pending(input.pending),
  };
}

/** What `PATCH` may not set, and the command that does. */
const OWNED: Record<string, string> = {
  status: 'use POST /v1/seat-locks/{id}/release (or /add, which reactivates a released lock)',
  pending_pax: 'it is set by the "pending" choice and POST /v1/seat-locks/{id}/confirm-pending',
  released_pax: 'use POST /v1/seat-locks/{id}/release or /release-departure',
  group_id: 'a bulk lock is made with POST /v1/seat-lock-groups',
  parent_id: 'a sub-group is made with POST /v1/seat-locks/{id}/sub-groups',
  boat_id: 'whole-boat holds are made by the import only, for now',
  drawn_pax: 'it is worked out from the bookings that draw on the lock',
  remaining_pax: 'it is worked out by the server', held_pax: 'it is worked out by the server', allocated_pax: 'it is worked out by the server',
  sub_group_room: 'it is worked out by the server', holding: 'it is worked out by the server', state: 'it is worked out by the server',
  release_at: 'it comes from the bulk lock\'s release cutoff', overdue: 'it is worked out by the server',
  created_at: 'it is set by the server', created_by: 'it is set by the server', updated_at: 'it is set by the server', released_at: 'it is set by the server', id: 'it is the lock\'s id',
};
const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null) || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A server-owned field echoed unchanged is accepted and ignored, as a booking's are; a different
 * value is refused with `400 server_owned`, naming what sets it.
 */
export function assertOwnedEcho(raw: unknown, current: SeatLock | SeatLockGroup, owned: Record<string, string> = OWNED): void {
  const input = body(raw);
  for (const [field, instead] of Object.entries(owned)) {
    if (input[field] !== undefined && !same(input[field], (current as Record<string, unknown>)[field])) refuse(`${field} cannot be changed with PATCH: ${instead}`, 400, 'server_owned');
  }
}

export function parseLockChanges(raw: unknown): LockChanges {
  const input = body(raw);
  const out: LockChanges = {
    pax: optional(input, 'pax', (v) => seats(v)),
    holder_type: optional(input, 'holder_type', holderType),
    agent_id: optional(input, 'agent_id', agentId),
    reason: optional(input, 'reason', (v) => note(v, 'reason', MAX_REASON)),
    expiry: optional(input, 'expiry', (v) => (v === null || v === '' ? null : isoDay(v, 'expiry'))),
    route_id: optional(input, 'route_id', (v) => text(v, 'route_id')),
    service_date: optional(input, 'service_date', (v) => isoDay(v, 'service_date')),
    sub_name: optional(input, 'sub_name', subName),
    pending: pending(input.pending),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as LockChanges;
}

export const parseAdd = (raw: unknown): AddInput => {
  const input = body(raw);
  return { pax: seats(input.pax), note: optional(input, 'note', (v) => note(v, 'note', MAX_REASON)) ?? null, pending: pending(input.pending) };
};
/** `{ pax? }`: how many seats to release; absent, all that can be. */
export const parseRelease = (raw: unknown): number | undefined => optional(body(raw), 'pax', (v) => seats(v));
/** `{ pax? }`: how many pending seats to confirm; absent, as many as are free. */
export const parseConfirm = (raw: unknown): number | undefined => optional(body(raw), 'pax', (v) => seats(v));

function subName(value: unknown): string {
  const name = text(value, 'sub_name');
  if (name.length > 40) bad('sub_name must be 40 characters or fewer');
  return name;
}
/** Legacy: "Type a sub-group name (e.g. A)", and seats more than 0. */
export function parseSubGroup(raw: unknown): SubGroupInput {
  const input = body(raw);
  if (typeof input.sub_name !== 'string' || !input.sub_name.trim()) bad('Type a sub-group name (e.g. A): sub_name is required');
  return { sub_name: subName(input.sub_name), pax: seats(input.pax), reason: optional(input, 'reason', (v) => note(v, 'reason', MAX_REASON)) ?? null };
}

/** `release_days_before` + `release_time` (HH:MM, Asia/Bangkok): both, neither, or `null` both to clear. */
function cutoff(input: Record<string, unknown>): { release_days_before?: number | null; release_time?: string | null } {
  const days = input.release_days_before, time = input.release_time;
  if (days === undefined && time === undefined) return {};
  if ((days === null || days === '') && (time === null || time === '')) return { release_days_before: null, release_time: null };
  if (days === undefined || time === undefined || days === null || time === null) return bad('release_days_before and release_time go together');
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) bad('release_days_before must be a whole number of days, 0 or more');
  if (typeof time !== 'string' || !isIsoTime(time)) bad('release_time must be HH:MM');
  return { release_days_before: days as number, release_time: time as string };
}

/** The longest bulk lock: legacy counts rounds over at most 800 days. */
export const MAX_GROUP_DAYS = 800;

export function parseNewGroup(raw: unknown): NewGroupInput {
  const input = body(raw);
  const date_from = isoDay(input.date_from, 'date_from');
  // Legacy §lkZero: an empty last day collapsed the range to one day (the Panorama case).
  if (input.date_to === undefined || input.date_to === null || input.date_to === '') bad('Pick the last day of the range: date_to is required');
  const date_to = isoDay(input.date_to, 'date_to');
  if (date_to < date_from) bad('The last day cannot be before the first day');
  const span = (Date.parse(`${date_to}T00:00:00Z`) - Date.parse(`${date_from}T00:00:00Z`)) / 86_400_000 + 1;
  if (span > MAX_GROUP_DAYS) bad(`The range covers ${span} days; the most is ${MAX_GROUP_DAYS}`);
  const raw_days = input.weekdays ?? input.dow ?? [];
  if (!Array.isArray(raw_days) || raw_days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad('weekdays must be a list of 0 (Sunday) to 6 (Saturday)');
  const rule = cutoff(input);
  return {
    route_id: text(input.route_id, 'route_id'), date_from, date_to, weekdays: [...new Set(raw_days as number[])].sort((a, b) => a - b), pax: seats(input.pax), ...holderOf(input),
    reason: optional(input, 'reason', (v) => note(v, 'reason', MAX_REASON)) ?? null,
    release_days_before: rule.release_days_before ?? null, release_time: rule.release_time ?? null, pending: pending(input.pending),
  };
}

const GROUP_OWNED: Record<string, string> = {
  date_from: 'the range of a bulk lock cannot change here: release it and make a new one',
  date_to: 'the range of a bulk lock cannot change here: release it and make a new one',
  weekdays: 'the weekdays of a bulk lock cannot change here: release it and make a new one',
  route_id: 'a bulk lock cannot move to another route: release it and make a new one',
  departures: 'it is worked out by the server', departures_past: 'it is worked out by the server', state: 'it is worked out by the server',
  held_pax: 'it is worked out by the server', drawn_pax: 'it is worked out by the server', pending_pax: 'it is worked out by the server',
  created_at: 'it is set by the server', created_by: 'it is set by the server', updated_at: 'it is set by the server', id: 'it is the bulk lock\'s id',
};
export const assertGroupOwnedEcho = (raw: unknown, current: SeatLockGroup): void => assertOwnedEcho(raw, current, GROUP_OWNED);

export function parseGroupChanges(raw: unknown): GroupChanges {
  const input = body(raw);
  const out: GroupChanges = {
    pax: optional(input, 'pax', (v) => seats(v)),
    holder_type: optional(input, 'holder_type', holderType),
    agent_id: optional(input, 'agent_id', agentId),
    reason: optional(input, 'reason', (v) => note(v, 'reason', MAX_REASON)),
    ...cutoff(input),
    pending: pending(input.pending),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as GroupChanges;
}
