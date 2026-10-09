/**
 * The add-on service catalogue (todo/sales-editing-model.md, decision 10; migration 091): the extra
 * services sales offers (a longtail at Pileh, a private van, a guide), each with variants and their
 * selling and net prices. Legacy's "Add-on Services" screen (`SB_ADDON_SVCS`, `aos*`) showed three
 * hard-coded services and never saved an edit, so there is nothing to copy: this is the minimal shape
 * that screen shows, and what it lists must come from sales. Booking add-ons are priced from rate types
 * (README, "Add-ons"), not from here.
 */
import { refuse } from './booking-actions.js';
import { assertKnownKeys } from './server-owned.js';

const bad = (message: string): never => refuse(message, 400);
const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(`${name} must be text`);
  return (value as string).trim() || null;
};

/** Legacy's icons (`AOS_ICONS`). */
export const ADDON_SERVICE_TYPES = ['boat', 'van', 'guide', 'other'] as const;
export type AddonServiceType = typeof ADDON_SERVICE_TYPES[number];
export type AddonVariant = { id: string; name: string; unit: string | null; selling: number | null; net: number | null };
export type AddonService = {
  id: string; name: string; type: AddonServiceType; description: string | null; active: boolean; sort: number | null;
  variants: AddonVariant[]; created_at: string; updated_at: string;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** By `sort` (unsorted last), then name, then id. */
export const sortAddonServices = (all: readonly AddonService[]): AddonService[] =>
  [...all].sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || cmp(a.id, b.id));
export const addonServiceView = (s: AddonService): AddonService => ({ ...s, variants: s.variants.map((v) => ({ ...v })) });

const price = (value: unknown, name: string): number | null => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : bad(`${name} must be a number ≥ 0`);
};

function parseVariants(value: unknown, newId: () => string): AddonVariant[] {
  if (!Array.isArray(value)) bad('variants must be a list');
  const ids = new Set<string>();
  return (value as unknown[]).map((raw, i) => {
    const at = `variants[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad(`${at} must be an object`);
    const row = raw as Record<string, unknown>;
    assertKnownKeys(row, ['id', 'name', 'unit', 'selling', 'net'], at);
    let id = text(row.id, `${at}.id`) ?? newId();
    while (row.id === undefined && ids.has(id)) id = newId();
    if (ids.has(id)) bad(`${at}.id ${id} is used twice`);
    ids.add(id);
    return { id, name: text(row.name, `${at}.name`) ?? bad(`${at}.name is required`), unit: text(row.unit, `${at}.unit`),
      selling: price(row.selling, `${at}.selling`), net: price(row.net, `${at}.net`) };
  });
}

const FIELDS = ['name', 'type', 'description', 'active', 'sort', 'variants'] as const;
function parseFields(body: Record<string, unknown>, newVariantId: () => string): Partial<AddonService> {
  assertKnownKeys(body, FIELDS, 'An add-on service');
  const out: Partial<AddonService> = {};
  if (body.name !== undefined) out.name = text(body.name, 'name') ?? bad('name is required');
  if (body.type !== undefined) {
    if (!(ADDON_SERVICE_TYPES as readonly unknown[]).includes(body.type)) bad(`type must be one of ${ADDON_SERVICE_TYPES.join(', ')}`);
    out.type = body.type as AddonServiceType;
  }
  if (body.description !== undefined) out.description = text(body.description, 'description');
  if (body.active !== undefined) out.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  if (body.sort !== undefined) out.sort = body.sort === null ? null : typeof body.sort === 'number' && Number.isInteger(body.sort) ? body.sort : bad('sort must be a whole number');
  if (body.variants !== undefined) out.variants = parseVariants(body.variants, newVariantId);
  return out;
}

export const ADDON_SERVER_OWNED = ['id', 'created_at', 'updated_at'];

export function planAddonServiceCreate(body: Record<string, unknown>, ctx: { id: string; now: string; newVariantId: () => string }): AddonService {
  for (const key of ADDON_SERVER_OWNED) if (body[key] !== undefined) bad(`${key} cannot be sent: the server sets it`);
  const f = parseFields(body, ctx.newVariantId);
  if (!f.name) bad('name is required');
  if (!f.type) bad(`type is required: ${ADDON_SERVICE_TYPES.join(', ')}`);
  return { id: ctx.id, name: f.name!, type: f.type!, description: f.description ?? null, active: f.active ?? true, sort: f.sort ?? null,
    variants: f.variants ?? [], created_at: ctx.now, updated_at: ctx.now };
}

/** `PATCH`: the fields it names; `variants` replaces the whole list, as a list is one fact. */
export function planAddonServicePatch(stored: AddonService, body: Record<string, unknown>, ctx: { now: string; newVariantId: () => string }): AddonService {
  for (const key of ADDON_SERVER_OWNED) {
    if (body[key] !== undefined && body[key] !== stored[key as keyof AddonService]) bad(`${key} cannot be changed: the server sets it`);
  }
  const { id: _i, created_at: _c, updated_at: _u, ...rest } = body;
  return { ...stored, ...parseFields(rest, ctx.newVariantId), updated_at: ctx.now };
}

export const parseActiveFilter = (value: unknown): boolean | undefined => {
  if (value === undefined || value === '' || value === 'true') return value === 'true' ? true : undefined;
  if (value === 'false') return false;
  if (value === 'all') return undefined;
  return bad('active must be true, false or all');
};
