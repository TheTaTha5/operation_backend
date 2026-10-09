/**
 * The rest of Money in PostgreSQL (migrations 160–161): `MoneyRepo` over the store's own connection,
 * so every call runs in the request's transaction. Rows in, rows out; the rules are in the pure
 * modules. Dates are read as `::text` (CLAUDE.md), numerics converted with `Number`.
 */
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { MoneyRepo } from './money-store.js';
import type { BoatRent, CostLine, CostPlan, MealVenue, StoredTemplate } from './costing.js';
import type { TripActual } from './trip-actuals.js';
import type { RefundPayout, StoredDeposit } from './credit.js';

type Db = () => Pool | PoolClient;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v as Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v ? (v as Date).toISOString() : null);
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const planRow = (r: QueryResultRow): CostPlan => ({
  id: r.id, sort: num(r.sort), name: r.name, route_key: s(r.route_key), note: s(r.note), engines: r.engines, boats: num(r.boats), capacity: num(r.capacity),
  pax: num(r.pax), pax_th: num(r.pax_th), price: num(r.price), price_child: numOrNull(r.price_child), child_pct: num(r.child_pct), commission_pct: num(r.commission_pct),
  fuel_price: num(r.fuel_price), boat_id: s(r.boat_id), rent_off: r.rent_off, overrides: r.overrides, groups: r.groups, on_demand: r.on_demand,
  itinerary: r.itinerary, tiers: r.tiers, updated_at: iso(r.updated_at), updated_by: s(r.updated_by),
});
const rentRow = (r: QueryResultRow): BoatRent => ({
  boat_id: r.boat_id, rented: r.rented, mode: r.mode, amount: num(r.amount), per_seat: num(r.per_seat), days: num(r.days), days_off: num(r.days_off),
  trips_per_day: num(r.trips_per_day), vat: r.vat, note: s(r.note), from: s(r.from_date), to: s(r.to_date), fuel_pct: numOrNull(r.fuel_pct), owner_pays: r.owner_pays ?? [],
  updated_at: iso(r.updated_at), updated_by: s(r.updated_by),
});
const venueRow = (r: QueryResultRow): MealVenue => ({
  id: r.id, name: r.name, place: s(r.place), price_adult: num(r.price_adult), price_child: num(r.price_child), phone: s(r.phone), eta: s(r.eta), note: s(r.note), active: r.active,
});
const ACTUAL_SELECT = `SELECT service_date::text AS service_date, boat_id, venue_id, no_meal, meal_venue_id, meal_venue_name, meal_adults, meal_children, meal_price_adult,
  meal_price_child, meal_amount, meal_at, meal_by, meal_note, meal_note_at, meal_note_by, ran, ran_at, ran_by, closed_at, closed_by, closed_revenue, closed_cost,
  closed_profit, closed_pax, closed_rows FROM trip_actuals`;
const actualRow = (r: QueryResultRow, overnight: Record<string, 'in' | 'out'>): TripActual => ({
  service_date: r.service_date, boat_id: r.boat_id, venue_id: s(r.venue_id), no_meal: r.no_meal,
  meal: r.meal_at ? {
    venue_id: r.meal_venue_id, venue_name: r.meal_venue_name ?? '', adults: num(r.meal_adults), children: num(r.meal_children), price_adult: num(r.meal_price_adult),
    price_child: num(r.meal_price_child), amount: num(r.meal_amount), at: iso(r.meal_at), by: s(r.meal_by),
  } : null,
  meal_note: r.meal_note !== null ? { text: r.meal_note, at: isoOrNull(r.meal_note_at), by: s(r.meal_note_by) } : null,
  meal_overnight: overnight, ran: r.ran, ran_at: isoOrNull(r.ran_at), ran_by: s(r.ran_by),
  closed: r.closed_at ? {
    at: iso(r.closed_at), by: s(r.closed_by), revenue: num(r.closed_revenue), cost: num(r.closed_cost), profit: num(r.closed_profit), pax: num(r.closed_pax), rows: r.closed_rows,
  } : null,
});
const DEPOSIT_SELECT = `SELECT d.id, d.agent_id, d.amount, d.method, d.received_on::text AS received_on, d.ref, d.note, d.recorded_by, d.recorded_at, d.voided_at, d.voided_by, d.void_reason,
  COALESCE((SELECT array_agg(s.attachment_id ORDER BY s.seq) FROM deposit_slips s WHERE s.deposit_id = d.id), '{}') AS slips FROM deposits d`;
const depositRow = (r: QueryResultRow): StoredDeposit => ({
  id: r.id, agent_id: r.agent_id, amount: num(r.amount), method: r.method, received_on: r.received_on, ref: s(r.ref), note: s(r.note), recorded_by: s(r.recorded_by),
  recorded_at: iso(r.recorded_at), voided_at: isoOrNull(r.voided_at), voided_by: s(r.voided_by), void_reason: s(r.void_reason), slips: r.slips ?? [],
});
const PAYOUT_SELECT = `SELECT p.refund_id, p.paid_on::text AS paid_on, p.method, p.ref, p.paid_out_by, p.recorded_at,
  COALESCE((SELECT array_agg(s.attachment_id ORDER BY s.seq) FROM refund_payout_slips s WHERE s.refund_id = p.refund_id), '{}') AS slips FROM refund_payouts p`;
const payoutRow = (r: QueryResultRow): RefundPayout => ({
  refund_id: r.refund_id, paid_on: r.paid_on, method: r.method, ref: s(r.ref), paid_out_by: s(r.paid_out_by), recorded_at: iso(r.recorded_at), slips: r.slips ?? [],
});

export class PostgresMoneyRepo implements MoneyRepo {
  constructor(private readonly db: Db) {}
  private q(text: string, values: unknown[] = []) { return this.db().query(text, values); }

  async template(): Promise<StoredTemplate | null> {
    const { rows: [set] } = await this.q('SELECT vat_rate, updated_at, updated_by FROM cost_settings');
    if (!set) return null;
    const { rows } = await this.q('SELECT id, group_name, label, vat, parts, on_demand, on_demand_qty FROM cost_lines ORDER BY sort, id');
    const lines: CostLine[] = rows.map((r) => ({ id: r.id, group: r.group_name, label: r.label, vat: r.vat, parts: r.parts, on_demand: r.on_demand, on_demand_qty: numOrNull(r.on_demand_qty) }));
    return { vat_rate: num(set.vat_rate), lines, updated_at: iso(set.updated_at), updated_by: s(set.updated_by) };
  }
  async putTemplate(t: StoredTemplate): Promise<void> {
    await this.q(`INSERT INTO cost_settings (id, vat_rate, updated_at, updated_by) VALUES (true, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET vat_rate = EXCLUDED.vat_rate, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`, [t.vat_rate, t.updated_at, t.updated_by]);
    await this.q('DELETE FROM cost_lines');
    for (const [i, l] of t.lines.entries()) {
      await this.q('INSERT INTO cost_lines (id, sort, group_name, label, vat, parts, on_demand, on_demand_qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [l.id, i, l.group, l.label, l.vat, JSON.stringify(l.parts), l.on_demand, l.on_demand_qty]);
    }
  }
  async plans(): Promise<CostPlan[]> { return (await this.q('SELECT * FROM cost_plans ORDER BY sort, id')).rows.map(planRow); }
  async plan(id: string): Promise<CostPlan | undefined> { const { rows: [r] } = await this.q('SELECT * FROM cost_plans WHERE id = $1', [id]); return r && planRow(r); }
  async putPlan(p: CostPlan): Promise<void> {
    await this.q(`INSERT INTO cost_plans (id, sort, name, route_key, note, engines, boats, capacity, pax, pax_th, price, price_child, child_pct, commission_pct, fuel_price,
      boat_id, rent_off, overrides, groups, on_demand, itinerary, tiers, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT (id) DO UPDATE SET sort = EXCLUDED.sort, name = EXCLUDED.name, route_key = EXCLUDED.route_key, note = EXCLUDED.note, engines = EXCLUDED.engines,
      boats = EXCLUDED.boats, capacity = EXCLUDED.capacity, pax = EXCLUDED.pax, pax_th = EXCLUDED.pax_th, price = EXCLUDED.price, price_child = EXCLUDED.price_child,
      child_pct = EXCLUDED.child_pct, commission_pct = EXCLUDED.commission_pct, fuel_price = EXCLUDED.fuel_price, boat_id = EXCLUDED.boat_id, rent_off = EXCLUDED.rent_off,
      overrides = EXCLUDED.overrides, groups = EXCLUDED.groups, on_demand = EXCLUDED.on_demand, itinerary = EXCLUDED.itinerary, tiers = EXCLUDED.tiers,
      updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [p.id, p.sort, p.name, p.route_key, p.note, p.engines, p.boats, p.capacity, p.pax, p.pax_th, p.price, p.price_child, p.child_pct, p.commission_pct, p.fuel_price,
      p.boat_id, p.rent_off, JSON.stringify(p.overrides), JSON.stringify(p.groups), JSON.stringify(p.on_demand), JSON.stringify(p.itinerary), JSON.stringify(p.tiers),
      p.updated_at, p.updated_by]);
  }
  async deletePlan(id: string): Promise<boolean> { return ((await this.q('DELETE FROM cost_plans WHERE id = $1', [id])).rowCount ?? 0) > 0; }
  async replacePlans(plans: readonly CostPlan[]): Promise<void> {
    await this.q('DELETE FROM cost_plans');
    for (const p of plans) await this.putPlan(p);
  }
  async rents(): Promise<BoatRent[]> {
    return (await this.q(`SELECT boat_id, rented, mode, amount, per_seat, days, days_off, trips_per_day, vat, note, from_date::text AS from_date, to_date::text AS to_date,
      fuel_pct, owner_pays, updated_at, updated_by FROM boat_rents ORDER BY boat_id`)).rows.map(rentRow);
  }
  async putRent(r: BoatRent): Promise<void> {
    await this.q(`INSERT INTO boat_rents (boat_id, rented, mode, amount, per_seat, days, days_off, trips_per_day, vat, note, from_date, to_date, fuel_pct, owner_pays, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (boat_id) DO UPDATE SET rented = EXCLUDED.rented, mode = EXCLUDED.mode, amount = EXCLUDED.amount, per_seat = EXCLUDED.per_seat, days = EXCLUDED.days,
      days_off = EXCLUDED.days_off, trips_per_day = EXCLUDED.trips_per_day, vat = EXCLUDED.vat, note = EXCLUDED.note, from_date = EXCLUDED.from_date, to_date = EXCLUDED.to_date,
      fuel_pct = EXCLUDED.fuel_pct, owner_pays = EXCLUDED.owner_pays, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [r.boat_id, r.rented, r.mode, r.amount, r.per_seat, r.days, r.days_off, r.trips_per_day, r.vat, r.note, r.from, r.to, r.fuel_pct, r.owner_pays, r.updated_at, r.updated_by]);
  }
  async deleteRent(boatId: string): Promise<boolean> { return ((await this.q('DELETE FROM boat_rents WHERE boat_id = $1', [boatId])).rowCount ?? 0) > 0; }
  async replaceRents(rents: readonly BoatRent[]): Promise<void> {
    await this.q('DELETE FROM boat_rents');
    for (const r of rents) await this.putRent(r);
  }
  async venues(): Promise<MealVenue[]> { return (await this.q('SELECT * FROM meal_venues ORDER BY sort')).rows.map(venueRow); }
  async putVenue(v: MealVenue): Promise<void> {
    await this.q(`INSERT INTO meal_venues (id, name, place, price_adult, price_child, phone, eta, note, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, place = EXCLUDED.place, price_adult = EXCLUDED.price_adult, price_child = EXCLUDED.price_child,
      phone = EXCLUDED.phone, eta = EXCLUDED.eta, note = EXCLUDED.note, active = EXCLUDED.active`,
    [v.id, v.name, v.place, v.price_adult, v.price_child, v.phone, v.eta, v.note, v.active]);
  }

  private async overnight(from: string, to: string, boatId?: string): Promise<Map<string, Record<string, 'in' | 'out'>>> {
    const { rows } = await this.q(`SELECT service_date::text AS d, boat_id, booking_id, include FROM trip_meal_overnight
      WHERE service_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR boat_id = $3) ORDER BY booking_id`, [from, to, boatId ?? null]);
    const out = new Map<string, Record<string, 'in' | 'out'>>();
    for (const r of rows) { const k = `${r.d}|${r.boat_id}`; (out.get(k) ?? out.set(k, {}).get(k)!)[r.booking_id] = r.include; }
    return out;
  }
  async tripActuals(from: string, to: string): Promise<TripActual[]> {
    const ovn = await this.overnight(from, to);
    const { rows } = await this.q(`${ACTUAL_SELECT} WHERE service_date BETWEEN $1 AND $2 ORDER BY service_date, boat_id`, [from, to]);
    return rows.map((r) => actualRow(r, ovn.get(`${r.service_date}|${r.boat_id}`) ?? {}));
  }
  async tripActual(date: string, boatId: string): Promise<TripActual | undefined> {
    const { rows: [r] } = await this.q(`${ACTUAL_SELECT} WHERE service_date = $1 AND boat_id = $2`, [date, boatId]);
    if (!r) return undefined;
    return actualRow(r, (await this.overnight(date, date, boatId)).get(`${date}|${boatId}`) ?? {});
  }
  async putTripActual(a: TripActual): Promise<void> {
    const m = a.meal, n = a.meal_note, c = a.closed;
    await this.q(`INSERT INTO trip_actuals (service_date, boat_id, venue_id, no_meal, meal_venue_id, meal_venue_name, meal_adults, meal_children, meal_price_adult,
      meal_price_child, meal_amount, meal_at, meal_by, meal_note, meal_note_at, meal_note_by, ran, ran_at, ran_by, closed_at, closed_by, closed_revenue, closed_cost,
      closed_profit, closed_pax, closed_rows) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      ON CONFLICT (service_date, boat_id) DO UPDATE SET venue_id = EXCLUDED.venue_id, no_meal = EXCLUDED.no_meal, meal_venue_id = EXCLUDED.meal_venue_id,
      meal_venue_name = EXCLUDED.meal_venue_name, meal_adults = EXCLUDED.meal_adults, meal_children = EXCLUDED.meal_children, meal_price_adult = EXCLUDED.meal_price_adult,
      meal_price_child = EXCLUDED.meal_price_child, meal_amount = EXCLUDED.meal_amount, meal_at = EXCLUDED.meal_at, meal_by = EXCLUDED.meal_by, meal_note = EXCLUDED.meal_note,
      meal_note_at = EXCLUDED.meal_note_at, meal_note_by = EXCLUDED.meal_note_by, ran = EXCLUDED.ran, ran_at = EXCLUDED.ran_at, ran_by = EXCLUDED.ran_by,
      closed_at = EXCLUDED.closed_at, closed_by = EXCLUDED.closed_by, closed_revenue = EXCLUDED.closed_revenue, closed_cost = EXCLUDED.closed_cost,
      closed_profit = EXCLUDED.closed_profit, closed_pax = EXCLUDED.closed_pax, closed_rows = EXCLUDED.closed_rows`,
    [a.service_date, a.boat_id, a.venue_id, a.no_meal, m?.venue_id ?? null, m?.venue_name ?? null, m?.adults ?? null, m?.children ?? null, m?.price_adult ?? null,
      m?.price_child ?? null, m?.amount ?? null, m?.at ?? null, m?.by ?? null, n?.text ?? null, n?.at ?? null, n?.by ?? null, a.ran, a.ran_at, a.ran_by,
      c?.at ?? null, c?.by ?? null, c?.revenue ?? null, c?.cost ?? null, c?.profit ?? null, c?.pax ?? null, c ? JSON.stringify(c.rows) : null]);
    await this.q('DELETE FROM trip_meal_overnight WHERE service_date = $1 AND boat_id = $2', [a.service_date, a.boat_id]);
    for (const [booking, include] of Object.entries(a.meal_overnight)) {
      await this.q('INSERT INTO trip_meal_overnight (service_date, boat_id, booking_id, include) VALUES ($1,$2,$3,$4)', [a.service_date, a.boat_id, booking, include]);
    }
  }

  async deposits(q: { agentId?: string } = {}): Promise<StoredDeposit[]> {
    return (await this.q(`${DEPOSIT_SELECT} WHERE ($1::text IS NULL OR d.agent_id = $1) ORDER BY d.received_on, d.id`, [q.agentId ?? null])).rows.map(depositRow);
  }
  async deposit(id: string): Promise<StoredDeposit | undefined> { const { rows: [r] } = await this.q(`${DEPOSIT_SELECT} WHERE d.id = $1`, [id]); return r && depositRow(r); }
  async putDeposit(d: StoredDeposit): Promise<void> {
    await this.q(`INSERT INTO deposits (id, agent_id, amount, method, received_on, ref, note, recorded_by, recorded_at, voided_at, voided_by, void_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, method = EXCLUDED.method, received_on = EXCLUDED.received_on, ref = EXCLUDED.ref, note = EXCLUDED.note,
      voided_at = EXCLUDED.voided_at, voided_by = EXCLUDED.voided_by, void_reason = EXCLUDED.void_reason`,
    [d.id, d.agent_id, d.amount, d.method, d.received_on, d.ref, d.note, d.recorded_by, d.recorded_at, d.voided_at, d.voided_by, d.void_reason]);
    await this.q('DELETE FROM deposit_slips WHERE deposit_id = $1', [d.id]);
    for (const [i, a] of d.slips.entries()) await this.q('INSERT INTO deposit_slips (deposit_id, seq, attachment_id) VALUES ($1,$2,$3)', [d.id, i, a]);
  }
  async payouts(refundIds?: readonly string[]): Promise<RefundPayout[]> {
    return (await this.q(`${PAYOUT_SELECT} WHERE ($1::text[] IS NULL OR p.refund_id = ANY($1::text[])) ORDER BY p.refund_id`, [refundIds ? [...refundIds] : null])).rows.map(payoutRow);
  }
  async putPayout(p: RefundPayout): Promise<void> {
    await this.q(`INSERT INTO refund_payouts (refund_id, paid_on, method, ref, paid_out_by, recorded_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (refund_id) DO UPDATE SET paid_on = EXCLUDED.paid_on, method = EXCLUDED.method, ref = EXCLUDED.ref, paid_out_by = EXCLUDED.paid_out_by, recorded_at = EXCLUDED.recorded_at`,
    [p.refund_id, p.paid_on, p.method, p.ref, p.paid_out_by, p.recorded_at]);
    await this.q('DELETE FROM refund_payout_slips WHERE refund_id = $1', [p.refund_id]);
    for (const [i, a] of p.slips.entries()) await this.q('INSERT INTO refund_payout_slips (refund_id, seq, attachment_id) VALUES ($1,$2,$3)', [p.refund_id, i, a]);
  }
  async deletePayout(refundId: string): Promise<boolean> { return ((await this.q('DELETE FROM refund_payouts WHERE refund_id = $1', [refundId])).rowCount ?? 0) > 0; }
}
