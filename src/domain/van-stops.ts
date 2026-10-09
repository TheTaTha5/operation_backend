/**
 * Van stops (todo/van-extras-model.md, migration 034): a stop a van makes that isn't a booking, a
 * guide riding to the pier (`staff`, takes seats) or something to pick up (`cargo`, none). Legacy
 * `vsSave`, `vsSubmit`, `vsCheck`, `vsSeats`, `vsOnLeg`. Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';
import { isIsoTime } from './calendar.js';

export const STOP_KINDS = ['staff', 'cargo'] as const;
export const STOP_LEGS = ['out', 'ret', 'both'] as const;
export type VanStop = {
  id: string; service_date: string; route_id: string; group_id: string | null;
  kind: typeof STOP_KINDS[number]; label: string; pax: number; time: string | null; place: string;
  area_id: string | null; area: string | null; leg: typeof STOP_LEGS[number]; phone: string | null; note: string | null;
  sequence: number | null;
  /** Checked in on the van check-in screen: when, by whom, and the seats it took then. */
  checked_in: { at: string; by: string | null; seats: number } | null;
  created_at: string; created_by: string | null; updated_at: string | null; updated_by: string | null;
};
/** What a client sets. */
export type StopFields = Pick<VanStop, 'kind' | 'label' | 'pax' | 'time' | 'place' | 'area_id' | 'area' | 'leg' | 'phone' | 'note' | 'sequence'>;

const bad = (message: string): never => refuse(message, 400);

/**
 * The stop's fields after `body`, over `current` when editing. Legacy's form rules: a label and a
 * place are required, a ride-along is one person or more, and a cargo stop carries nobody.
 */
export function parseStopFields(body: Record<string, unknown>, current?: StopFields): StopFields {
  const has = (key: string) => body[key] !== undefined;
  const text = (key: string, fallback: string | null): string | null => {
    if (!has(key)) return fallback;
    if (body[key] === null) return null;
    return typeof body[key] === 'string' ? (body[key] as string).trim() || null : bad(`${key} must be text`);
  };
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    if (!has(key)) return fallback;
    return (allowed as readonly unknown[]).includes(body[key]) ? body[key] as T : bad(`${key} must be one of ${allowed.join(', ')}`);
  };
  const kind = pick('kind', STOP_KINDS, current?.kind ?? 'staff');
  const label = text('label', current?.label ?? null) ?? bad('Type what this stop is for');
  const place = text('place', current?.place ?? null) ?? bad('Type where the van stops');
  const time = text('time', current?.time ?? null);
  if (time !== null && !isIsoTime(time)) bad('time must be HH:MM');
  let pax = 0;
  if (kind === 'staff') {
    const raw = has('pax') ? body.pax : current?.kind === 'staff' ? current.pax : undefined;
    if (!Number.isInteger(raw) || (raw as number) < 1) bad('How many people ride along? Enter at least 1');
    pax = raw as number;
  }
  const sequence = has('sequence')
    ? body.sequence === null ? null : Number.isInteger(body.sequence) && (body.sequence as number) > 0 ? body.sequence as number : bad('sequence must be a whole number, 1 or more')
    : current?.sequence ?? null;
  return {
    kind, label: label!, pax, time, place: place!, area_id: text('area_id', current?.area_id ?? null), area: text('area', current?.area ?? null),
    leg: pick('leg', STOP_LEGS, current?.leg ?? 'out'), phone: text('phone', current?.phone ?? null), note: text('note', current?.note ?? null), sequence,
  };
}

/** Legacy `vsSeats` and `vsOnLeg`: a ride-along on the outbound leg takes its seats; cargo takes none. */
export const outboundSeats = (s: Pick<VanStop, 'kind' | 'pax' | 'leg'>): number => (s.kind === 'staff' && s.leg !== 'ret' ? s.pax : 0);

/** Legacy `vsFor`: the manual order first, then time; a stop with no time goes last. */
export const sortStops = (stops: readonly VanStop[]): VanStop[] => [...stops].sort((a, b) =>
  (a.sequence ?? 9999) - (b.sequence ?? 9999) || (a.time ?? '~').localeCompare(b.time ?? '~') || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

export const copyStop = (s: VanStop): VanStop => ({ ...s, checked_in: s.checked_in && { ...s.checked_in } });
