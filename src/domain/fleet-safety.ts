/**
 * Safety equipment per boat (legacy `fleet_safety`, `06-engine-assign.js` `flSaveSafety`,
 * `flSaveInspection`, `_flSafetyStatus`; decision 11). Pure, so both stores decide identically.
 *
 * Legacy loses an inspection's inspector, findings and next due date (its table keeps `by` and
 * `note` only); they are kept here.
 */
import { assertKnown, bad, dayGap, isoDate, newFleetId, notFound, number, record, required, text } from './fleet-common.js';

/** Legacy `FL_SAFETY_CATEGORIES`. */
export const SAFETY_CATEGORIES = {
  bilge_pump: { label: 'Bilge pump', th: 'ปั๊มดูดน้ำท้องเรือ', regulatory: true },
  life_jacket: { label: 'Life jacket', th: 'เสื้อชูชีพ', regulatory: true },
  fire_ext: { label: 'Fire extinguisher', th: 'ถังดับเพลิง', regulatory: true },
  epirb: { label: 'EPIRB / SART', th: 'สัญญาณฉุกเฉิน', regulatory: true },
  flare: { label: 'Flare', th: 'พลุสัญญาณ', regulatory: true },
  vhf: { label: 'VHF radio', th: 'วิทยุ', regulatory: true },
  first_aid: { label: 'First aid kit', th: 'ปฐมพยาบาล', regulatory: false },
  anchor: { label: 'Anchor + chain', th: 'สมอ + โซ่', regulatory: true },
  nav_light: { label: 'Navigation light', th: 'ไฟเดินเรือ', regulatory: true },
} as const;
export const SAFETY_STATUSES = ['active', 'expired', 'replaced', 'missing'] as const;
/** Legacy `INSP_RESULT_STYLE`: pass and needs-work count as a check. */
export const INSPECTION_RESULTS = { pass: true, needs_work: true, fail: false, observation: false } as const;

export type Inspection = { id: string; date: string; inspector: string | null; result: keyof typeof INSPECTION_RESULTS; findings: string | null; next_due: string | null; created_at: string; created_by: string | null };
export type SafetyLog = { item_id: string; date: string; type: string; desc: string };
export type SafetyItem = {
  id: string; boat_id: string; category: string; name: string; brand: string | null; model: string | null; serial: string | null; qty: number;
  install_date: string | null; expiry_date: string | null; next_pm: string | null; last_inspect: string | null; status: string; location: string | null; note: string | null;
  created_at: string; updated_at: string; inspections: Inspection[];
};
export type Ctx = { now: string; today: string; by: string | null };

const ALIASES: Record<string, string> = { boatId: 'boat_id', installDate: 'install_date', expiryDate: 'expiry_date', nextPM: 'next_pm', lastInspect: 'last_inspect' };
const FIELDS = ['boat_id', 'category', 'name', 'brand', 'model', 'serial', 'qty', 'install_date', 'expiry_date', 'next_pm', 'last_inspect', 'status', 'location', 'note'] as const;

/** `POST`/`PATCH /v1/fleet/safety…` (legacy `flSaveSafety`): a boat, a category and a name are required. */
export function parseSafety(raw: Record<string, unknown>, current?: SafetyItem): Partial<SafetyItem> {
  const b = Object.fromEntries(Object.entries(raw).map(([k, v]) => [ALIASES[k] ?? k, v]));
  assertKnown(b, FIELDS, 'A safety item');
  const out: Partial<SafetyItem> = {};
  if (!current || b.boat_id !== undefined) out.boat_id = required(b.boat_id, 'boat_id', 'Please select a boat (boat_id)');
  if (!current || b.category !== undefined) {
    const c = required(b.category, 'category', 'Please select a category');
    out.category = c in SAFETY_CATEGORIES ? c : bad(`category must be one of ${Object.keys(SAFETY_CATEGORIES).join(', ')}`);
  }
  if (!current || b.name !== undefined) out.name = required(b.name, 'name', 'Please enter a name');
  for (const k of ['brand', 'model', 'serial', 'location', 'note'] as const) if (b[k] !== undefined) out[k] = text(b[k], k);
  if (b.qty !== undefined) { const q = number(b.qty, 'qty'); out.qty = q === null ? 1 : Number.isInteger(q) && q >= 1 ? q : bad('qty must be a whole number, at least 1'); }
  for (const k of ['install_date', 'expiry_date', 'next_pm', 'last_inspect'] as const) if (b[k] !== undefined) out[k] = isoDate(b[k], k);
  if (b.status !== undefined) out.status = (SAFETY_STATUSES as readonly unknown[]).includes(b.status) ? b.status as string : bad(`status must be one of ${SAFETY_STATUSES.join(', ')}`);
  return out;
}

export function planSafetyCreate(raw: Record<string, unknown>, ctx: Ctx): { item: SafetyItem; log: SafetyLog } {
  const f = parseSafety(raw);
  const item: SafetyItem = {
    id: newFleetId('sf'), boat_id: f.boat_id!, category: f.category!, name: f.name!, brand: f.brand ?? null, model: f.model ?? null, serial: f.serial ?? null, qty: f.qty ?? 1,
    install_date: f.install_date === undefined ? ctx.today : f.install_date, expiry_date: f.expiry_date ?? null, next_pm: f.next_pm ?? null,
    last_inspect: f.last_inspect === undefined ? ctx.today : f.last_inspect, status: f.status ?? 'active', location: f.location ?? null, note: f.note ?? null,
    created_at: ctx.now, updated_at: ctx.now, inspections: [],
  };
  return { item, log: { item_id: item.id, date: ctx.today, type: 'add', desc: 'Added via Safety tab' } };
}

export function planSafetyPatch(item: SafetyItem, raw: Record<string, unknown>, ctx: Ctx): { item: SafetyItem; log: SafetyLog } {
  const f = parseSafety(raw, item);
  const next = { ...item, ...f, updated_at: ctx.now };
  const changed = (Object.keys(f) as (keyof SafetyItem)[]).filter((k) => String(item[k] ?? '') !== String(next[k] ?? ''));
  return { item: next, log: { item_id: item.id, date: ctx.today, type: 'edit', desc: `Edited fields: ${changed.join(', ') || '(no change)'}` } };
}

/** The latest counted check sets `last_inspect` and `next_pm` (legacy); with none left, both are cleared on a delete. */
function recount(item: SafetyItem, inspections: Inspection[], clearWhenNone: boolean): SafetyItem {
  const counted = inspections.filter((i) => INSPECTION_RESULTS[i.result]).sort((a, b) => b.date.localeCompare(a.date));
  if (counted.length) return { ...item, inspections, last_inspect: counted[0].date, next_pm: counted[0].next_due };
  return clearWhenNone ? { ...item, inspections, last_inspect: null, next_pm: null } : { ...item, inspections };
}

function parseInspection(raw: unknown, current?: Inspection): Omit<Inspection, 'id' | 'created_at' | 'created_by'> {
  const b = Object.fromEntries(Object.entries(record(raw)).map(([k, v]) => [({ nextDue: 'next_due', by: 'inspector' } as Record<string, string>)[k] ?? k, v]));
  assertKnown(b, ['date', 'inspector', 'result', 'findings', 'next_due'], 'An inspection');
  const date = b.date === undefined && current ? current.date : isoDate(b.date, 'date') ?? bad('Please enter inspection date');
  const result = b.result === undefined ? current?.result ?? 'pass' : typeof b.result === 'string' && b.result in INSPECTION_RESULTS ? b.result as Inspection['result'] : bad(`result must be one of ${Object.keys(INSPECTION_RESULTS).join(', ')}`);
  return {
    date, result, inspector: b.inspector === undefined ? current?.inspector ?? null : text(b.inspector, 'inspector'),
    findings: b.findings === undefined ? current?.findings ?? null : text(b.findings, 'findings'),
    next_due: b.next_due === undefined ? current?.next_due ?? null : isoDate(b.next_due, 'next_due'),
  };
}
const LABEL: Record<string, string> = { pass: 'PASS', needs_work: 'NEEDS WORK', fail: 'FAIL', observation: 'OBSERVATION' };

export function planInspectionAdd(item: SafetyItem, raw: unknown, ctx: Ctx): { item: SafetyItem; log: SafetyLog } {
  const f = parseInspection(raw);
  const insp: Inspection = { id: newFleetId('insp'), ...f, created_at: ctx.now, created_by: ctx.by };
  const findings = f.findings ? ` · ${f.findings.slice(0, 60)}${f.findings.length > 60 ? '…' : ''}` : '';
  return {
    item: { ...recount(item, [...item.inspections, insp], false), updated_at: ctx.now },
    log: { item_id: item.id, date: f.date, type: 'inspect', desc: `Inspection · ${LABEL[f.result]}${f.inspector ? ` by ${f.inspector}` : ''}${findings}` },
  };
}
export function planInspectionPatch(item: SafetyItem, inspId: string, raw: unknown, ctx: Ctx): SafetyItem {
  const was = item.inspections.find((i) => i.id === inspId) ?? notFound(`Inspection ${inspId} is not on ${item.name}`);
  const next = { ...was, ...parseInspection(raw, was) };
  return { ...recount(item, item.inspections.map((i) => (i.id === inspId ? next : i)), false), updated_at: ctx.now };
}
export function planInspectionDelete(item: SafetyItem, inspId: string, ctx: Ctx): SafetyItem {
  if (!item.inspections.some((i) => i.id === inspId)) notFound(`Inspection ${inspId} is not on ${item.name}`);
  return { ...recount(item, item.inspections.filter((i) => i.id !== inspId), true), updated_at: ctx.now };
}

/** Legacy `_flSafetyStatus`: the nearer of expiry and next PM decides; replaced and missing say so. */
export function safetyState(item: Pick<SafetyItem, 'status' | 'expiry_date' | 'next_pm'>, today: string): { label: string; days: number | null; type?: 'expiry' | 'pm' } {
  if (item.status === 'replaced') return { label: 'REPLACED', days: null };
  if (item.status === 'missing') return { label: 'MISSING', days: null };
  const checks: { type: 'expiry' | 'pm'; days: number }[] = [];
  if (item.expiry_date) checks.push({ type: 'expiry', days: dayGap(today, item.expiry_date) });
  if (item.next_pm) checks.push({ type: 'pm', days: dayGap(today, item.next_pm) });
  const min = checks.reduce<{ type: 'expiry' | 'pm'; days: number } | undefined>((m, c) => (!m || c.days < m.days ? c : m), undefined);
  if (!min) return { label: 'OK_NO_PM', days: null };
  if (min.days < 0) return { label: 'EXPIRED', days: min.days, type: min.type };
  if (min.days <= 30) return { label: 'DUE', days: min.days, type: min.type };
  if (min.days <= 90) return { label: 'SOON', days: min.days, type: min.type };
  return { label: 'OK', days: min.days, type: min.type };
}

export const safetyView = (item: SafetyItem, today: string, log: readonly SafetyLog[] = []) => ({
  ...item, inspections: [...item.inspections].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)), state: safetyState(item, today),
  log: log.map(({ item_id: _i, ...l }) => l),
});
