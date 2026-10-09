/**
 * The allergy list (todo/booking-extras-model.md §2, approved 2026-10-09; migration 041): who in the
 * booking can't eat what, and how many people, for the kitchen. Legacy `specialMeals.allergyList`,
 * `bkV2AllergyAdd`, `bkV2AllergyCount`. Pure, so both stores decide identically.
 */
import { refuse } from './booking-actions.js';

export type Allergy = { name: string; qty: number };

const bad = (message: string): never => refuse(message, 400);

/**
 * `allergy_list`, as the list replaces outright. A blank name or a qty below 1 is refused; two
 * entries with the same name (any case) become one, their qty added, as legacy's add button does.
 */
export function parseAllergyList(value: unknown, label = 'allergy_list'): Allergy[] {
  if (value === null) return [];
  if (!Array.isArray(value)) bad(`${label} must be a list`);
  const out: Allergy[] = [];
  (value as unknown[]).forEach((raw, i) => {
    const at = `${label}[${i}]`;
    const a = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : bad(`${at} must be an object`);
    const name = typeof a!.name === 'string' && a!.name.trim() ? a!.name.trim() : bad(`${at}.name is required`);
    const qty = a!.qty === undefined || a!.qty === null ? 1 : Number.isInteger(a!.qty) && (a!.qty as number) >= 1 ? a!.qty as number : bad(`${at}.qty must be a whole number, 1 or more`);
    const same = out.find((x) => x.name.toLowerCase() === name!.toLowerCase());
    if (same) same.qty += qty!; else out.push({ name: name!, qty: qty! });
  });
  return out;
}

/** Legacy `bkV2AllergyCount`, what the kitchen counts: the list's people, or 1 when there is only free text. */
export const allergyCount = (list: readonly Allergy[], freeText: string | null | undefined): number => {
  const sum = list.reduce((s, a) => s + a.qty, 0);
  return sum === 0 && freeText && freeText.trim() ? 1 : sum;
};

/** The body's list in any of its spellings, or undefined when it names none. */
export const allergyListOf = (body: Record<string, unknown>): unknown => {
  if (body.allergy_list !== undefined) return body.allergy_list;
  if (body.allergyList !== undefined) return body.allergyList;
  for (const key of ['specialMeals', 'special_meals']) {
    const meals = body[key];
    if (meals && typeof meals === 'object' && (meals as Record<string, unknown>).allergyList !== undefined) return (meals as Record<string, unknown>).allergyList;
  }
  return undefined;
};
