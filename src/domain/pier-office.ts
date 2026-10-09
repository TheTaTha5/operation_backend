/**
 * The Pier Office lists (todo/pier-office-model.md; migration 171): legacy's pier_kinds (§poKinds),
 * pier_items (§pierOffice), pier_codes (§pierAtt), pier_sect (§paSect), pier_lic_types and
 * pier_lic_classes (§pierLic), pier_staff. Pure, so both stores decide identically: what a create or
 * a change makes of a row, what a delete takes with it, the order a list is shown in.
 *
 * Legacy's rules kept here, which it checked only in the browser: a kind used by items is not deleted
 * (`poKindDel`); an item needs a label and a kind (`poItemAdd`); a person needs a nick or a name, the
 * missing one copying the other (`poStaffAdd`); a group with people is deleted only when told to
 * unassign them (`paSectDel`'s confirm); moving into a group puts a person last in it
 * (`paStaffSect`); a code's tint follows its colour (`paCodeColor`, `paTint`).
 */
import { refuse } from './booking-actions.js';
import { PIERS } from './catalogue.js';
import { assertKnownKeys, withoutServerOwned } from './server-owned.js';

const bad = (message: string): never => refuse(message, 400);

export type ItemKind = { id: string; name: string; name_en: string | null; unit: string; color: string; sort: number; active: boolean };
export type Item = { id: string; pier: string; kind_id: string; label: string; total: number; active: boolean; note: string | null };
export type AttendanceCode = { id: string; code: string; label: string | null; color: string; bg: string; kind: CodeKind; sort: number; active: boolean };
export type Section = { id: string; pier: string; name: string; sort: number };
export type Staff = {
  id: string; pier: string; nick: string; name: string; role: string | null; phone: string | null; active: boolean; default_code: string | null;
  section_id: string | null; note: string | null; sort: number;
};
export type LicenseType = { id: string; side: 'deck' | 'eng'; short: string; formal: string | null; per_boat: number; active: boolean };
export type LicenseClass = { id: string; type_id: string; name: string; max_gt: number | null; max_bhp: number | null; sort: number };

export const CODE_KINDS = ['work', 'off', 'leave', 'none', 'night'] as const;
export type CodeKind = typeof CODE_KINDS[number];

export type PierLists = {
  'item-kinds': ItemKind; items: Item; 'attendance-codes': AttendanceCode; sections: Section; staff: Staff;
  'license-types': LicenseType; 'license-classes': LicenseClass;
};
export type PierList = keyof PierLists;
export const PIER_LISTS: readonly PierList[] = ['item-kinds', 'items', 'attendance-codes', 'sections', 'staff', 'license-types', 'license-classes'];
export type AllLists = { [K in PierList]: PierLists[K][] };
/** The JSON keys `GET /v1/pier-office` answers with. */
export const LIST_KEYS: Record<PierList, string> = {
  'item-kinds': 'item_kinds', items: 'items', 'attendance-codes': 'attendance_codes', sections: 'sections', staff: 'staff',
  'license-types': 'license_types', 'license-classes': 'license_classes',
};
const ID_PREFIX: Record<PierList, string> = {
  'item-kinds': 'pk_', items: 'pi_', 'attendance-codes': 'pc_', sections: 'sc_', staff: 'ps_', 'license-types': 'plt_', 'license-classes': 'plc_',
};
export const newListId = (list: PierList, random: string): string => `${ID_PREFIX[list]}${random}`;

/** Legacy's browser seeds, which migration 171 also inserts: a fresh system starts as legacy does. */
export const PIER_OFFICE_SEEDS: Pick<AllLists, 'item-kinds' | 'attendance-codes' | 'license-types' | 'license-classes'> = {
  'item-kinds': [
    { id: 'fin', name: 'ตีนกบ', name_en: 'FINS', unit: 'คู่', color: '#0F6E56', sort: 1, active: true },
    { id: 'mask', name: 'หน้ากาก', name_en: 'MASK', unit: 'ชิ้น', color: '#185FA5', sort: 2, active: true },
    { id: 'towel', name: 'ผ้าเช็ดตัว', name_en: 'TOWEL', unit: 'ผืน', color: '#BA7517', sort: 3, active: true },
  ],
  'attendance-codes': ([
    ['c_pp', 'PP', 'ทำงาน (ลงเรือ)', '#20477E', '#E9EFF7', 'work'], ['c_se', 'SE', 'เข้าเวร', '#20477E', '#E9EFF7', 'work'],
    ['c_off', 'OFF', 'หยุดประจำสัปดาห์', '#B8BFC9', '#FCFCFD', 'off'], ['c_ph', 'PH', 'วันหยุดนักขัตฤกษ์', '#9AA3B0', '#FBFBFD', 'off'],
    ['c_lwop', 'LWOP', 'ลาไม่รับค่าจ้าง', '#A3251A', '#FDECEA', 'leave'], ['c_lwp', 'LWP', null, '#9B4A3A', '#FBEDE9', 'leave'],
    ['c_sc', 'SC', null, '#185FA5', '#E7F0FA', 'work'], ['c_sr', 'SR', null, '#0E6E86', '#E3F2F7', 'work'], ['c_5', '5', null, '#4A5568', '#EDEFF3', 'work'],
    ['c_abs', 'ABS', 'ขาดงาน', '#A3251A', '#FDECEA', 'none'], ['c_mt', 'MT', 'งานซ่อม / ขึ้นคาน', '#5B3B96', '#F2EBFA', 'work'],
  ] as const).map(([id, code, label, color, bg, kind], i) => ({ id, code, label, color, bg, kind, sort: i + 1, active: true })),
  'license-types': [
    { id: 'deck', side: 'deck', short: 'ใบกัปตัน', formal: 'ประกาศนียบัตรนายท้ายเรือกลเดินทะเล', per_boat: 1, active: true },
    { id: 'eng', side: 'eng', short: 'ใบช่างเครื่อง', formal: 'ประกาศนียบัตรช่างเครื่องเรือกลเดินทะเล', per_boat: 1, active: true },
  ],
  'license-classes': [
    { id: 'deck1', type_id: 'deck', name: 'ชั้นหนึ่ง', max_gt: 500, max_bhp: null, sort: 1 },
    { id: 'deck2', type_id: 'deck', name: 'ชั้นสอง', max_gt: 60, max_bhp: null, sort: 2 },
    { id: 'eng1', type_id: 'eng', name: 'ชั้นหนึ่ง', max_gt: null, max_bhp: 3000, sort: 1 },
    { id: 'eng2', type_id: 'eng', name: 'ชั้นสอง', max_gt: null, max_bhp: 1000, sort: 2 },
  ],
};

// ── Fields ──

const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return bad(`${name} must be text`);
  return value.trim() || null;
};
const short = (value: unknown, name: string): string | null => {
  const t = text(value, name);
  return t !== null && t.length > 40 ? bad(`${name} may be at most 40 characters`) : t;
};
const flag = (value: unknown, name: string): boolean => (typeof value === 'boolean' ? value : bad(`${name} must be true or false`));
const whole = (value: unknown, name: string): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : bad(`${name} must be a whole number, 0 or more`);
};
const limit = (value: unknown, name: string): number | null => {
  if (value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : bad(`${name} must be a number, 0 or more, or null for no limit`);
};
export const parsePier = (value: unknown, name = 'pier'): string =>
  typeof value === 'string' && (PIERS as readonly string[]).includes(value) ? value : bad(`${name} must be one of ${PIERS.join(', ')}`);
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const colorOf = (value: unknown, name = 'color'): string => (typeof value === 'string' && HEX.test(value) ? value : bad(`${name} must be a #RRGGBB colour`));

/** Legacy `paTint`: the colour mixed 90% with white, the code's background. */
export function tint(hex: string): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) return '#EEF2F7';
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    out += Math.round(v + (255 - v) * 0.9).toString(16).padStart(2, '0');
  }
  return out;
}

const nextSort = (rows: readonly { sort: number }[]): number => rows.reduce((m, r) => Math.max(m, r.sort), 0) + 1;
const assertUniqueCode = (codes: readonly AttendanceCode[], code: string, self?: string): void => {
  const twin = codes.find((c) => c.id !== self && c.code.toUpperCase() === code.toUpperCase());
  if (twin) refuse(`Code ${code} is already ${twin.id}'s`, 409, 'code_taken');
};

// ── Creates ──

/** `POST /v1/pier-office/{list}`: the new row, `id` and `sort` the server's. */
export function planCreate(list: PierList, body: Record<string, unknown>, lists: AllLists, id: string): PierLists[PierList] {
  if (body.id !== undefined) bad('id is assigned by the server');
  if (body.sort !== undefined) bad(`sort is set with POST /v1/pier-office/${list}/order`);
  switch (list) {
    case 'item-kinds': {
      assertKnownKeys(body, ['name', 'name_en', 'unit', 'color', 'active'], 'An item kind');
      return { id, name: short(body.name, 'name') ?? '', name_en: short(body.name_en, 'name_en'), unit: short(body.unit, 'unit') ?? 'ชิ้น',
        color: body.color === undefined ? '#5F6C7B' : colorOf(body.color), sort: nextSort(lists['item-kinds']), active: body.active === undefined ? true : flag(body.active, 'active') };
    }
    case 'items': {
      assertKnownKeys(body, ['pier', 'kind_id', 'label', 'total', 'active', 'note'], 'An item');
      if (!lists['item-kinds'].length) refuse('There are no item kinds yet: add one first (POST /v1/pier-office/item-kinds)', 409, 'no_kinds');
      const label = text(body.label, 'label') ?? bad('label is required');
      return { id, pier: parsePier(body.pier), kind_id: kindOf(body.kind_id, lists), label: label!, total: body.total === undefined || body.total === null ? 0 : whole(body.total, 'total'),
        active: body.active === undefined ? true : flag(body.active, 'active'), note: text(body.note, 'note') };
    }
    case 'attendance-codes': {
      assertKnownKeys(body, ['code', 'label', 'color', 'kind', 'active', 'bg'], 'A roster code');
      if (body.bg !== undefined) bad('bg follows color (legacy paTint): send color');
      const code = text(body.code, 'code') ?? 'NEW';
      assertUniqueCode(lists['attendance-codes'], code);
      const color = body.color === undefined ? '#5A6270' : colorOf(body.color);
      return { id, code, label: text(body.label, 'label'), color, bg: body.color === undefined ? '#F1F2F5' : tint(color), kind: codeKind(body.kind ?? 'none'),
        sort: nextSort(lists['attendance-codes']), active: body.active === undefined ? true : flag(body.active, 'active') };
    }
    case 'sections': {
      assertKnownKeys(body, ['pier', 'name'], 'A group');
      const pier = parsePier(body.pier);
      return { id, pier, name: text(body.name, 'name') ?? '', sort: nextSort(lists.sections.filter((s) => s.pier === pier)) };
    }
    case 'staff': {
      assertKnownKeys(body, ['pier', 'nick', 'name', 'role', 'phone', 'active', 'default_code', 'section_id', 'note'], 'A staff member');
      const pier = parsePier(body.pier);
      const nick = text(body.nick, 'nick'), name = text(body.name, 'name');
      if (!nick && !name) bad('nick or name is required');
      const section = body.section_id === undefined ? null : sectionOf(body.section_id, pier, lists);
      return { id, pier, nick: nick ?? name!, name: name ?? nick!, role: text(body.role, 'role'), phone: text(body.phone, 'phone'),
        active: body.active === undefined ? true : flag(body.active, 'active'), default_code: codeText(body.default_code), section_id: section,
        note: text(body.note, 'note'), sort: nextSort(lists.staff.filter((s) => s.pier === pier)) };
    }
    case 'license-classes': {
      assertKnownKeys(body, ['type_id', 'name', 'max_gt', 'max_bhp'], 'A licence class');
      const type = typeof body.type_id === 'string' && lists['license-types'].find((t) => t.id === body.type_id);
      if (!type) bad(`type_id must be a licence type: ${lists['license-types'].map((t) => t.id).join(', ')}`);
      const typeId = (type as LicenseType).id;
      return { id, type_id: typeId, name: text(body.name, 'name') ?? 'ชั้นใหม่', max_gt: body.max_gt === undefined ? null : limit(body.max_gt, 'max_gt'),
        max_bhp: body.max_bhp === undefined ? null : limit(body.max_bhp, 'max_bhp'), sort: nextSort(lists['license-classes'].filter((c) => c.type_id === typeId)) };
    }
    case 'license-types':
      return refuse('Licence types are not added: legacy has deck and eng only (PATCH /v1/pier-office/license-types/{id})', 405, 'not_allowed');
  }
}
const kindOf = (value: unknown, lists: AllLists): string =>
  typeof value === 'string' && lists['item-kinds'].some((k) => k.id === value) ? value : bad(`kind_id must be an item kind: ${lists['item-kinds'].map((k) => k.id).join(', ')}`);
const codeKind = (value: unknown): CodeKind => ((CODE_KINDS as readonly unknown[]).includes(value) ? value as CodeKind : bad(`kind must be one of ${CODE_KINDS.join(', ')}`));
/** Legacy `poStaffDef` upper-cases the code typed. */
const codeText = (value: unknown): string | null => text(value, 'default_code')?.toUpperCase() ?? null;
function sectionOf(value: unknown, pier: string, lists: AllLists): string | null {
  if (value === null || value === '') return null;
  const s = typeof value === 'string' ? lists.sections.find((x) => x.id === value) : undefined;
  if (!s) return bad(`section_id ${String(value)} is not a group (GET /v1/pier-office)`);
  if (s.pier !== pier) bad(`Group ${s.id} is ${s.pier}'s, not ${pier}'s`);
  return s.id;
}

// ── Changes ──

const OWNED: Record<string, string> = { id: 'nothing' };
/**
 * `PATCH /v1/pier-office/{list}/{id}`: client facts only. `sort` is the order command's; a code's
 * `bg` follows its `color`; a licence type's `side` and a class's `type_id` are fixed.
 * Answers every row the change touches (a person moved into a group goes last in it).
 */
export function planPatch(list: PierList, current: PierLists[PierList], body: Record<string, unknown>, lists: AllLists): PierLists[PierList] {
  const owned: Record<string, string> = { ...OWNED, sort: `POST /v1/pier-office/${list}/order` };
  if (list === 'attendance-codes') owned.bg = 'it follows color (legacy paTint): send color';
  if (list === 'license-types') owned.side = 'nothing: deck or eng is fixed';
  if (list === 'license-classes') owned.type_id = 'nothing: delete the class and add one to the other type';
  const rest = withoutServerOwned(body, current as unknown as Record<string, unknown>, owned);
  const has = (k: string) => rest[k] !== undefined;
  switch (list) {
    case 'item-kinds': {
      assertKnownKeys(rest, ['name', 'name_en', 'unit', 'color', 'active'], 'An item kind');
      const k = { ...(current as ItemKind) };
      if (has('name')) k.name = short(rest.name, 'name') ?? '';
      if (has('name_en')) k.name_en = short(rest.name_en, 'name_en');
      if (has('unit')) k.unit = short(rest.unit, 'unit') ?? bad('unit is required');
      if (has('color')) k.color = colorOf(rest.color);
      if (has('active')) k.active = flag(rest.active, 'active');
      return k;
    }
    case 'items': {
      assertKnownKeys(rest, ['pier', 'kind_id', 'label', 'total', 'active', 'note'], 'An item');
      const i = { ...(current as Item) };
      if (has('pier')) i.pier = parsePier(rest.pier);
      if (has('kind_id')) i.kind_id = kindOf(rest.kind_id, lists);
      if (has('label')) i.label = text(rest.label, 'label') ?? bad('label cannot be blank');
      if (has('total')) i.total = whole(rest.total, 'total');
      if (has('active')) i.active = flag(rest.active, 'active');
      if (has('note')) i.note = text(rest.note, 'note');
      return i;
    }
    case 'attendance-codes': {
      assertKnownKeys(rest, ['code', 'label', 'color', 'kind', 'active'], 'A roster code');
      const c = { ...(current as AttendanceCode) };
      if (has('code')) { c.code = text(rest.code, 'code') ?? bad('code cannot be blank'); assertUniqueCode(lists['attendance-codes'], c.code, c.id); }
      if (has('label')) c.label = text(rest.label, 'label');
      if (has('color')) { c.color = colorOf(rest.color); c.bg = tint(c.color); }
      if (has('kind')) c.kind = codeKind(rest.kind);
      if (has('active')) c.active = flag(rest.active, 'active');
      return c;
    }
    case 'sections': {
      assertKnownKeys(rest, ['name'], 'A group');
      const s = { ...(current as Section) };
      if (has('name')) s.name = text(rest.name, 'name') ?? '';
      return s;
    }
    case 'staff': {
      assertKnownKeys(rest, ['pier', 'nick', 'name', 'role', 'phone', 'active', 'default_code', 'section_id', 'note'], 'A staff member');
      const s = { ...(current as Staff) };
      if (has('pier')) s.pier = parsePier(rest.pier);
      if (has('nick')) s.nick = text(rest.nick, 'nick') ?? '';
      if (has('name')) s.name = text(rest.name, 'name') ?? '';
      if (!s.nick && !s.name) bad('nick or name is required');
      if (has('role')) s.role = text(rest.role, 'role');
      if (has('phone')) s.phone = text(rest.phone, 'phone');
      if (has('active')) s.active = flag(rest.active, 'active');
      if (has('default_code')) s.default_code = codeText(rest.default_code);
      if (has('note')) s.note = text(rest.note, 'note');
      if (has('section_id')) s.section_id = sectionOf(rest.section_id, s.pier, lists);
      else if (s.pier !== (current as Staff).pier && s.section_id) s.section_id = null;   // a group is one pier's
      // Into another group: last in it (legacy `paStaffSect`: ord 1e9, then renumbered).
      if (s.section_id !== (current as Staff).section_id || s.pier !== (current as Staff).pier) {
        s.sort = nextSort(lists.staff.filter((x) => x.pier === s.pier && x.id !== s.id));
      }
      return s;
    }
    case 'license-types': {
      assertKnownKeys(rest, ['short', 'formal', 'per_boat', 'active'], 'A licence type');
      const t = { ...(current as LicenseType) };
      if (has('short')) t.short = text(rest.short, 'short') ?? bad('short cannot be blank');
      if (has('formal')) t.formal = text(rest.formal, 'formal');
      if (has('per_boat')) t.per_boat = whole(rest.per_boat, 'per_boat');
      if (has('active')) t.active = flag(rest.active, 'active');
      return t;
    }
    case 'license-classes': {
      assertKnownKeys(rest, ['name', 'max_gt', 'max_bhp'], 'A licence class');
      const c = { ...(current as LicenseClass) };
      if (has('name')) c.name = text(rest.name, 'name') ?? bad('name cannot be blank');
      if (has('max_gt')) c.max_gt = limit(rest.max_gt, 'max_gt');
      if (has('max_bhp')) c.max_bhp = limit(rest.max_bhp, 'max_bhp');
      return c;
    }
  }
}

// ── Deletes ──

/**
 * `DELETE /v1/pier-office/{list}/{id}`: what goes, and the rows it changes. Items, staff and licence
 * types are never deleted (legacy switches them off).
 */
export function planDelete(list: PierList, id: string, lists: AllLists, opts: { unassignAnyway: boolean }): { updates: Staff[] } {
  switch (list) {
    case 'item-kinds': {
      const n = lists.items.filter((i) => i.kind_id === id).length;
      if (n) refuse(`Kind ${id} still has ${n} item${n === 1 ? '' : 's'}: move them to another kind first`, 409, 'kind_in_use');
      return { updates: [] };
    }
    case 'sections': {
      const people = lists.staff.filter((s) => s.section_id === id);
      if (people.length && !opts.unassignAnyway) {
        refuse(`Group ${id} has ${people.length} ${people.length === 1 ? 'person' : 'people'}: send unassign_anyway=true to delete it and leave them unassigned`, 409, 'section_in_use');
      }
      return { updates: people.map((s) => ({ ...s, section_id: null })) };
    }
    case 'attendance-codes': case 'license-classes':
      return { updates: [] };
    default:
      return refuse(`${list} are not deleted: switch one off with PATCH {"active": false}`, 405, 'not_allowed');
  }
}

// ── Order ──

/**
 * `POST /v1/pier-office/{list}/order`: `ids` lists every row of the list (of `pier`'s, for groups
 * and staff) once, in the order to show them (legacy's ▲▼ and drag).
 */
export function planOrder(list: PierList, body: Record<string, unknown>, lists: AllLists): Map<string, number> {
  if (!['item-kinds', 'attendance-codes', 'sections', 'staff'].includes(list)) refuse(`${list} have no order to set`, 405, 'not_allowed');
  assertKnownKeys(body, ['ids', 'pier'], 'An order');
  const perPier = list === 'sections' || list === 'staff';
  const pier = perPier ? parsePier(body.pier) : undefined;
  const ids = Array.isArray(body.ids) && body.ids.every((x) => typeof x === 'string') ? body.ids as string[] : bad('ids must be a list of ids');
  const rows = (lists[list] as { id: string; pier?: string }[]).filter((r) => !perPier || r.pier === pier);
  const want = new Set(rows.map((r) => r.id));
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !want.has(id))) {
    bad(`ids must list every one of ${perPier ? `${pier}'s ` : ''}${list} once: ${rows.map((r) => r.id).join(', ') || 'there are none'}`);
  }
  return new Map(ids.map((id, i) => [id, i + 1]));
}

// ── Reads ──

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The order each list is shown in. Items: by their kind's order, then label (legacy `poItems`). */
export function sortLists(lists: AllLists): AllLists {
  const kindSort = new Map(lists['item-kinds'].map((k) => [k.id, k.sort]));
  const pierSort = (p: string) => (PIERS as readonly string[]).indexOf(p);
  return {
    'item-kinds': [...lists['item-kinds']].sort((a, b) => a.sort - b.sort || byText(a.id, b.id)),
    items: [...lists.items].sort((a, b) => pierSort(a.pier) - pierSort(b.pier) || (kindSort.get(a.kind_id) ?? 1e9) - (kindSort.get(b.kind_id) ?? 1e9)
      || a.label.localeCompare(b.label) || byText(a.id, b.id)),
    'attendance-codes': [...lists['attendance-codes']].sort((a, b) => a.sort - b.sort || byText(a.id, b.id)),
    sections: [...lists.sections].sort((a, b) => pierSort(a.pier) - pierSort(b.pier) || a.sort - b.sort || byText(a.id, b.id)),
    staff: [...lists.staff].sort((a, b) => pierSort(a.pier) - pierSort(b.pier) || a.sort - b.sort || byText(a.id, b.id)),
    'license-types': [...lists['license-types']].sort((a, b) => byText(a.side, b.side) || byText(a.id, b.id)),
    'license-classes': [...lists['license-classes']].sort((a, b) => byText(a.type_id, b.type_id) || a.sort - b.sort || byText(a.id, b.id)),
  };
}
/** `GET /v1/pier-office`: every list, the per-pier ones narrowed to `pier`. */
export function listsView(lists: AllLists, pier?: string): Record<string, unknown[]> {
  const sorted = sortLists(lists);
  const narrow = <T extends { pier: string }>(rows: T[]) => (pier ? rows.filter((r) => r.pier === pier) : rows);
  return {
    item_kinds: sorted['item-kinds'], items: narrow(sorted.items), attendance_codes: sorted['attendance-codes'], sections: narrow(sorted.sections),
    staff: narrow(sorted.staff), license_types: sorted['license-types'], license_classes: sorted['license-classes'],
  };
}
export function parseList(value: unknown): PierList {
  return typeof value === 'string' && (PIER_LISTS as readonly string[]).includes(value) ? value as PierList : refuse(`No such list: ${String(value)} (${PIER_LISTS.join(', ')})`, 404);
}
