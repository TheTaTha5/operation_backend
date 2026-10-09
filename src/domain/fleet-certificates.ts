/**
 * Boat certificates: expiry status, the Documents matrix and renewal (legacy `06-engine-assign.js`
 * `flDocStatus`, `flGuessDocType`, `flDocBetter`, `flRenderDocsList`; `08-app.js` `depSave`). The rows
 * are the boat's `documents` (migration 070); everything here is computed from them. Pure, so both
 * stores decide identically (todo/fleet-maintenance-model.md, "Design — extras" 2).
 */
import type { BoatDocument, BoatRecord } from './catalogue.js';
import { assertKnown, bad, dayGap, isoDate, record, required } from './fleet-common.js';

export type DocStatus = 'processing' | 'na' | 'exp' | 'warn30' | 'warn90' | 'ok';
/** Legacy `FL_DOC_TYPES`, in its groups, with the name a new row of that type gets. */
export const DOC_TYPES = [
  { id: 'lic', group: 'เจ้าท่า', name: 'ใบอนุญาตใช้เรือ' },
  { id: 'inspect', group: 'เจ้าท่า', name: 'ใบสำคัญรับรองการตรวจเรือ' },
  { id: 'ins', group: 'ประกันภัย', name: 'ประกันภัยเรือ' },
  { id: 'similan', group: 'เข้าพื้นที่', name: 'ใบอนุญาต สิมิลัน' },
  { id: 'surin', group: 'เข้าพื้นที่', name: 'ใบอนุญาต สุรินทร์' },
  { id: 'pp', group: 'เข้าพื้นที่', name: 'ใบอนุญาต พีพี' },
  { id: 'phangnga', group: 'เข้าพื้นที่', name: 'ใบอนุญาต อ่าวพังงา' },
  { id: 'tarn', group: 'เข้าพื้นที่', name: 'ใบอนุญาต ธารโบกขรณี' },
] as const;

/** Legacy `flDocStatus`: processing first, then no expiry, then the days left (rounded up). */
export function docStatus(d: Pick<BoatDocument, 'expires_on' | 'renew_status'>, today: string): { status: DocStatus; days_left: number | null } {
  const days = d.expires_on ? dayGap(today, d.expires_on) : null;
  if (d.renew_status === 'processing') return { status: 'processing', days_left: days };
  if (days === null) return { status: 'na', days_left: null };
  return { status: days < 0 ? 'exp' : days < 30 ? 'warn30' : days < 90 ? 'warn90' : 'ok', days_left: days };
}

/** Legacy `flGuessDocType`: the type a name reads as; anything else is `other`. */
export function docType(name: string): string {
  const n = name.toLowerCase();
  if (/สิมิลัน|similan/.test(n)) return 'similan';
  if (/สุรินทร์|surin/.test(n)) return 'surin';
  if (/พีพี|phi ?phi/.test(n)) return 'pp';
  if (/พังงา|phang ?nga/.test(n)) return 'phangnga';
  if (/ธาร|โบก/.test(n)) return 'tarn';
  if (/ประกัน/.test(n)) return 'ins';
  if (/ตรวจสภาพ|ตรวจเรือ|ใบสำคัญ/.test(n)) return 'inspect';
  if (/ใบอนุญาต/.test(n)) return 'lic';
  return 'other';
}

/** Legacy `flDocBetter`: whether `doc` shows instead of `existing` for its type. */
function better(existing: BoatDocument | undefined, doc: BoatDocument): boolean {
  if (!existing) return true;
  if (doc.renew_status === 'processing') return true;
  if (existing.renew_status === 'done' && doc.renew_status !== 'done') return true;
  if (!existing.expires_on && doc.expires_on) return true;
  return !!(doc.expires_on && existing.expires_on && doc.expires_on > existing.expires_on);
}

/** Every row with its type, status and whether it is the one shown for its type (`current`). */
export function documentsView(docs: readonly BoatDocument[], today: string) {
  const best = new Map<string, number>();
  docs.forEach((d, i) => {
    const t = docType(d.name);
    if (t === 'other') return;
    const at = best.get(t);
    if (better(at === undefined ? undefined : docs[at], d)) best.set(t, i);
  });
  return docs.map((d, idx) => {
    const t = docType(d.name);
    return { idx, ...d, doc_type: t, ...docStatus(d, today), current: t === 'other' ? true : best.get(t) === idx };
  });
}

/**
 * `GET /v1/fleet/certificates` (legacy `flRenderDocsList`): the company's boats in service against the
 * eight types, each cell the row shown for it (none: `na`), and the counters over those cells.
 */
export function certificateMatrix(boats: readonly BoatRecord[], today: string) {
  const counts: Record<DocStatus, number> = { ok: 0, warn90: 0, warn30: 0, exp: 0, processing: 0, na: 0 };
  const expired = new Set<string>();
  const issues: { boat_id: string; doc_type: string; name: string; status: DocStatus; expires_on: string | null; days_left: number | null }[] = [];
  const rows = boats.filter((b) => b.ownership !== 'charter' && !b.retired).map((b) => {
    const docs = documentsView(b.documents, today);
    const cells: Record<string, ReturnType<typeof documentsView>[number] | null> = {};
    for (const t of DOC_TYPES) {
      const cell = docs.find((d) => d.doc_type === t.id && d.current) ?? null;
      cells[t.id] = cell;
      counts[cell ? cell.status : 'na'] += 1;
      if (cell?.status === 'exp') expired.add(b.id);
      if (cell && (cell.status === 'exp' || cell.status === 'warn30')) {
        issues.push({ boat_id: b.id, doc_type: t.id, name: cell.name, status: cell.status, expires_on: cell.expires_on, days_left: cell.days_left });
      }
    }
    return { boat_id: b.id, name: b.name, pier: b.pier, cells, others: docs.filter((d) => d.doc_type === 'other') };
  });
  const total = rows.length * DOC_TYPES.length;
  return {
    date: today, types: DOC_TYPES, boats: rows, counts, valid_pct: total ? Math.round(((counts.ok + counts.warn90) / total) * 100) : 0,
    expired_boats: [...expired], issues: issues.sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0)),
  };
}

/**
 * `POST /v1/boats/{id}/documents/renew` (legacy `depSave`): `exp` clears the latest row's renewal mark,
 * `processing` marks it (or adds a row), `ok` adds the renewed row and closes the name's processing rows.
 */
export function renewedDocuments(docs: readonly BoatDocument[], raw: unknown): BoatDocument[] {
  const b = record(raw);
  assertKnown(b, ['name', 'state', 'expires_on'], 'A renewal');
  const name = required(b.name, 'name', 'name is required: the document to renew');
  const state = b.state === 'exp' || b.state === 'processing' || b.state === 'ok' ? b.state : bad('state must be exp, processing or ok');
  const exp = isoDate(b.expires_on, 'expires_on');
  const next = docs.map((d) => ({ ...d }));
  const latest = [...next].reverse().find((d) => d.name === name);
  if (state === 'exp') {
    if (latest) latest.renew_status = null;
  } else if (state === 'processing') {
    if (latest) { latest.renew_status = 'processing'; if (exp) latest.expires_on = exp; }
    else next.push({ name, expires_on: exp, renew_status: 'processing' });
  } else {
    if (!exp) bad('expires_on is required: the new expiry date (กรุณาระบุวันหมดอายุใหม่)');
    for (const d of next) if (d.name === name && d.renew_status === 'processing') d.renew_status = 'done';
    next.push({ name, expires_on: exp, renew_status: null });
  }
  return next;
}
