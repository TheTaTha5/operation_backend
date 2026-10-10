/**
 * A boat's day as it actually went (legacy `trip_actuals`, key `date::boat`; migration 160): the meal
 * order the pier sent, its note and overnight choices, the day's restaurant, "ran empty" and the
 * frozen P&L. The shape only; the rules are `trip-pl.ts`'s. Kept apart so the stores import no rules.
 */
export type MealOrder = { venue_id: string; venue_name: string; adults: number; children: number; price_adult: number; price_child: number; amount: number; at: string; by: string | null };
export type ClosedRow = { id: string; label: string; amount: number; actual: boolean };
export type Closed = { at: string; by: string | null; revenue: number; cost: number; profit: number; pax: number; rows: ClosedRow[] };
export type TripActual = {
  service_date: string; boat_id: string;
  /** This day's restaurant (legacy `pier_job.mv`): null = the route's; `no_meal` = none this day (legacy `-`). */
  venue_id: string | null; no_meal: boolean;
  meal: MealOrder | null;
  meal_note: { text: string; at: string | null; by: string | null } | null;
  /** Overnight return bookings: does their meal count this day (legacy `mealOvn`)? */
  meal_overnight: Record<string, 'in' | 'out'>;
  ran: boolean; ran_at: string | null; ran_by: string | null;
  closed: Closed | null;
};
export const blankActual = (date: string, boatId: string): TripActual => ({
  service_date: date, boat_id: boatId, venue_id: null, no_meal: false, meal: null, meal_note: null, meal_overnight: {}, ran: false, ran_at: null, ran_by: null, closed: null,
});
export const copyActual = (a: TripActual): TripActual => ({
  ...a, meal: a.meal && { ...a.meal }, meal_note: a.meal_note && { ...a.meal_note }, meal_overnight: { ...a.meal_overnight },
  closed: a.closed && { ...a.closed, rows: a.closed.rows.map((r) => ({ ...r })) },
});
