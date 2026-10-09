/**
 * Attachments (todo/booking-extras-model.md §1, approved 2026-10-09; migration 040): files uploaded
 * once and pointed at by a booking's documents and its upgrade sales' payment slips. Legacy
 * `POST /api/attach` (server.js), `bkV2AttachUpload`, `pckSlipUpload`. Pure, so both stores decide
 * identically.
 */
import { randomBytes } from 'node:crypto';
import { refuse } from './booking-actions.js';

export const ATTACHMENT_MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
export const DOCUMENT_KINDS = ['upload', 'capture', 'paste'] as const;

/** A file as every reference shows it: no bytes. */
export type AttachmentRef = { id: string; name: string; mime: string; size: number };
export type AttachmentMeta = AttachmentRef & { uploaded_by: string | null; uploaded_at: string };
export type StoredFile = AttachmentMeta & { data: Buffer };
/** One of a booking's documents, as read. */
export type BookingDocument = AttachmentRef & { kind: typeof DOCUMENT_KINDS[number] | null; by: string | null; at: string | null };
/** As a store writes it. */
export type DocumentRow = { attachment_id: string; kind: BookingDocument['kind']; by: string | null; at: string | null };

const bad = (message: string): never => refuse(message, 400);

/** Legacy's id shape, `att_<base36 time>_<10 hex>`. */
export const newAttachmentId = (): string => `att_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;

/** `POST /v1/attachments`: legacy's JSON `{filename, mime, dataB64}`. */
export function parseUpload(body: Record<string, unknown>): { filename: string; mime: string; data: Buffer } {
  const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : bad('filename is required');
  const mime = (ATTACHMENT_MIMES as readonly unknown[]).includes(body.mime) ? body.mime as string : bad(`mime must be one of ${ATTACHMENT_MIMES.join(', ')}`);
  const raw = body.data_b64 ?? body.dataB64;
  if (typeof raw !== 'string' || !raw) bad('data_b64 is required: the file, base64');
  const text = (raw as string).replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(text)) bad('data_b64 is not base64');
  const data = Buffer.from(text, 'base64');
  if (data.length === 0) bad('The file is empty');
  if (data.length > MAX_ATTACHMENT_BYTES) bad(`The file is ${(data.length / 1048576).toFixed(1)} MB; the limit is 6 MB`);
  return { filename: filename!, mime: mime!, data };
}

/** A list of `{id}` (or bare ids), as a booking field or an upgrade's `slips` sends it. */
export function parseAttachmentIds(value: unknown, label: string): { id: string; kind?: string }[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${label} must be a list`);
  const list = (value as unknown[]).map((raw, i) => {
    const entry = typeof raw === 'string' ? { id: raw } : raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : bad(`${label}[${i}] must be an attachment id or {id}`);
    const id = typeof entry!.id === 'string' && entry!.id ? entry!.id : bad(`${label}[${i}].id is required`);
    const kind = entry!.kind;
    if (kind !== undefined && kind !== null && !(DOCUMENT_KINDS as readonly unknown[]).includes(kind)) bad(`${label}[${i}].kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
    return { id: id!, ...(typeof kind === 'string' ? { kind } : {}) };
  });
  if (new Set(list.map((a) => a.id)).size !== list.length) bad(`${label} names an attachment twice`);
  return list;
}

/** Refuses an id no file has: `400`, naming it. */
export function assertKnownFiles(ids: readonly string[], known: ReadonlySet<string>, label: string): void {
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) bad(`${label}: no attachment ${missing.join(', ')}; upload it with POST /v1/attachments first`);
}

/** A booking's documents to store: a kept one keeps who added it and when; a new one is stamped now. */
export function documentRows(input: readonly { id: string; kind?: string }[], current: readonly BookingDocument[], now: string, by: string | null): DocumentRow[] {
  return input.map((a) => {
    const was = current.find((d) => d.id === a.id);
    return { attachment_id: a.id, kind: (a.kind ?? was?.kind ?? null) as DocumentRow['kind'], by: was ? was.by : by, at: was ? was.at : now };
  });
}
