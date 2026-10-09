/**
 * Maps legacy's sales-editing data (todo/sales-editing-model.md) for `import-legacy.ts`: contract
 * templates, issued contract documents, the renewal archive, custom nationalities and insurance ages.
 * Pure, so `test/legacy-sales.test.ts` can replay legacy's real shapes.
 *
 * Legacy keeps templates and documents as key/value JSON (`contract_templates`, `agent_artifacts`),
 * the archive as columns (`sb_agents__contracthistory`, which dropped the archived rate type), custom
 * nationalities as rows (`sb_nationalities`), and insurance as key/value JSON keyed
 * `<booking>::lead` or `<booking>::<passenger index>` (`insurance_overrides`).
 */
import { parseAge } from '../domain/insurance.js';
import { BUILTIN_NATIONALITIES } from '../domain/nationalities.js';

type Row = Record<string, unknown>;
const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown): string | null => { const s = str(value).slice(0, 10); return ISO_DAY.test(s) && !Number.isNaN(Date.parse(s)) ? s : null; };
const json = (value: unknown): unknown => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return undefined; } };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const instant = (value: unknown): string | null => {
  const n = typeof value === 'number' ? value : NaN;
  if (Number.isFinite(n)) return new Date(n).toISOString();
  const s = str(value);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
};

export type SalesImport = { templates: Row[]; documents: Row[]; history: Row[]; issues: string[] };

/**
 * Templates keep legacy's ids and codes (two share CT-06: listed, kept); the default is legacy's
 * `isDefault`. Documents keep their `gc_…` ids, under an agent this import writes; a document's
 * contract is kept only when the contract is here. The archive is written oldest first, so the newest
 * has the highest id, as a renewal here writes it.
 */
export function mapLegacySales(input: {
  templates: Row[]; artifacts: Row[]; history: Row[]; agentIds: ReadonlySet<string>; contractIds: ReadonlySet<string>;
}): SalesImport {
  const issues: string[] = [];
  const templates: Row[] = [];
  const codes = new Map<string, string>();
  let defaults = 0;
  for (const raw of input.templates) {
    const t = json(raw.value);
    if (!isObject(t) || !str(t.id ?? raw.id)) { issues.push(`template ${str(raw.id)} skipped: not readable`); continue; }
    const id = str(t.id ?? raw.id), code = str(t.code) || id;
    if (codes.has(code.toLowerCase())) issues.push(`template ${id}: code ${code} is also ${codes.get(code.toLowerCase())}'s (kept; a new or changed code here must be unique)`);
    codes.set(code.toLowerCase(), id);
    const isDefault = t.isDefault === true && defaults++ === 0;
    if (t.isDefault === true && !isDefault) issues.push(`template ${id}: a second default, imported as not the default`);
    templates.push({
      id, code, name: str(t.name) || code, active: isDefault ? true : t.active !== false, is_default: isDefault, created_date: day(t.createdDate),
      note: str(t.note) || null, form: str(t.form) || null, accent: str(t.accent) || null,
      accent_hex: /^#[0-9a-fA-F]{6}$/.test(str(t.accentHex)) ? str(t.accentHex) : null, font: str(t.font) || null,
      sections: isObject(t.sections) ? t.sections : {}, text: isObject(t.text) ? t.text : {},
    });
  }

  const documents: Row[] = [];
  for (const raw of input.artifacts) {
    const agentId = str(raw.id);
    const list = json(raw.value);
    if (!Array.isArray(list)) { issues.push(`documents of agent ${agentId} skipped: not a list`); continue; }
    if (!input.agentIds.has(agentId)) { issues.push(`${list.length} document(s) of agent ${agentId} skipped: the agent is not imported`); continue; }
    for (const a of list) {
      if (!isObject(a) || !str(a.id)) { issues.push(`a document of agent ${agentId} skipped: no id`); continue; }
      const generatedAt = instant(a.generatedAt);
      if (!generatedAt) { issues.push(`document ${str(a.id)} skipped: no readable time`); continue; }
      const contractId = str(a.contractId) || null;
      if (contractId && !input.contractIds.has(contractId)) issues.push(`document ${str(a.id)}: contract ${contractId} is not here, imported without it`);
      const lang = a.lang === 'th' ? 'th' : a.lang === 'en' ? 'en' : null;
      documents.push({
        id: str(a.id), agent_id: agentId, contract_id: contractId && input.contractIds.has(contractId) ? contractId : null, version: str(a.version) || 'draft', lang,
        generated_at: generatedAt, generated_by: null, template_id: str(a.templateId) || null, template_name: str(a.templateName) || null,
        rate_type_ref: str(a.rateTypeRef) || null, rate_type_name: str(a.rateTypeName) || null,
        page_count: Number.isInteger(a.pageCount) && (a.pageCount as number) >= 0 ? a.pageCount : null,
        content: { sections: a.sections ?? {}, form: a.form ?? null, accent: a.accent ?? null, accentHex: a.accentHex ?? null, font: a.font ?? null,
          tmplText: a.tmplText ?? null, overrides: a.overrides ?? {}, customClauses: a.customClauses ?? [] },
      });
    }
  }

  const history: Row[] = [];
  const byAgent = new Map<string, Row[]>();
  for (const h of input.history) (byAgent.get(str(h.sb_agents_id)) ?? byAgent.set(str(h.sb_agents_id), []).get(str(h.sb_agents_id))!).push(h);
  for (const [agentId, rows] of byAgent) {
    if (!input.agentIds.has(agentId)) { issues.push(`${rows.length} archived contract(s) of agent ${agentId} skipped: the agent is not imported`); continue; }
    // Legacy unshifts each archive, so idx 0 is the newest: written oldest first.
    for (const h of [...rows].sort((a, b) => Number(b.idx) - Number(a.idx))) {
      const archivedAt = day(h.archivedat);
      if (!archivedAt) { issues.push(`archived contract ${str(h.version)} of agent ${agentId} skipped: no archive date`); continue; }
      const periods = json(h.snapshot_programperiods);
      const programs = Array.isArray(periods) ? periods.filter(isObject).map((p) => ({ route_id: str(p.routeId), book_from: day(p.bookFrom), book_to: day(p.bookTo), note: str(p.note) || null })).filter((p) => p.route_id) : [];
      const signatory = { name: str(h.snapshot_agentsignatory_name) || null, designation: str(h.snapshot_agentsignatory_designation) || null,
        tel: str(h.snapshot_agentsignatory_tel) || null, signed_date: day(h.snapshot_agentsignatory_signeddate) };
      history.push({
        agent_id: agentId, version: str(h.version) || null, archived_at: archivedAt, contract_start: day(h.contractstart), contract_end: day(h.contractend),
        rate_type_id: null, programs, signatory: Object.values(signatory).some((v) => v !== null) ? signatory : null, archived_by: null,
      });
    }
  }
  return { templates, documents, history, issues };
}

/** Legacy's custom nationalities, unmerged (decision 11). A code that is a built-in's is listed and left out. */
export function mapLegacyNationalities(rows: Row[]): { nationalities: Row[]; issues: string[] } {
  const builtin = new Set(BUILTIN_NATIONALITIES.map(([code]) => code));
  const issues: string[] = [];
  const nationalities: Row[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const code = str(r.code), name = str(r.name);
    if (!code || !name) { issues.push(`nationality "${code || name}" skipped: no code or name`); continue; }
    if (builtin.has(code)) { issues.push(`nationality ${code} (${name}) skipped: ${code} is a built-in`); continue; }
    if (seen.has(code)) { issues.push(`nationality ${code} (${name}) skipped: code repeated`); continue; }
    seen.add(code);
    // Legacy lists them in the order they were added; `created_at` keeps that order here.
    nationalities.push({ code, name, builtin: false, sort: null, created_at: new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(), created_by: null });
  }
  return { nationalities, issues };
}

/**
 * Writes legacy's insurance ages and review ticks onto the imported bookings' rows, in place: the lead's
 * on the booking, a passenger's on the passenger at that legacy index. `at` becomes the review time;
 * legacy never recorded who. Rows that point at nothing imported are counted.
 */
export function applyLegacyInsurance(rows: Row[], ctx: {
  bookingId: (legacyId: string) => string; bookings: ReadonlyMap<string, Row>; passengerSeq: ReadonlyMap<string, number>; passengers: ReadonlyMap<string, Row>;
}, note: (what: string) => void): number {
  let applied = 0;
  for (const r of rows) {
    const key = str(r.key);
    const cut = key.lastIndexOf('::');
    const v = json(r.value);
    if (cut < 0 || !isObject(v)) { note('insurance rows dropped: not readable'); continue; }
    const legacyBooking = key.slice(0, cut), who = key.slice(cut + 2);
    let age: number | null = null;
    if (v.age !== undefined && str(v.age) !== '') {
      try { age = parseAge(v.age, 'age'); } catch { note('insurance ages dropped: not a number from 0 to 999'); }
    }
    const reviewedAt = v.reviewed === true ? instant(v.at) : null;
    if (v.reviewed === true && !reviewedAt) note('insurance reviews dropped: no time');
    let target: Row | undefined;
    if (who === 'lead') target = ctx.bookings.get(ctx.bookingId(legacyBooking));
    else {
      const seq = ctx.passengerSeq.get(`${legacyBooking}::${who}`);
      target = seq === undefined ? undefined : ctx.passengers.get(`${ctx.bookingId(legacyBooking)}::${seq}`);
    }
    if (!target) { note('insurance rows dropped: booking or passenger not imported'); continue; }
    if (who === 'lead') Object.assign(target, { lead_age: age, lead_insurance_reviewed_at: reviewedAt });
    else Object.assign(target, { age, insurance_reviewed_at: reviewedAt });
    applied++;
  }
  return applied;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export type StaffBoardImport = { staff: Row[]; quotas: Row[]; targets: Row[]; followups: Row[]; issues: string[] };

/**
 * Staff and their 2026 quota (`sb_staff`, `quota_2026`), and the Sales Board's targets and follow-up
 * marks (`sb_sales.targets` `{"2026-07": 120}`, `sb_sales.followup` `{"2026-07::a56": true,
 * "foc:2026-07::a56": true}`), for `--sales`. Legacy never recorded when a target or mark was set:
 * `at` (the import's time) stands in. What does not parse is listed and skipped.
 */
export function mapLegacyStaffAndBoard(input: { staff: Row[]; sales: Row[]; salesIds: ReadonlySet<string>; agentIds: ReadonlySet<string>; at: string }): StaffBoardImport {
  const issues: string[] = [];
  const staff: Row[] = [], quotas: Row[] = [], targets: Row[] = [], followups: Row[] = [];
  for (const s of input.staff) {
    const id = str(s.id);
    if (!id) { issues.push('a staff row skipped: no id'); continue; }
    staff.push({ id, code: str(s.code) || null, name: str(s.name), dept: str(s.dept) || null, active: s.active !== false });
    if (s.quota_2026 == null || str(s.quota_2026) === '') continue;
    const n = Number(s.quota_2026);
    if (!Number.isInteger(n) || n < 0) { issues.push(`staff ${id}: 2026 quota ${str(s.quota_2026)} is not a whole number, 0 or more: skipped`); continue; }
    quotas.push({ staff_id: id, year: 2026, free_seats: n });
  }
  for (const s of input.sales) {
    const salesId = str(s.id);
    if (!input.salesIds.has(salesId)) continue;
    const t = json(s.targets);
    if (s.targets != null && str(s.targets) !== '' && !isObject(t)) issues.push(`salesperson ${salesId}: targets are not readable, skipped`);
    for (const [month, raw] of Object.entries(isObject(t) ? t : {})) {
      const pax = Number(raw);
      // Legacy deletes a 0 target; one that is still there is skipped the same way.
      if (!MONTH.test(month) || !Number.isInteger(pax) || pax <= 0) { issues.push(`salesperson ${salesId}: target ${month} = ${String(raw)} skipped (not a month, or not a whole number above 0)`); continue; }
      targets.push({ sales_id: salesId, month, pax, set_at: input.at, set_by: null });
    }
    const f = json(s.followup);
    if (s.followup != null && str(s.followup) !== '' && !isObject(f)) issues.push(`salesperson ${salesId}: follow-up marks are not readable, skipped`);
    for (const [key, raw] of Object.entries(isObject(f) ? f : {})) {
      if (!raw) continue;
      const m = /^(?:(foc):)?(\d{4}-\d{2})::(.+)$/.exec(key);
      if (!m || !MONTH.test(m[2])) { issues.push(`salesperson ${salesId}: follow-up mark ${key} skipped (not legacy's "[foc:]YYYY-MM::agent")`); continue; }
      if (!input.agentIds.has(m[3])) { issues.push(`salesperson ${salesId}: follow-up mark ${key} skipped: agent ${m[3]} is not here`); continue; }
      followups.push({ sales_id: salesId, month: m[2], agent_id: m[3], kind: m[1] === 'foc' ? 'foc' : 'agent', marked_at: input.at, marked_by: null });
    }
  }
  return { staff, quotas, targets, followups, issues };
}
