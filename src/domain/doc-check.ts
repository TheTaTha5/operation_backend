/**
 * The document check (todo/booking-extras-model.md §3, approved 2026-10-09; migration 042): staff tick
 * six items comparing the agent's document with the booking, then mark it verified or an issue; the
 * browser's OCR pre-check proposes ticks. Legacy `docCheckToggleItem`, `docCheckSetStatus`,
 * `docCheckSetNote`, `docCheckRunPre`, `docCheckStatus`. Pure, so both stores decide identically.
 */
import { refuse, type HistoryLine } from './booking-actions.js';

export const DOC_ITEMS = ['route', 'date', 'lead', 'pax', 'voucher', 'payment'] as const;
export const PRE_ITEMS = [...DOC_ITEMS, 'cot'] as const;
export const PRE_RESULTS = ['match', 'maybe', 'mismatch', 'none'] as const;
export type DocItem = typeof DOC_ITEMS[number];
export type PreResult = { result: typeof PRE_RESULTS[number]; evidence: string | null; detail: string | null };
export type DocCheck = {
  status: 'pending' | 'verified' | 'issue' | null; by: string | null; at: string | null; note: string | null;
  items: Record<DocItem, boolean>;
  pre: { at: string | null; lang: string | null; error: string | null; text: string | null; results: Partial<Record<typeof PRE_ITEMS[number], PreResult>> } | null;
};
/** As a read shows it: the pre-check's `summary` is counted from its results. */
export type DocCheckView = DocCheck & { pre: (NonNullable<DocCheck['pre']> & { summary: Record<typeof PRE_RESULTS[number], number> }) | null };

const bad = (message: string): never => refuse(message, 400);
const noItems = (): Record<DocItem, boolean> => Object.fromEntries(DOC_ITEMS.map((k) => [k, false])) as Record<DocItem, boolean>;
/** Legacy creates the record as `pending` the first time something is ticked or pre-checked. */
export const emptyDocCheck = (): DocCheck => ({ status: 'pending', by: null, at: null, note: null, items: noItems(), pre: null });
export const copyDocCheck = (d: DocCheck): DocCheck => ({ ...d, items: { ...d.items }, pre: d.pre && { ...d.pre, results: { ...d.pre.results } } });

export function docCheckView(d: DocCheck | null): DocCheckView | null {
  if (!d) return null;
  const c = copyDocCheck(d);
  if (!c.pre) return { ...c, pre: null };
  const summary = { match: 0, maybe: 0, mismatch: 0, none: 0 };
  for (const item of DOC_ITEMS) summary[c.pre.results[item]?.result ?? 'none'] += 1;
  return { ...c, pre: { ...c.pre, summary } };
}
/** Legacy `docCheckStatus`: the record's status, else `pending` when files are attached, else `nofiles`. */
export const docCheckStatus = (d: DocCheck | null, attachments: number): string => d?.status ?? (attachments ? 'pending' : 'nofiles');

export const parseDocItem = (item: string): DocItem => (DOC_ITEMS as readonly string[]).includes(item) ? item as DocItem : bad(`item must be one of ${DOC_ITEMS.join(', ')}`);

export function withItem(current: DocCheck | null, item: DocItem, body: Record<string, unknown>): DocCheck {
  const checked = typeof body.checked === 'boolean' ? body.checked : bad('checked must be true or false');
  const next = copyDocCheck(current ?? emptyDocCheck());
  next.items[item] = checked!;
  return next;
}

/** Stamped now by the login; legacy's history line. Verified doesn't need every tick (decision C1). */
export function withStatus(current: DocCheck | null, body: Record<string, unknown>, now: string, by: string | null): { record: DocCheck; history: HistoryLine } {
  const status = body.status === 'verified' || body.status === 'issue' ? body.status : bad('status must be verified or issue');
  const next = copyDocCheck(current ?? emptyDocCheck());
  if (body.note !== undefined) next.note = body.note === null ? null : typeof body.note === 'string' ? body.note : bad('note must be text');
  Object.assign(next, { status, by, at: now });
  const text = `Document check · ${status === 'verified' ? '✅ verified' : '⚠ issue'}${next.note ? ` · ${next.note}` : ''}`;
  return { record: next, history: { by, kind: 'edit', tag: 'DocCheck', text } };
}

export function withNote(current: DocCheck | null, body: Record<string, unknown>): DocCheck {
  const note = body.note === null || body.note === '' ? null : typeof body.note === 'string' ? body.note : bad('note must be text');
  return { ...copyDocCheck(current ?? emptyDocCheck()), note };
}

/**
 * The browser's OCR result, stored as sent. Unless `auto_tick` is false, items it matched are ticked,
 * as legacy's `docCheckRunPre` does; it never unticks one.
 */
export function withPre(current: DocCheck | null, body: Record<string, unknown>): DocCheck {
  const text = (key: string): string | null => (body[key] === undefined || body[key] === null || body[key] === '' ? null : typeof body[key] === 'string' ? body[key] as string : bad(`${key} must be text`));
  const at = text('at');
  if (at !== null && Number.isNaN(Date.parse(at))) bad('at must be an ISO 8601 instant');
  const raw = body.results === undefined || body.results === null ? {} : typeof body.results === 'object' && !Array.isArray(body.results) ? body.results as Record<string, unknown> : bad('results must be an object of item to {s|result, ev|evidence, detail}');
  const results: Partial<Record<typeof PRE_ITEMS[number], PreResult>> = {};
  for (const [item, v] of Object.entries(raw!)) {
    if (!(PRE_ITEMS as readonly string[]).includes(item)) bad(`results.${item}: not an item (${PRE_ITEMS.join(', ')})`);
    const r = v !== null && typeof v === 'object' ? v as Record<string, unknown> : bad(`results.${item} must be an object`);
    const result = r!.result ?? r!.s;
    if (!(PRE_RESULTS as readonly unknown[]).includes(result)) bad(`results.${item}.result must be one of ${PRE_RESULTS.join(', ')}`);
    const str = (x: unknown) => (x === undefined || x === null || x === '' ? null : String(x));
    results[item as typeof PRE_ITEMS[number]] = { result: result as PreResult['result'], evidence: str(r!.evidence ?? r!.ev), detail: str(r!.detail) };
  }
  const next = copyDocCheck(current ?? emptyDocCheck());
  next.pre = { at: at ? new Date(at).toISOString() : new Date().toISOString(), lang: text('lang'), error: text('error'), text: text('text')?.slice(0, 3000) ?? null, results };
  if (body.auto_tick !== false && body.autoTick !== false) for (const item of DOC_ITEMS) if (results[item]?.result === 'match') next.items[item] = true;
  return next;
}

/** `PATCH /v1/bookings/{id}` may echo `doc_check` back unchanged; another value is refused, naming the commands. */
export function assertDocCheckEcho(sent: unknown, stored: DocCheckView | null): void {
  if (sent === undefined) return;
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
  if (canon(sent ?? null) !== canon(stored)) bad('doc_check cannot be changed with PATCH: use PUT /v1/bookings/{id}/doc-check/items/{item}, /status, /note or /pre');
}
