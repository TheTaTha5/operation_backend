/**
 * Contract templates and the contract documents issued from them (todo/sales-editing-model.md,
 * decision 9; migration 090). Legacy keeps both in the browser and syncs them as key/value blobs
 * (`contract_templates`, `agent_artifacts`; `ctt*`, `ctArtifactSave` in allotment_v2/js/08-app.js).
 *
 * The server decides the rules legacy's screen applied — one default, a unique code, the default never
 * switched off or deleted, a deleted template's agents falling back to the default — and freezes each
 * issued document. What a template says (`sections`, `text`) and how a document looks (`content`) is the
 * screen's vocabulary: stored as sent, checked only for shape.
 */
import { refuse } from './booking-actions.js';
import { withoutServerOwned, assertKnownKeys } from './server-owned.js';

const bad = (message: string): never => refuse(message, 400);
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(`${name} must be text`);
  return (value as string).trim() || null;
};
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export type ContractTemplate = {
  id: string; code: string; name: string; active: boolean; is_default: boolean; created_date: string | null; note: string | null;
  form: string | null; accent: string | null; accent_hex: string | null; font: string | null;
  /** Which sections print: `{cover: true, pricing: false, …}`. */
  sections: Record<string, boolean>;
  /** The wording, by language and key: `{en: {childRateTitle: "…", notRecItems: ["…"]}, th: {…}}`. */
  text: Record<string, Record<string, unknown>>;
  created_at: string; updated_at: string;
};
/** A list row: no wording, and how many agents are bound to it (legacy `cttUse`). */
export type ContractTemplateSummary = Omit<ContractTemplate, 'sections' | 'text'> & { agents: number };
export type ContractTemplateView = ContractTemplate & { agents: number };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** By code, then id: the order the template screen lists them. */
export const sortTemplates = (all: readonly ContractTemplate[]): ContractTemplate[] => [...all].sort((a, b) => cmp(a.code, b.code) || cmp(a.id, b.id));
export const templateSummary = ({ sections: _s, text: _t, ...t }: ContractTemplate, agents: number): ContractTemplateSummary => ({ ...t, agents });

/** Legacy `ctTmplDefault`: the active default, else the first active one, else any. */
export function defaultTemplate(all: readonly ContractTemplate[]): ContractTemplate | undefined {
  const active = sortTemplates(all).filter((t) => t.active);
  return active.find((t) => t.is_default) ?? active[0] ?? sortTemplates(all)[0];
}

/** Legacy `ctTmplForAgent`: the bound template if it exists and is active, else the default. */
export function effectiveTemplateId(boundId: string | null, all: readonly ContractTemplate[]): string | null {
  const bound = boundId ? all.find((t) => t.id === boundId) : undefined;
  return bound?.active ? bound.id : defaultTemplate(all)?.id ?? null;
}

const SECTIONS_AND_TEXT = (body: Record<string, unknown>, into: Partial<ContractTemplate>): void => {
  if (body.sections !== undefined) {
    if (!isObject(body.sections) || !Object.values(body.sections).every((v) => typeof v === 'boolean')) bad('sections must map each section to true or false');
    into.sections = { ...(body.sections as Record<string, boolean>) };
  }
  if (body.text !== undefined) {
    if (!isObject(body.text) || !Object.values(body.text).every(isObject)) bad('text must map each language to its wording: {"en": {…}, "th": {…}}');
    for (const [lang, entries] of Object.entries(body.text as Record<string, Record<string, unknown>>)) {
      for (const [key, value] of Object.entries(entries)) {
        if (!(typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string')))) bad(`text.${lang}.${key} must be text or a list of text`);
      }
    }
    into.text = JSON.parse(JSON.stringify(body.text)) as ContractTemplate['text'];
  }
};
const STYLE = ['form', 'accent', 'font'] as const;

function parseTemplateFields(body: Record<string, unknown>): Partial<ContractTemplate> {
  assertKnownKeys(body, ['code', 'name', 'note', 'active', ...STYLE, 'accent_hex', 'accentHex', 'sections', 'text'], 'A contract template');
  const out: Partial<ContractTemplate> = {};
  if (body.code !== undefined) out.code = text(body.code, 'code') ?? bad('code cannot be blank');
  if (body.name !== undefined) out.name = text(body.name, 'name') ?? bad('name cannot be blank');
  if (body.note !== undefined) out.note = text(body.note, 'note');
  if (body.active !== undefined) out.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  for (const key of STYLE) if (body[key] !== undefined) out[key] = text(body[key], key);
  const hex = body.accent_hex !== undefined ? body.accent_hex : body.accentHex;
  if (hex !== undefined) {
    const v = text(hex, 'accent_hex');
    // Legacy's `cttSetHex` keeps only a full #RRGGBB; here a wrong one is refused rather than blanked.
    if (v !== null && !/^#[0-9a-fA-F]{6}$/.test(v)) bad('accent_hex must be a colour like #1A2B43, or empty');
    out.accent_hex = v;
  }
  SECTIONS_AND_TEXT(body, out);
  return out;
}

const assertCodeFree = (code: string, all: readonly ContractTemplate[], exceptId?: string): void => {
  const clash = all.find((t) => t.id !== exceptId && t.code.toLowerCase() === code.toLowerCase());
  if (clash) refuse(`Code ${code} is already template ${clash.name} (${clash.id})'s`, 409, 'code_taken');
};

/** The next free `CT-NN` (legacy numbered by count, which is how two came to share CT-06). */
export function nextTemplateCode(all: readonly ContractTemplate[]): string {
  const max = all.reduce((n, t) => Math.max(n, Number(/^CT-(\d+)$/i.exec(t.code)?.[1] ?? 0)), 0);
  return `CT-${String(max + 1).padStart(2, '0')}`;
}

export const TEMPLATE_SERVER_OWNED: Record<string, string> = {
  id: 'a template\'s id never changes', is_default: 'use POST /v1/contract-templates/{id}/default', isDefault: 'use POST /v1/contract-templates/{id}/default',
  created_date: 'it is the day the template was made', agents: 'it is worked out by the server',
  created_at: 'it is worked out by the server', updated_at: 'it is worked out by the server',
};

/**
 * `POST /v1/contract-templates` (legacy `cttNew`): a copy of the default's style, sections and text,
 * so a new template starts as the contract prints today. The first template there is becomes the default.
 */
export function planTemplateCreate(body: Record<string, unknown>, all: readonly ContractTemplate[], ctx: { id: string; now: string; today: string }): ContractTemplate {
  for (const key of Object.keys(TEMPLATE_SERVER_OWNED)) if (body[key] !== undefined) bad(`${key} cannot be set: ${TEMPLATE_SERVER_OWNED[key]}`);
  const f = parseTemplateFields(body);
  const code = f.code ?? nextTemplateCode(all);
  assertCodeFree(code, all);
  const base = defaultTemplate(all);
  const first = all.length === 0;
  return {
    id: ctx.id, code, name: f.name ?? 'Template ใหม่', active: first ? true : f.active ?? true, is_default: first, created_date: ctx.today, note: f.note ?? null,
    form: f.form !== undefined ? f.form : base?.form ?? 'ocean', accent: f.accent !== undefined ? f.accent : base?.accent ?? 'navy',
    accent_hex: f.accent_hex !== undefined ? f.accent_hex : base?.accent_hex ?? null, font: f.font !== undefined ? f.font : base?.font ?? 'manrope',
    sections: f.sections ?? { ...(base?.sections ?? {}) }, text: f.text ?? JSON.parse(JSON.stringify(base?.text ?? { en: {}, th: {} })),
    created_at: ctx.now, updated_at: ctx.now,
  };
}

/** `PATCH /v1/contract-templates/{id}`. Legacy `cttToggleActive`: the default cannot be switched off. */
export function planTemplatePatch(stored: ContractTemplate, body: Record<string, unknown>, view: ContractTemplateView, all: readonly ContractTemplate[], now: string): ContractTemplate {
  const f = parseTemplateFields(withoutServerOwned(body, view as unknown as Record<string, unknown>, TEMPLATE_SERVER_OWNED));
  if (f.code !== undefined && f.code.toLowerCase() !== stored.code.toLowerCase()) assertCodeFree(f.code, all, stored.id);
  if (f.active === false && stored.is_default) refuse('The default template cannot be switched off. Make another template the default first', 409, 'default_template');
  return { ...stored, ...f, updated_at: now };
}

/** Legacy `cttDelete`: never the default. */
export function assertTemplateDeletable(stored: ContractTemplate): void {
  if (stored.is_default) refuse('The default template cannot be deleted', 409, 'default_template');
}

// ── Issued documents ─────────────────────────────────────────────────────────────────────────────

export type ContractDocument = {
  id: string; agent_id: string; contract_id: string | null; version: string; lang: 'en' | 'th' | null;
  generated_at: string; generated_by: string | null;
  template_id: string | null; template_name: string | null; rate_type_ref: string | null; rate_type_name: string | null;
  page_count: number | null;
  /** The render as printed: sections, style, the template's text, overrides, custom clauses. */
  content: Record<string, unknown>;
};
export type ContractDocumentSummary = Omit<ContractDocument, 'content'>;
export const documentSummary = ({ content: _c, ...doc }: ContractDocument): ContractDocumentSummary => doc;
/** Newest first (legacy `unshift`), then id. */
export const sortDocuments = (docs: readonly ContractDocument[]): ContractDocument[] =>
  [...docs].sort((a, b) => cmp(b.generated_at, a.generated_at) || cmp(b.id, a.id));

export type DocumentRequest = { contract_id: string | null; template_id: string | null; lang: 'en' | 'th'; page_count: number | null; content: Record<string, unknown> };
export function parseDocument(body: Record<string, unknown>): DocumentRequest {
  for (const key of ['id', 'version', 'generated_at', 'generated_by', 'template_name', 'rate_type_ref', 'rate_type_name', 'agent_id']) {
    if (body[key] !== undefined) bad(`${key} cannot be sent: the server records it when the document is issued`);
  }
  assertKnownKeys(body, ['contract_id', 'template_id', 'lang', 'page_count', 'content'], 'A contract document');
  const lang = body.lang === 'en' || body.lang === 'th' ? body.lang : bad('lang must be en or th');
  if (!isObject(body.content)) bad('content must be an object: the document as printed');
  const pages = body.page_count === undefined || body.page_count === null ? null
    : typeof body.page_count === 'number' && Number.isInteger(body.page_count) && body.page_count >= 0 ? body.page_count : bad('page_count must be a whole number ≥ 0');
  return { contract_id: text(body.contract_id, 'contract_id'), template_id: text(body.template_id, 'template_id'), lang, page_count: pages, content: JSON.parse(JSON.stringify(body.content)) };
}

/**
 * Legacy `ctArtifactSave`: the document is frozen with the agent's contract version (`draft` when it
 * has none), the template's name and the rate's code and name as they are now: a template or rate
 * edited later does not change a contract already sent.
 */
export function planDocument(req: DocumentRequest, ctx: {
  id: string; now: string; by: string | null; agent: { id: string; contract_version: string | null };
  contract: { id: string; agent_id: string } | undefined; template: ContractTemplate | undefined; rate: { code: string | null; name: string } | undefined;
}): ContractDocument {
  if (req.contract_id !== null && (!ctx.contract || ctx.contract.agent_id !== ctx.agent.id)) bad(`contract_id ${req.contract_id} is not one of agent ${ctx.agent.id}'s contracts`);
  if (req.template_id !== null && !ctx.template) bad(`template_id ${req.template_id} is not a contract template (GET /v1/contract-templates)`);
  return {
    id: ctx.id, agent_id: ctx.agent.id, contract_id: req.contract_id, version: ctx.agent.contract_version || 'draft', lang: req.lang,
    generated_at: ctx.now, generated_by: ctx.by, template_id: req.template_id, template_name: ctx.template?.name ?? null,
    rate_type_ref: ctx.rate?.code ?? null, rate_type_name: ctx.rate?.name ?? null, page_count: req.page_count, content: req.content,
  };
}
export const documentLine = (doc: ContractDocument): string => `Contract generated${doc.version ? ` · ${doc.version}` : ''}${doc.lang ? ` · ${doc.lang.toUpperCase()}` : ''}`;
