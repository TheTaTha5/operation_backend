/**
 * Check-in (slice C of todo/trip-ops-and-vans-model.md, migration 036): for one departure, on the van
 * and at the pier, per van part (`slot` = the part's idx). Legacy `ckWrite` and its callers (`ckStep`,
 * `ckToggle`, `ckEvSave`, `ckBackSave`, `ckTrySave`, `ckSelfSave`, `ckPierReinstate`, `pckStageSet`,
 * `vckSetFlow`) all write the whole record, so a write here replaces it too. Pure, so both stores
 * decide identically.
 *
 * What the server holds to: a record never counts more passengers than the part booked; the
 * no-show count is worked out, not taken; and the no-show / on-site cancel events are kept: one is
 * marked undone, never removed, and an undo is final (legacy §ckBack).
 */
import { refuse } from './booking-actions.js';
import { isIsoTime } from './calendar.js';

export const CHECKIN_KINDS = ['van', 'pier'] as const;
export type CheckinKind = typeof CHECKIN_KINDS[number];
export type CheckinTry = { at: string | null; by: string | null; note: string | null; ts: string | null };
export type CheckinEvent = {
  type: 'no_show' | 'cxl'; pax: number; ad: number | null; chd: number | null; inf: number | null; foc: number | null;
  reason_code: string | null; note: string | null; at: string | null; by: string | null; ts: string | null;
  undone: { why: 'found' | 'mistake'; at: string | null; by: string | null; ts: string | null; note: string | null } | null;
  tries: CheckinTry[];
};
export type StoredCheckin = {
  kind: CheckinKind; slot: number; expected: number | null; actual_pax: number | null;
  checked_in_at: string | null; checked_in_by: string | null;
  reason_code: string | null; reason_note: string | null; reason_at: string | null;
  arrived_at: string | null; arrived_by: string | null; cleared_at: string | null; cleared_by: string | null;
  flow: 'standby' | 'pending' | null; flow_at: string | null; flow_by: string | null; flow_note: string | null;
  reinstate: { at: string | null; by: string | null; ts: string | null } | null;
  self_add: { pax: number; ad: number | null; chd: number | null; inf: number | null; foc: number | null; at: string | null; by: string | null; ts: string | null; note: string | null } | null;
  events: CheckinEvent[];
  updated_at: string; updated_by: string | null;
};
/** As a read shows it: `no_show` is `expected − actual_pax`, never below 0. */
export type CheckinView = StoredCheckin & { no_show: number | null };
export type CheckinInput = Omit<StoredCheckin, 'kind' | 'slot' | 'updated_at' | 'updated_by'>;

const bad = (message: string): never => refuse(message, 400);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export const checkinView = (r: StoredCheckin): CheckinView => ({
  ...copyCheckin(r), no_show: r.expected === null || r.actual_pax === null ? null : Math.max(0, r.expected - r.actual_pax),
});
export const copyCheckin = (r: StoredCheckin): StoredCheckin => ({
  ...r, reinstate: r.reinstate && { ...r.reinstate }, self_add: r.self_add && { ...r.self_add },
  events: r.events.map((e) => ({ ...e, undone: e.undone && { ...e.undone }, tries: e.tries.map((t) => ({ ...t })) })),
});
/** A trip's records, van then pier, by slot. */
export const checkinsView = (records: readonly StoredCheckin[]): { van: CheckinView[]; pier: CheckinView[] } => {
  const of = (kind: CheckinKind) => records.filter((r) => r.kind === kind).sort((a, b) => a.slot - b.slot).map(checkinView);
  return { van: of('van'), pier: of('pier') };
};

export function parseCheckinTarget(params: { kind?: string; slot?: string }): { kind: CheckinKind; slot: number } {
  const kind = (CHECKIN_KINDS as readonly unknown[]).includes(params.kind) ? params.kind as CheckinKind : bad('kind must be van or pier');
  const slot = Number(params.slot);
  if (!Number.isInteger(slot) || slot < 0) bad('slot must be a whole number, 0 or more');
  return { kind: kind!, slot };
}

// ── Field readers: `name` is the path a refusal names ──
const text = (v: unknown, name: string): string | null => (v === undefined || v === null || v === '' ? null : typeof v === 'string' ? v : bad(`${name} must be text`));
const count = (v: unknown, name: string): number | null =>
  (v === undefined || v === null ? null : Number.isInteger(v) && (v as number) >= 0 ? v as number : bad(`${name} must be a whole number, 0 or more`));
const instant = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : bad(`${name} must be an ISO 8601 instant`);
};
const clock = (v: unknown, name: string): string | null => {
  const t = text(v, name);
  return t === null || isIsoTime(t) ? t : bad(`${name} must be HH:MM`);
};
const obj = (v: unknown, name: string): Record<string, unknown> | null => (v === undefined || v === null ? null : isObject(v) ? v : bad(`${name} must be an object`));

function parseEvent(raw: unknown, i: number): CheckinEvent {
  const at = `events[${i}]`;
  const e = isObject(raw) ? raw : bad(`${at} must be an object`);
  const type = e.type === 'no_show' || e.type === 'cxl' ? e.type : bad(`${at}.type must be no_show or cxl`);
  const pax = count(e.pax, `${at}.pax`) ?? bad(`${at}.pax is required`);
  const u = obj(e.undone, `${at}.undone`);
  const undone = u && {
    why: u.why === 'found' || u.why === 'mistake' ? u.why : bad(`${at}.undone.why must be found or mistake`),
    at: text(u.at, `${at}.undone.at`), by: text(u.by, `${at}.undone.by`), ts: instant(u.ts, `${at}.undone.ts`), note: text(u.note, `${at}.undone.note`),
  };
  if (e.tries !== undefined && e.tries !== null && !Array.isArray(e.tries)) bad(`${at}.tries must be a list`);
  const tries = ((e.tries as unknown[] | undefined) ?? []).map((t, j) => {
    const x = isObject(t) ? t : bad(`${at}.tries[${j}] must be an object`);
    return { at: clock(x.at, `${at}.tries[${j}].at`), by: text(x.by, `${at}.tries[${j}].by`), note: text(x.note, `${at}.tries[${j}].note`), ts: instant(x.ts, `${at}.tries[${j}].ts`) };
  });
  return {
    type: type!, pax: pax!, ad: count(e.ad, `${at}.ad`), chd: count(e.chd, `${at}.chd`), inf: count(e.inf, `${at}.inf`), foc: count(e.foc, `${at}.foc`),
    reason_code: text(e.reason_code, `${at}.reason_code`), note: text(e.note, `${at}.note`), at: clock(e.at, `${at}.at`), by: text(e.by, `${at}.by`),
    ts: instant(e.ts, `${at}.ts`), undone: undone as CheckinEvent['undone'], tries,
  };
}

/** The whole record, as legacy writes it. `no_show` and `updated_*` are the server's and are not read. */
export function parseCheckin(body: Record<string, unknown>): CheckinInput {
  const flow = body.flow === undefined || body.flow === null || body.flow === '' ? null
    : body.flow === 'standby' || body.flow === 'pending' ? body.flow : bad('flow must be standby or pending, or null');
  const r = obj(body.reinstate, 'reinstate'), s = obj(body.self_add, 'self_add');
  if (body.events !== undefined && body.events !== null && !Array.isArray(body.events)) bad('events must be a list');
  return {
    expected: count(body.expected, 'expected'), actual_pax: count(body.actual_pax, 'actual_pax'),
    checked_in_at: instant(body.checked_in_at, 'checked_in_at'), checked_in_by: text(body.checked_in_by, 'checked_in_by'),
    reason_code: text(body.reason_code, 'reason_code'), reason_note: text(body.reason_note, 'reason_note'), reason_at: clock(body.reason_at, 'reason_at'),
    arrived_at: instant(body.arrived_at, 'arrived_at'), arrived_by: text(body.arrived_by, 'arrived_by'),
    cleared_at: instant(body.cleared_at, 'cleared_at'), cleared_by: text(body.cleared_by, 'cleared_by'),
    flow: flow as StoredCheckin['flow'], flow_at: clock(body.flow_at, 'flow_at'), flow_by: text(body.flow_by, 'flow_by'), flow_note: text(body.flow_note, 'flow_note'),
    reinstate: r && { at: clock(r.at, 'reinstate.at'), by: text(r.by, 'reinstate.by'), ts: instant(r.ts, 'reinstate.ts') },
    self_add: s && {
      pax: count(s.pax, 'self_add.pax') ?? bad('self_add.pax is required'), ad: count(s.ad, 'self_add.ad'), chd: count(s.chd, 'self_add.chd'),
      inf: count(s.inf, 'self_add.inf'), foc: count(s.foc, 'self_add.foc'), at: text(s.at, 'self_add.at'), by: text(s.by, 'self_add.by'),
      ts: instant(s.ts, 'self_add.ts'), note: text(s.note, 'self_add.note'),
    },
    events: ((body.events as unknown[] | undefined) ?? []).map(parseEvent),
  };
}

/** Key order differs between the stores' readers, so values are compared with their keys sorted. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
  : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v ?? null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const core = ({ undone: _u, tries: _t, ...rest }: CheckinEvent) => rest;

/**
 * The record after a write. Refuses:
 * - more passengers than the part booked, counted or expected (`400`);
 * - an event removed, reordered or changed (`409 events_append_only`): mark it undone instead;
 * - an undone event changed or restored (`409 event_undone_is_final`);
 * - a try removed or changed (`409 events_append_only`).
 */
export function applyCheckin(stored: StoredCheckin | undefined, input: CheckinInput, ctx: { kind: CheckinKind; slot: number; booked: number; now: string; by: string | null }): StoredCheckin {
  for (const field of ['actual_pax', 'expected'] as const) {
    if (input[field] !== null && input[field]! > ctx.booked) bad(`${field} is ${input[field]}, more than the ${ctx.booked} booked on this part`);
  }
  const was = stored?.events ?? [];
  if (input.events.length < was.length) refuse('Check-in events are kept: mark one undone instead of removing it', 409, 'events_append_only');
  was.forEach((old, i) => {
    const next = input.events[i];
    if (!same(core(old), core(next))) refuse(`events[${i}] was already recorded and cannot change: add a new one, or mark it undone`, 409, 'events_append_only');
    if (old.undone && !same(old.undone, next.undone)) refuse(`events[${i}] was undone, and that is final`, 409, 'event_undone_is_final');
    if (next.tries.length < old.tries.length || old.tries.some((t, j) => !same(t, next.tries[j]))) {
      refuse(`events[${i}].tries are kept: add a try, don't change one`, 409, 'events_append_only');
    }
  });
  return { kind: ctx.kind, slot: ctx.slot, ...input, updated_at: ctx.now, updated_by: ctx.by };
}
