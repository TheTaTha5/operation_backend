/**
 * Shared pieces of fleet maintenance, part B (todo/fleet-maintenance-model.md, "Design — part B"):
 * the three warehouses, input helpers and rounding. Pure, so both stores and the routes agree.
 */
import { randomBytes } from 'node:crypto';
import { refuse } from './booking-actions.js';
import { isIsoDate } from './calendar.js';
import { PIERS } from './catalogue.js';

export const bad = (message: string): never => refuse(message, 400);
/** `409` with a code; `extra` fields are sent beside the message (the app's error handler). */
export const conflict = (message: string, code: string, extra?: object): never => {
  throw Object.assign(new Error(message), { statusCode: 409, code, ...(extra ? { extra } : {}) });
};
export const notFound = (message: string): never => refuse(message, 404);

/** The three stock warehouses, legacy's `WAREHOUSE_LOCATIONS`, keyed by the pier they sit at. */
export const WAREHOUSES = [
  { id: 'tublamu', name: 'คลัง Tub Lamu', pier: 'tublamu' },
  { id: 'panwa', name: 'คลัง Visit Panwa', pier: 'panwa' },
  { id: 'ranong', name: 'คลัง Ranong', pier: 'ranong' },
] as const;
export type WarehouseId = typeof WAREHOUSES[number]['id'];
export const warehouseName = (id: string | null): string | null => (id === null ? null : WAREHOUSES.find((w) => w.id === id)?.name ?? id);
/** A warehouse named by its key or by legacy's label (what legacy's screens send). */
export function parseWarehouse(value: unknown, name = 'warehouse'): WarehouseId {
  const hit = typeof value === 'string' ? WAREHOUSES.find((w) => w.id === value || w.name === value.trim()) : undefined;
  return hit ? hit.id : bad(`${name} must be one of ${WAREHOUSES.map((w) => w.id).join(', ')}`);
}

export const PIER_IDS: readonly string[] = PIERS;
export function parsePier(value: unknown, name = 'pier'): string {
  return typeof value === 'string' && PIER_IDS.includes(value) ? value : bad(`${name} must be one of ${PIER_IDS.join(', ')}`);
}

export const record = (value: unknown, name = 'Request body'): Record<string, unknown> =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad(`${name} must be an object`));
/** Trimmed text; `''` and null are null. */
export const text = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return bad(`${name} must be a string`);
  return value.trim() || null;
};
export const required = (value: unknown, name: string, message = `${name} is required`): string => text(value, name) ?? bad(message);
/** A finite number, or null for absent/null/''. Numeric strings are accepted, as legacy's inputs send them. */
export const number = (value: unknown, name: string): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : bad(`${name} must be a number`);
};
export const nonNegative = (value: unknown, name: string): number | null => {
  const n = number(value, name);
  return n === null || n >= 0 ? n : bad(`${name} must be 0 or more`);
};
export const positive = (value: unknown, name: string): number => {
  const n = number(value, name);
  return n !== null && n > 0 ? n : bad(`${name} must be more than 0`);
};
export const bool = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'boolean' ? value : bad(`${name} must be true or false`);
};
export const isoDate = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && isIsoDate(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : bad(`${name} must be YYYY-MM-DD`);
};

/** Money and quantities are kept to 2 decimals, as the columns are. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** `<prefix>_<base36 time>_<hex>`: unique without a counter, in the shape legacy's ids have. */
export const newFleetId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

/** Days between two ISO dates (b − a). */
export const dayGap = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** Refuses a key `allowed` does not name: `400`, naming it. */
export function assertKnown(body: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) bad(`${what} has no field ${unknown.join(', ')}`);
}
