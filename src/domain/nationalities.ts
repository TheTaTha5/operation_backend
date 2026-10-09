/**
 * The nationality list the booking form picks from (todo/sales-editing-model.md, decision 11;
 * migration 092). Legacy hard-codes the built-ins in the browser (`BKV2_NATIONALITIES`) and adds a custom
 * one whenever an unknown name is typed (`bkV2AddCustomNat`), with no edit guard. Here the server owns the
 * list and the rule; adding needs the `operations` area.
 */
import { refuse } from './booking-actions.js';
import { assertKnownKeys } from './server-owned.js';

export type Nationality = { code: string; name: string; custom: boolean };
export type StoredNationality = { code: string; name: string; builtin: boolean; sort: number | null; created_at: string; created_by: string | null };

/** Legacy `BKV2_NATIONALITIES`, in its order; migration 092 seeds the same rows. */
export const BUILTIN_NATIONALITIES: readonly [string, string][] = [
  ['TH', 'Thai'], ['CN', 'Chinese'], ['RU', 'Russian'], ['IN', 'Indian'], ['KR', 'Korean'], ['JP', 'Japanese'], ['US', 'American'], ['GB', 'British'],
  ['DE', 'German'], ['FR', 'French'], ['IT', 'Italian'], ['ES', 'Spanish'], ['AU', 'Australian'], ['NZ', 'New Zealander'], ['CA', 'Canadian'], ['NL', 'Dutch'],
  ['SE', 'Swedish'], ['NO', 'Norwegian'], ['DK', 'Danish'], ['FI', 'Finnish'], ['PL', 'Polish'], ['UA', 'Ukrainian'], ['KZ', 'Kazakh'], ['IL', 'Israeli'],
  ['SG', 'Singaporean'], ['MY', 'Malaysian'], ['ID', 'Indonesian'], ['PH', 'Filipino'], ['VN', 'Vietnamese'], ['TW', 'Taiwanese'], ['HK', 'Hong Konger'], ['AE', 'Emirati'],
  ['SA', 'Saudi'], ['BR', 'Brazilian'], ['AR', 'Argentinian'], ['MX', 'Mexican'], ['ZA', 'South African'], ['EG', 'Egyptian'], ['TR', 'Turkish'], ['IR', 'Iranian'],
  ['CH', 'Swiss'], ['AT', 'Austrian'], ['BE', 'Belgian'], ['PT', 'Portuguese'], ['GR', 'Greek'], ['IE', 'Irish'], ['CZ', 'Czech'], ['SK', 'Slovak'],
  ['RO', 'Romanian'], ['HU', 'Hungarian'], ['BG', 'Bulgarian'], ['HR', 'Croatian'], ['RS', 'Serbian'], ['BY', 'Belarusian'], ['GE', 'Georgian'], ['UZ', 'Uzbek'],
  ['KH', 'Cambodian'], ['LA', 'Lao'], ['MM', 'Burmese'], ['BD', 'Bangladeshi'], ['PK', 'Pakistani'], ['LK', 'Sri Lankan'], ['NP', 'Nepali'], ['QA', 'Qatari'],
  ['KW', 'Kuwaiti'], ['OM', 'Omani'], ['BH', 'Bahraini'], ['JO', 'Jordanian'], ['LB', 'Lebanese'], ['CL', 'Chilean'], ['CO', 'Colombian'], ['PE', 'Peruvian'],
  ['OTHER', 'Other'],
];
export const builtinNationalities = (): StoredNationality[] =>
  BUILTIN_NATIONALITIES.map(([code, name], i) => ({ code, name, builtin: true, sort: i + 1, created_at: '2026-01-01T00:00:00.000Z', created_by: null }));

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Legacy `bkV2AllNats`: the built-ins but `OTHER`, then the custom ones as they were added, `OTHER` last. */
export function nationalityList(all: readonly StoredNationality[]): Nationality[] {
  const rank = (n: StoredNationality) => (n.code === 'OTHER' ? 2 : n.builtin ? 0 : 1);
  return [...all]
    .sort((a, b) => rank(a) - rank(b) || (a.sort ?? 0) - (b.sort ?? 0) || cmp(a.created_at, b.created_at) || cmp(a.code, b.code))
    .map((n) => ({ code: n.code, name: n.name, custom: !n.builtin }));
}

const LETTERS = /[^A-Za-z฀-๿]/g;
/** Legacy `_bkNatClean`: drop a ` · CODE` label suffix, stray brackets and punctuation at the ends, double spaces. */
export const cleanNationalityName = (name: string): string => name.trim()
  .replace(/\s*·\s*[A-Za-z0-9]{2,4}\s*$/, '').trim()
  .replace(/^[\s)(\][·.,;:_-]+/, '').replace(/[\s)(\][·.,;:_-]+$/, '').replace(/\s{2,}/g, ' ').trim();
/** Legacy `_bkNatNorm`: lowercase letters (Latin and Thai) only. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z฀-๿]/g, '');

/**
 * `POST /v1/nationalities` (legacy `bkV2AddCustomNat`): the existing one whose name matches once
 * normalised, or whose code is the text typed; else a new custom one coded with the name's first three
 * letters (`CUS` when it has none), numbered on a clash. Fewer than two letters is refused.
 */
export function planNationality(body: Record<string, unknown>, all: readonly StoredNationality[], ctx: { now: string; by: string | null }):
  { existing: StoredNationality } | { created: StoredNationality } {
  assertKnownKeys(body, ['name'], 'A nationality');
  if (typeof body.name !== 'string') refuse('name is required', 400);
  const name = cleanNationalityName(body.name as string);
  if (name.replace(LETTERS, '').length < 2) refuse('A nationality needs at least 2 letters', 400);
  const key = norm(name);
  const existing = all.find((n) => norm(n.name) === key || n.code.toLowerCase() === name.toLowerCase());
  if (existing) return { existing };
  const base = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'CUS';
  const used = new Set(all.map((n) => n.code));
  let code = base;
  for (let i = 2; used.has(code); i++) code = `${base}${i}`;
  return { created: { code, name, builtin: false, sort: null, created_at: ctx.now, created_by: ctx.by } };
}
