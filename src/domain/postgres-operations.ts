import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresFleetRepo } from './fleet-postgres.js';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Change, ChangeInput } from './changes.js';
import {
  assertKnownLocks, assertKnownRoutes, bookingView, claimsMoreSeats, dayKey, demandByDay, drawnLockIds, movedTripIds, nextTrips, paxChangedTripIds, retargetTrip,
  licenceWarnings, partialCancelByKey, partialCancelTrips, planTrips, rescheduleTrips, restoreTrips, reweighs, tripsToCheckOpen,
  type Boat, type Booking, type BookingChanges, type BookingInput, type BookingPrices, type BookingListQuery, type BookingTripInput, type Deployment, type Exclusion, type LockDraw, type OvnMode, type RouteDay, type StoredBooking, type StoredTrip,
  decodeBookingCursor, encodeBookingCursor,
} from './operations.js';
import { type PaxCategory, type PaxGrid, type PaxResidency } from './pax.js';
import {
  assertEditable, assertOpen, assertRestorable, createdLine, editedLine, movedLine, partialCancelLine, partialCancelRecord, partialCountLine, planCancel, planRescheduleRecord,
  confirmationStamp, externalIdTaken, planStatusCommand, refuse, restoredLine, stripServerOwned, totalAfterRefund, type StatusCommand, type StatusCommandRequest,
  type BookingCancellation, type BookingFeeItem, type BookingPartialCancel, type BookingReschedule, type CancelGroup, type CancelRequest, type ChargeType, type Collect,
  type HistoryEntry, type HistoryLine, type LockShortWarning, type PartialCancelRequest, type RescheduleRequest,
} from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { assertDayFits, capacityNumbers, dayCapacity, weighDay, type Capacity, type DayDeployment, type DayState, type HeldTrip } from './capacity.js';
import { poolLocks, type GroupRow, type HolderType, type LockEvent, type LockQuery, type LockRow, type NewLockEvent } from './seat-locks.js';
import { applyCalendarChange, assertCloseAllowed, assertRoutesOpen, eachDate, routeCalendar, todayInThailand, type CalendarChange, type CalendarHold, type Route, type RouteDate, type RouteDayOverride, type RouteKind, type RouteSeason } from './calendar.js';
import {
  BOOKING_HEADER_COLUMNS, BOOKING_HEADER_DATE_COLUMNS, BOOKING_HEADER_NUMERIC_COLUMNS, BOOKING_HEADER_TIMESTAMP_COLUMNS,
  type BookingHeader,
} from './booking-header.js';
import type { BookingPassenger, BookingPassengerInput } from './booking-passengers.js';
import type { BookingAddOn, BookingAddOnInput } from './booking-addons.js';
import type { BookingAdjustment, BookingAdjustmentInput } from './booking-adjustments.js';
import { pickupFields } from './pickup.js';
import { dispatchView, type BoatSplit, type StoredDispatch } from './dispatch.js';
import { rebalanceParts, vanPartsView, type StoredVanPart, type VanGroup } from './van-groups.js';
import type { StoredReconfirm } from './reconfirm.js';
import type { AltPickup } from './alt-pickups.js';
import type { Allergy } from './allergies.js';
import type { PickupArea, PickupCell, TimeProfile } from './pickup-areas.js';
import type { InvoiceBrief, InvoiceLine, StoredInvoice, StoredPayment, StoredRefund } from './invoices.js';
import type { PfmEvent } from './pfm.js';
import type { PayoutItem, StoredHandover, StoredPayout, StoredPierPayment, StoredTourSale, Takings } from './pier-money.js';
import type { StoredCotDecision, StoredNoshowCharge } from './after-trip.js';
import { type ClosureListQuery, type WeatherCase, type WeatherClosure } from './weather.js';
import { DOC_ITEMS, type DocCheck } from './doc-check.js';
import { activeUpgrade, storedUpgrades, type StoredUpgrade, type TripUpgrade } from './upgrades.js';
import type { AttachmentRef, DocumentRow, StoredFile } from './attachments.js';
import { checkinsView, type CheckinKind, type StoredCheckin } from './checkin.js';
import { applyVanPatch, isEmptyVanDay, nextVanId, type StoredVanDay, type Van, type VanInput, type VanLogEntry, type VanPatch, type VanStatusRange, type VanStatusRangeInput, type VanZoneRange, type VanZoneRangeInput } from './vans.js';
import type { VanStop } from './van-stops.js';
import type { PickupNameTh, VanJobSend } from './van-jobs.js';
import { usernameTaken, type NewUser, type StoredUser, type UserPatch } from './users.js';
import { contractView, selectContracts, type Contract, type ContractListQuery, type ContractPeriod, type ContractSeatPrice } from './contracts.js';
import type { RateSeason } from './rate-seasons.js';
import { sortHeld, type HeldOrder, type HeldStatus } from './b2c.js';
import type { AgentUsage, ContractHistoryEntry } from './agent-writes.js';
import type { StoredSalesPerson, SalesPersonSummary } from './team.js';
import { sortDocuments, sortTemplates, type ContractDocument, type ContractTemplate } from './contract-templates.js';
import { sortAddonServices, type AddonService } from './addon-services.js';
import type { StoredNationality } from './nationalities.js';
import { carryInsurance, type InsuranceFields } from './insurance.js';
import type { StoredVanBill, VanRate, VanRateField } from './van-bills.js';
import type { DailySettings } from './money-reports.js';
import {
  agentSummary, agentView, latestActivity, selectAgents, sortMarkets, sortSalesPeople,
  type Agent, type AgentActivity, type AgentListQuery, type AgentProgram, type AgentSummary, type Market, type PayType, type SalesPerson, type StoredAgent, type VatMode,
} from './agents.js';
import {
  assertOwner, assertRateTypeUnused, assertRouteBlock, generateRateTypeCode, newRateTypeRow, nextRouteSeq, patchedRateTypeRow, rateTypeExists, rateTypeView, routeRows, selectRateTypes,
  type BundleAppliesTo, type BundleMode, type NationalityScope, type RateTier, type RateType, type RateTypeCreate, type RateTypeListQuery, type RateTypePatch, type RateTypeRows,
  type RateTypeSummary, type RouteBlock, type RouteRows, type SeatPriceRow,
} from './rate-types.js';
import { BOAT_MEASURES, BOAT_TEXT_FIELDS, sortFamilies, type BoatRecord, type RouteFamily, type RouteFields, type RouteUsage, type StoredOverride } from './catalogue.js';
import {
  decidedRecord, decideStatus, discountOf, focCountOf, reweigh,
  type ApprovalDay, type ApprovalKind, type ApprovalStatus, type ApprovalWarning, type BookingApproval, type NewApproval,
} from './booking-approvals.js';
import { sortAssets, type AssetKind, type AssetOf, type AssetQuery } from './fleet-assets.js';
import { sortIncidents, sortJobs, type Incident, type IncidentQuery, type Job, type JobQuery } from './fleet-jobs.js';

/** Fleet tables (migration 130): each record's own columns; its lists live in child tables. */
const FLEET_ASSET_TABLES: Record<AssetKind, { table: string; log: string; fk: string; columns: readonly string[] }> = {
  engine: {
    table: 'fleet_engines', log: 'fleet_engine_log', fk: 'engine_id',
    columns: ['id', 'brand', 'model', 'serial', 'hp', 'boat_id', 'pos', 'status', 'base_hours', 'service_interval', 'buy_date', 'price', 'note', 'spare_location',
      'last_service_hours', 'last_service_date', 'retired', 'retired_on', 'retired_reason'],
  },
  gearbox: {
    table: 'fleet_gearboxes', log: 'fleet_gearbox_log', fk: 'gearbox_id',
    columns: ['id', 'brand', 'model', 'model_suffix', 'serial', 'boat_id', 'engine_id', 'on_boat_id', 'on_boat_pos', 'status', 'base_hours', 'install_hours',
      'service_interval', 'last_service_hours', 'last_service_date', 'buy_date', 'note', 'spare_location', 'shaft_length', 'rotation', 'gear_ratio', 'oil_capacity'],
  },
  propeller: {
    table: 'fleet_propellers', log: 'fleet_propeller_log', fk: 'propeller_id',
    columns: ['id', 'brand', 'serial', 'old_serial', 'boat_id', 'gearbox_id', 'prop_pos', 'diameter', 'pitch', 'size', 'blades', 'material', 'rotation', 'hub_size',
      'cupping', 'cost', 'install_hours', 'status', 'buy_date', 'note', 'spare_location'],
  },
};
const FLEET_INCIDENT_COLUMNS = ['id', 'no', 'boat_id', 'date', 'time', 'title', 'detail', 'remark', 'priority', 'severity', 'status', 'job_id', 'related_job_ids',
  'closed_on', 'quick_fix', 'resolved_on'] as const;
const FLEET_JOB_COLUMNS = ['id', 'no', 'boat_id', 'type', 'title', 'detail', 'location', 'status', 'start_date', 'end_date', 'incident_id', 'boat_status',
  'boat_status_reason', 'set_fixing', 'outcome', 'close_note', 'awaiting_invoice', 'parent_project_id', 'legacy_cost', 'board_lane', 'owner', 'due_date',
  'parked_on', 'pinned', 'pinned_on'] as const;

/**
 * `bookingHoldsSeats` in SQL, for the seat counts that cannot load every booking: a
 * `pending_approval` booking waiting for an over-allotment approval holds no seats. The rule is
 * written once in `booking-approvals.ts`; this is its translation, kept equal by running the suite
 * on both stores. `b` must be the booking.
 */
const WAITING_FOR_SEATS = `(b.status = 'pending_approval' AND EXISTS (
  SELECT 1 FROM booking_approvals ap WHERE ap.booking_id = b.id AND ap.kind = 'approval' AND ap.status = 'pending' AND ap.over_capacity))`;

const optionalInt = (value: unknown): number | undefined => value === null || value === undefined ? undefined : Number(value);
/** Calendar rows, read with their dates cast to text in SQL. */
const season = (row: QueryResultRow): RouteSeason => ({ id: String(row.id), route_id: String(row.route_id), kind: row.kind as RouteSeason['kind'], from_date: String(row.from_date), to_date: String(row.to_date) });
const dayOverride = (row: QueryResultRow): RouteDayOverride => ({ route_id: String(row.route_id), service_date: String(row.service_date), kind: row.kind as RouteDayOverride['kind'] });
/** `40001` serialization failure, `40P01` deadlock. Both mean "try again", not "the request was wrong". */
const TRANSACTION_ATTEMPTS = 8;
const isRetryable = (error: unknown): boolean => error instanceof Error && ['40001', '40P01'].includes((error as Error & { code?: string }).code ?? '');
const asIso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : asIso(value));
const storedUser = (row: Record<string, unknown>): StoredUser => ({
  id: Number(row.id), username: String(row.username), pass_hash: (row.pass_hash as string | null) ?? null, name: (row.name as string | null) ?? null,
  role: row.role as StoredUser['role'], can_edit: row.can_edit === true, edit_areas: (row.edit_areas as StoredUser['edit_areas']) ?? null,
  actions: (row.actions as StoredUser['actions']) ?? [], view_perms: (row.view_perms as string[] | null) ?? null,
  sales_id: (row.sales_id as string | null) ?? null, agent_id: (row.agent_id as string | null) ?? null, dept: (row.dept as string | null) ?? null,
  disabled_at: isoOrNull(row.disabled_at), tokens_valid_after: isoOrNull(row.tokens_valid_after),
  legacy_id: row.legacy_id === null || row.legacy_id === undefined ? null : Number(row.legacy_id),
  created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
});
const dateOnly = (value: unknown): string => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value);

/**
 * A booking with its trips and their passenger cells, assembled in one round trip.
 *
 * Dates are cast to text inside the JSON so the driver never hands back a `Date` for us to
 * re-render. Nothing is aggregated or derived here — totals and seat holdings come from
 * `bookingView`, which the in-process store calls too.
 */
/**
 * `DATE` columns are cast in the query and aliased, rather than relying on `b.*` being overridden
 * by a later duplicate name. `pg` builds its row object by field name, so a duplicate would work by
 * position — a rule nothing in the file states and a reader could reasonably reorder.
 */
const HEADER_DATE_SELECT = BOOKING_HEADER_DATE_COLUMNS.map((column) => `b.${column}::text AS ${column}_text`).join(', ');

// A trip's (`t`) check-in records with their events and tries (migration 036), as jsonb.
const CHECKINS_JSON = `COALESCE((SELECT jsonb_agg(to_jsonb(ck) || jsonb_build_object(
    'events', COALESCE((SELECT jsonb_agg(to_jsonb(ev) || jsonb_build_object(
        'tries', COALESCE((SELECT jsonb_agg(to_jsonb(tr) ORDER BY tr.seq) FROM booking_trip_checkin_event_tries tr
          WHERE tr.booking_trip_id = ev.booking_trip_id AND tr.kind = ev.kind AND tr.slot = ev.slot AND tr.event_seq = ev.seq), '[]'::jsonb)) ORDER BY ev.seq)
      FROM booking_trip_checkin_events ev WHERE ev.booking_trip_id = ck.booking_trip_id AND ev.kind = ck.kind AND ev.slot = ck.slot), '[]'::jsonb)))
  FROM booking_trip_checkins ck WHERE ck.booking_trip_id = t.id), '[]'::jsonb)`;
// A van part (`a`, booking_trip_van_allocations) and its group (`g`, van_groups), as jsonb fields.
const VAN_PART_FIELDS = `'idx', a.idx, 'source', a.source, 'ad', a.ad, 'chd', a.chd, 'inf', a.inf, 'foc', a.foc, 'group_id', a.van_group_id,
  'sequence', a.sequence, 'return_van_id', a.return_van_id, 'pick_area_id', a.pick_area_id, 'pick_hotel', a.pick_hotel, 'pick_zone', a.pick_zone,
  'drop_area_id', a.drop_area_id, 'drop_hotel', a.drop_hotel, 'drop_zone', a.drop_zone, 'pick_time', a.pick_time, 'alt_who', a.alt_who`;
const VAN_GROUP_JSON = `CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object('id', g.id, 'service_date', g.service_date::text, 'route_id', g.route_id,
  'zone', g.zone, 'number', g.number, 'van_id', g.van_id, 'return_van_id', g.return_van_id, 'pickup_time', g.pickup_time, 'display_order', g.display_order) END`;

const BOOKING_SELECT = `SELECT b.*, ${HEADER_DATE_SELECT}, COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'seq', t.seq, 'route_id', t.route_id, 'service_date', t.service_date::text, 'booking_mode', t.booking_mode, 'charter_boat_id', t.charter_boat_id,
      'zone', t.zone, 'pickup_time', t.pickup_time, 'pickup_time_end', t.pickup_time_end, 'pickup_at_pier', t.pickup_at_pier, 'ovn', t.ovn, 'ovn_return_date', t.ovn_return_date::text, 'ovn_leg', t.ovn_leg, 'ovn_of', t.ovn_of,
      'ovn_charge', t.ovn_charge, 'charter_price_mode', t.charter_price_mode, 'charter_price_manual', t.charter_price_manual, 'charter_price_note', t.charter_price_note,
      'subtotal', t.subtotal, 'rate_type_id', t.rate_type_id, 'promo_id', t.promo_id,
      'dispatch', (SELECT jsonb_build_object('boat_id', o.boat_id, 'pickup_time_final', o.pickup_time_final, 'pickup_time_final_end', o.pickup_time_final_end,
          'pickup_final_at_pier', o.pickup_final_at_pier, 'return_same_van', o.return_same_van, 'pier_note', o.pier_note, 'pier_note_at', o.pier_note_at, 'pier_note_by', o.pier_note_by)
        FROM booking_trip_operations o WHERE o.booking_trip_id = t.id),
      'boat_splits', COALESCE((SELECT jsonb_agg(jsonb_build_object('boat_id', s.boat_id, 'ad', s.ad, 'chd', s.chd, 'inf', s.inf, 'foc', s.foc) ORDER BY s.idx)
        FROM booking_trip_boat_splits s WHERE s.booking_trip_id = t.id), '[]'::jsonb),
      'deployed', COALESCE((SELECT jsonb_agg(d.boat_id) FROM deployments d WHERE d.route_id = t.route_id AND d.service_date = t.service_date), '[]'::jsonb),
      'van_parts', COALESCE((SELECT jsonb_agg(jsonb_build_object(${VAN_PART_FIELDS}, 'group', ${VAN_GROUP_JSON}) ORDER BY a.idx)
        FROM booking_trip_van_allocations a LEFT JOIN van_groups g ON g.id = a.van_group_id WHERE a.booking_trip_id = t.id), '[]'::jsonb),
      'checkins', ${CHECKINS_JSON},
      'upgrades', COALESCE((SELECT jsonb_agg(to_jsonb(up)) FROM booking_trip_upgrades up WHERE up.booking_trip_id = t.id), '[]'::jsonb),
      'pax', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', p.category, 'residency', p.residency, 'count', p.count) ORDER BY p.category, p.residency)
                       FROM booking_trip_pax p WHERE p.booking_trip_id = t.id), '[]'::jsonb),
      'lock_draws', COALESCE((SELECT jsonb_agg(jsonb_build_object('lock_id', d.seat_lock_id, 'qty', d.qty) ORDER BY d.seat_lock_id)
                              FROM booking_trip_lock_draws d WHERE d.booking_trip_id = t.id), '[]'::jsonb)
    ) ORDER BY t.seq)
    FROM booking_trips t WHERE t.booking_id = b.id), '[]'::jsonb) AS trips,
  (SELECT to_jsonb(rc) - 'booking_id' FROM booking_reconfirmations rc WHERE rc.booking_id = b.id) AS reconfirm,
  (SELECT to_jsonb(dc) || jsonb_build_object('results', COALESCE((SELECT jsonb_object_agg(r.item, jsonb_build_object('result', r.result, 'evidence', r.evidence, 'detail', r.detail))
     FROM booking_doc_check_results r WHERE r.booking_id = dc.booking_id), '{}'::jsonb)) FROM booking_doc_checks dc WHERE dc.booking_id = b.id) AS doc_check,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', pg.seq, 'name', pg.name, 'nationality', pg.nationality, 'type', pg.type, 'foc', pg.foc,
      'age', pg.age, 'insurance_reviewed_at', pg.insurance_reviewed_at, 'insurance_reviewed_by', pg.insurance_reviewed_by) ORDER BY pg.seq)
    FROM booking_passengers pg WHERE pg.booking_id = b.id), '[]'::jsonb) AS passengers,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', a.seq, 'type', a.type, 'label', a.label, 'amount', a.amount, 'qty', a.qty, 'note', a.note,
      'join_adults', a.join_adults, 'join_children', a.join_children) ORDER BY a.seq)
    FROM booking_addons a WHERE a.booking_id = b.id), '[]'::jsonb) AS add_ons,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', j.seq, 'kind', j.kind, 'mode', j.mode, 'value', j.value, 'label', j.label, 'note', j.note) ORDER BY j.seq)
    FROM booking_adjustments j WHERE j.booking_id = b.id), '[]'::jsonb) AS adjustments,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('seq', x.seq, 'who', x.who, 'ad', x.ad, 'chd', x.chd, 'inf', x.inf, 'foc', x.foc, 'area_id', x.area_id, 'area', x.area, 'zone', x.zone, 'place', x.place,
      'drop_same', x.drop_same, 'drop_area_id', x.drop_area_id, 'drop_area', x.drop_area, 'drop_zone', x.drop_zone, 'drop_place', x.drop_place) ORDER BY x.seq)
    FROM booking_alt_pickups x WHERE x.booking_id = b.id), '[]'::jsonb) AS alt_pickups,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('name', al.name, 'qty', al.qty) ORDER BY al.seq) FROM booking_allergies al WHERE al.booking_id = b.id), '[]'::jsonb) AS allergy_list,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(u) - 'booking_id' || jsonb_build_object('slips', COALESCE((SELECT jsonb_agg(s.attachment_id ORDER BY s.seq)
      FROM booking_upgrade_slips s WHERE s.booking_id = u.booking_id AND s.upgrade_id = u.id), '[]'::jsonb)) ORDER BY u.seq)
    FROM booking_upgrades u WHERE u.booking_id = b.id), '[]'::jsonb) AS upgrades,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('attachment_id', d.attachment_id, 'kind', d.kind, 'by', d.by, 'at', d.at) ORDER BY d.seq)
    FROM booking_documents d WHERE d.booking_id = b.id), '[]'::jsonb) AS attachments,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'name', f.filename, 'mime', f.mime, 'size', f.size)) FROM attachments f
    WHERE f.id IN (SELECT attachment_id FROM booking_documents WHERE booking_id = b.id UNION SELECT attachment_id FROM booking_upgrade_slips WHERE booking_id = b.id)), '[]'::jsonb) AS files,
  (SELECT jsonb_build_object('category', c.category, 'group', c.grp, 'note', c.note, 'charge_type', c.charge_type, 'charge_amount', c.charge_amount, 'at', c.at, 'by', c.by)
    FROM booking_cancellations c WHERE c.booking_id = b.id) AS cancellation,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'kind', i.kind, 'fee_type', i.fee_type, 'total', i.total, 'issued_at', i.issued_at,
      'voided', i.voided, 'paid', COALESCE((SELECT jsonb_agg(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.deleted_at IS NULL), '[]'::jsonb),
      'returned', (SELECT COALESCE(sum(rf.amount), 0) FROM refunds rf WHERE rf.invoice_id = i.id)))
    FROM invoices i WHERE i.id IN (SELECT invoice_id FROM invoice_lines WHERE booking_id = b.id AND removed_at IS NULL)), '[]'::jsonb) AS invoices,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('from_date', r.from_date::text, 'to_date', r.to_date::text, 'reason', r.reason, 'charge_type', r.charge_type,
      'charge_amount', r.charge_amount, 'collect', r.collect, 'at', r.at, 'by', r.by) ORDER BY r.at, r.id)
    FROM booking_reschedules r WHERE r.booking_id = b.id), '[]'::jsonb) AS reschedules,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('trip_id', pc.booking_trip_id, 'service_date', pc.service_date::text, 'pax_removed', pc.pax_removed, 'count', pc.count,
      'category', pc.category, 'group', pc.grp, 'note', pc.note, 'charged_count', pc.charged_count, 'charged_amount', pc.charged_amount,
      'waived_count', pc.waived_count, 'waived_amount', pc.waived_amount, 'at', pc.at, 'by', pc.by) ORDER BY pc.at, pc.id)
    FROM booking_partial_cancels pc WHERE pc.booking_id = b.id), '[]'::jsonb) AS partial_cancels,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('type', f.type, 'label', f.label, 'amount', f.amount, 'at', f.at) ORDER BY f.at, f.id)
    FROM booking_fee_items f WHERE f.booking_id = b.id), '[]'::jsonb) AS fee_items,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('kind', ap.kind, 'status', ap.status, 'over_capacity', ap.over_capacity, 'over_total', ap.over_total,
      'discount', ap.discount, 'foc_count', ap.foc_count, 'target_status', ap.target_status, 'requested_by', ap.requested_by, 'requested_at', ap.requested_at,
      'decided_by', ap.decided_by, 'decided_at', ap.decided_at, 'note', ap.note, 'reason', ap.reason,
      'days', COALESCE((SELECT jsonb_agg(jsonb_build_object('route_id', ad.route_id, 'service_date', ad.service_date::text, 'need', ad.need, 'over_by', ad.over_by, 'licensed_free', ad.licensed_free)
                                         ORDER BY ad.service_date, ad.route_id COLLATE "C")
                        FROM booking_approval_days ad WHERE ad.approval_id = ap.id), '[]'::jsonb)) ORDER BY ap.requested_at, ap.id)
    FROM booking_approvals ap WHERE ap.booking_id = b.id), '[]'::jsonb) AS approvals
  FROM bookings b`;

/**
 * A `timestamptz` inside JSON arrives as text in the session's zone (`2026-10-05 09:11:09.1+07`),
 * not the `Z` instant the in-process store writes, so it is re-rendered the same way.
 */
const jsonInstant = (value: unknown): string => new Date(String(value)).toISOString();
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const storedInvoice = (r: QueryResultRow): StoredInvoice => ({
  id: String(r.id), number: String(r.number), agent_id: r.agent_id ?? null, kind: r.kind, fee_type: r.fee_type ?? null,
  vat_mode: r.vat_mode ?? null, vat_rate: numOrNull(r.vat_rate), subtotal: Number(r.subtotal), net_amount: numOrNull(r.net_amount), vat_amount: numOrNull(r.vat_amount),
  total: Number(r.total), wht_amount: numOrNull(r.wht_amount), issued_at: asIso(r.issued_at), due_at: asIso(r.due_at),
  note: r.note ?? null, ref: r.ref ?? null, dear: r.dear ?? null, accept_at: r.accept_at ?? null, remark: r.remark ?? null,
  voided: r.voided === true, voided_at: r.voided_at ? asIso(r.voided_at) : null, voided_by: r.voided_by ?? null, void_reason: r.void_reason ?? null,
  created_by: r.created_by ?? null,
  lines: ((r.lines as Record<string, unknown>[]) ?? []).map((l): InvoiceLine => ({
    seq: Number(l.seq), booking_id: (l.booking_id as string) ?? null, label: String(l.label), amount: Number(l.amount), discount: numOrNull(l.discount),
    removed_at: l.removed_at ? jsonInstant(l.removed_at) : null, removed_by: (l.removed_by as string) ?? null, removed_reason: (l.removed_reason as string) ?? null,
    ...(l.cot_date ? { cot_date: String(l.cot_date) } : {}),
  })),
});
const storedRefund = (r: QueryResultRow): StoredRefund => ({
  id: String(r.id), kind: r.kind, invoice_id: String(r.invoice_id), booking_id: r.booking_id ?? null, agent_id: r.agent_id ?? null,
  amount: Number(r.amount), reason: String(r.reason), created_by: r.created_by ?? null, created_at: asIso(r.created_at),
});
const weatherClosureRow = (r: QueryResultRow): WeatherClosure => ({
  id: String(r.id), route_id: String(r.route_id), service_date: String(r.service_date), note: r.note ?? null,
  closed_by: r.closed_by ?? null, closed_at: asIso(r.closed_at), updated_by: r.updated_by ?? null, updated_at: r.updated_at ? asIso(r.updated_at) : null,
  reopened_by: r.reopened_by ?? null, reopened_at: r.reopened_at ? asIso(r.reopened_at) : null,
});
const weatherCaseRow = (r: QueryResultRow): WeatherCase => ({
  closure_id: String(r.closure_id), booking_id: String(r.booking_id), status: r.status,
  notified_at: r.notified_at ? asIso(r.notified_at) : null, notified_by: r.notified_by ?? null,
  outcome: r.outcome ?? null, new_date: r.new_date ?? null, resolved_at: r.resolved_at ? asIso(r.resolved_at) : null, resolved_by: r.resolved_by ?? null,
});
const WEATHER_CLOSURE_COLUMNS = 'id, route_id, service_date::text AS service_date, note, closed_by, closed_at, updated_by, updated_at, reopened_by, reopened_at';
const WEATHER_CASE_COLUMNS = 'closure_id, booking_id, status, notified_at, notified_by, outcome, new_date::text AS new_date, resolved_at, resolved_by';
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const NUMERIC_HEADER = new Set<string>(BOOKING_HEADER_NUMERIC_COLUMNS);
const TIMESTAMP_HEADER = new Set<string>(BOOKING_HEADER_TIMESTAMP_COLUMNS);
const DATE_HEADER = new Set<string>(BOOKING_HEADER_DATE_COLUMNS);

/** Reads the header columns off a row, converting the three types `pg` does not hand back as-is. */
const newTripId = (): string => `trip_${randomUUID()}`;

const header = (row: QueryResultRow): BookingHeader => {
  const values: Record<string, unknown> = {};
  for (const column of BOOKING_HEADER_COLUMNS) {
    const raw = DATE_HEADER.has(column) ? row[`${column}_text`] : row[column];
    if (raw === null || raw === undefined) continue;
    values[column] = NUMERIC_HEADER.has(column) ? Number(raw) : TIMESTAMP_HEADER.has(column) ? asIso(raw) : raw;
  }
  return values as BookingHeader;
};

const stored = (row: QueryResultRow): StoredBooking => ({
  ...header(row),
  id: String(row.id), status: row.status as Booking['status'], version: Number(row.version), created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
  cancellation_reason: row.cancellation_reason ?? undefined, external_id: row.external_id ?? undefined, agent_id: row.agent_id ?? undefined,
  voucher_ref: row.voucher_ref ?? undefined, rate_type_ref: row.rate_type_ref ?? undefined, booking_data: row.booking_data ?? undefined,
  trips: (row.trips as Record<string, unknown>[]).map((trip) => ({
    id: String(trip.id), seq: Number(trip.seq), route_id: String(trip.route_id), service_date: String(trip.service_date), booking_mode: String(trip.booking_mode),
    pax: (trip.pax as Record<string, unknown>[]).map((cell) => ({ category: cell.category as PaxCategory, residency: cell.residency as PaxResidency, count: Number(cell.count) })),
    ...(trip.charter_boat_id ? { charter_boat_id: String(trip.charter_boat_id) } : {}),
    lock_draws: (trip.lock_draws as Record<string, unknown>[]).map((draw): LockDraw => ({ lock_id: String(draw.lock_id), qty: Number(draw.qty) })),
    ...(trip.zone ? { zone: String(trip.zone) } : {}),
    ...pickupFields({ pickup_time: trip.pickup_time ? String(trip.pickup_time) : undefined, pickup_time_end: trip.pickup_time_end ? String(trip.pickup_time_end) : undefined, pickup_at_pier: trip.pickup_at_pier === true }),
    ...(trip.ovn_charge == null ? {} : { ovn_charge: Number(trip.ovn_charge) }),
    ...(trip.charter_price_mode ? { charter_price_mode: trip.charter_price_mode as 'rate' | 'manual' } : {}),
    ...(trip.charter_price_manual == null ? {} : { charter_price_manual: Number(trip.charter_price_manual) }),
    ...(trip.charter_price_note ? { charter_price_note: String(trip.charter_price_note) } : {}),
    ...(trip.subtotal == null ? {} : { subtotal: Number(trip.subtotal) }),
    ...(trip.rate_type_id ? { rate_type_id: String(trip.rate_type_id) } : {}),
    ...(trip.promo_id ? { promo_id: String(trip.promo_id) } : {}),
    ...(trip.ovn ? { ovn: trip.ovn as OvnMode } : {}),
    ...(trip.ovn_return_date ? { ovn_return_date: String(trip.ovn_return_date) } : {}),
    ovn_leg: trip.ovn_leg === true,
    ...(trip.ovn_of ? { ovn_of: String(trip.ovn_of) } : {}),
  })),
  passengers: (row.passengers as Record<string, unknown>[]).map((passenger) => ({
    seq: Number(passenger.seq), name: String(passenger.name),
    nationality: passenger.nationality ?? undefined, type: passenger.type ?? undefined,
    foc: passenger.foc ?? undefined,
    ...(passenger.age == null ? {} : { age: Number(passenger.age) }),
    ...(passenger.insurance_reviewed_at == null ? {} : { insurance_reviewed_at: jsonInstant(passenger.insurance_reviewed_at) }),
    ...(passenger.insurance_reviewed_by == null ? {} : { insurance_reviewed_by: String(passenger.insurance_reviewed_by) }),
  })) as BookingPassenger[],
  // A NULL column is left off rather than sent as null, matching the in-process store, which never
  // set it. `amount` is NUMERIC; Number() keeps it a JSON number whichever way `pg` hands it over.
  add_ons: (row.add_ons as Record<string, unknown>[]).map((addOn): BookingAddOn => ({
    seq: Number(addOn.seq), type: String(addOn.type),
    ...(addOn.label == null ? {} : { label: String(addOn.label) }),
    ...(addOn.amount == null ? {} : { amount: Number(addOn.amount) }),
    ...(addOn.qty == null ? {} : { qty: Number(addOn.qty) }),
    ...(addOn.note == null ? {} : { note: String(addOn.note) }),
    ...(addOn.join_adults == null ? {} : { join_adults: Number(addOn.join_adults) }),
    ...(addOn.join_children == null ? {} : { join_children: Number(addOn.join_children) }),
  })),
  allergy_list: ((row.allergy_list as Allergy[]) ?? []).map((a) => ({ name: String(a.name), qty: Number(a.qty) })),
  attachments: ((row.attachments as Record<string, unknown>[]) ?? []).map((d): DocumentRow => ({
    attachment_id: String(d.attachment_id), kind: (d.kind as DocumentRow['kind']) ?? null, by: (d.by as string) ?? null, at: d.at ? jsonInstant(d.at) : null,
  })),
  upgrades: (row.upgrades as Record<string, unknown>[]).map((u): StoredUpgrade => {
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      id: String(u.id), label: String(u.label), sell_price: Number(u.sell_price), to_company: num(u.to_company), seller: (u.seller as string) ?? null,
      note: (u.note as string) ?? null, collected: (u.collected as boolean) ?? null, settle: (u.settle as StoredUpgrade['settle']) ?? null,
      method: (u.method as string) ?? null, fee_pct: num(u.fee_pct), fee: num(u.fee), customer_paid: num(u.customer_paid), at: u.at ? jsonInstant(u.at) : null,
      slips: ((u.slips as string[]) ?? []).map(String),
    };
  }),
  alt_pickups: (row.alt_pickups as Record<string, unknown>[]).map(({ seq: _seq, ...a }) => ({
    ...a, ad: Number(a.ad ?? 0), chd: Number(a.chd ?? 0), inf: Number(a.inf ?? 0), foc: Number(a.foc ?? 0),
  }) as AltPickup),
  adjustments: (row.adjustments as Record<string, unknown>[]).map((a): BookingAdjustment => ({
    seq: Number(a.seq), kind: a.kind as BookingAdjustment['kind'], mode: a.mode as BookingAdjustment['mode'], value: Number(a.value),
    ...(a.label == null ? {} : { label: String(a.label) }),
    ...(a.note == null ? {} : { note: String(a.note) }),
  })),
  ...(row.cancellation ? { cancellation: cancellation(row.cancellation as Record<string, unknown>) } : {}),
  reschedules: (row.reschedules as Record<string, unknown>[]).map((r): BookingReschedule => ({
    from_date: String(r.from_date), to_date: String(r.to_date), reason: textOrNull(r.reason), charge_type: r.charge_type as ChargeType,
    charge_amount: Number(r.charge_amount), collect: r.collect as Collect, at: jsonInstant(r.at), by: textOrNull(r.by),
  })),
  partial_cancels: (row.partial_cancels as Record<string, unknown>[]).map((p): BookingPartialCancel => ({
    trip_id: textOrNull(p.trip_id), service_date: textOrNull(p.service_date), pax_removed: p.pax_removed as PaxGrid, count: Number(p.count),
    category: textOrNull(p.category), group: textOrNull(p.group) as CancelGroup | null, note: textOrNull(p.note),
    charged: { count: Number(p.charged_count), amount: Number(p.charged_amount) }, waived: { count: Number(p.waived_count), amount: Number(p.waived_amount) },
    at: jsonInstant(p.at), by: textOrNull(p.by),
  })),
  fee_items: (row.fee_items as Record<string, unknown>[]).map((f): BookingFeeItem => ({
    type: String(f.type), label: textOrNull(f.label), amount: Number(f.amount), at: jsonInstant(f.at),
  })),
  approvals: (row.approvals as Record<string, unknown>[]).map(approval),
});
const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const approval = (a: Record<string, unknown>): BookingApproval => ({
  kind: a.kind as ApprovalKind, status: a.status as ApprovalStatus, reason: textOrNull(a.reason), over_capacity: a.over_capacity === true,
  over_total: numberOrNull(a.over_total), discount: numberOrNull(a.discount), foc_count: numberOrNull(a.foc_count),
  target_status: a.target_status as Booking['status'], requested_by: textOrNull(a.requested_by), requested_at: jsonInstant(a.requested_at),
  decided_by: textOrNull(a.decided_by), decided_at: a.decided_at == null ? null : jsonInstant(a.decided_at), note: textOrNull(a.note),
  days: (a.days as Record<string, unknown>[]).map((d): ApprovalDay => ({ route_id: String(d.route_id), service_date: String(d.service_date), need: Number(d.need), over_by: Number(d.over_by), licensed_free: d.licensed_free == null ? null : Number(d.licensed_free) })),
});
const cancellation = (c: Record<string, unknown>): BookingCancellation => ({
  category: String(c.category), group: c.group as CancelGroup, note: textOrNull(c.note), charge_type: c.charge_type as ChargeType,
  charge_amount: Number(c.charge_amount), at: jsonInstant(c.at), by: textOrNull(c.by),
});
/** A trip's dispatch from the booking query (migration 033), as `dispatchView` reads it. */
const storedDispatch = (trip: Record<string, unknown>): StoredDispatch | undefined => {
  const d = trip.dispatch as Record<string, unknown> | null;
  const splits = (trip.boat_splits as Record<string, unknown>[]).map((s): BoatSplit => ({ boat_id: String(s.boat_id), ad: Number(s.ad), chd: Number(s.chd), inf: Number(s.inf), foc: Number(s.foc) }));
  if (!d && splits.length === 0) return undefined;
  return {
    boat_id: (d?.boat_id as string | null) ?? null, boat_splits: splits,
    pickup_time_final: (d?.pickup_time_final as string | null) ?? null, pickup_time_final_end: (d?.pickup_time_final_end as string | null) ?? null,
    pickup_final_at_pier: d?.pickup_final_at_pier === true, return_same_van: d?.return_same_van === true,
    pier_note: d?.pier_note ? { text: String(d.pier_note), at: jsonInstant(d.pier_note_at), by: (d.pier_note_by as string | null) ?? null } : null,
  };
};
/** A van part from `VAN_PART_FIELDS`. */
const vanPart = (p: Record<string, unknown>): StoredVanPart => ({
  idx: Number(p.idx), source: p.source as StoredVanPart['source'], ad: Number(p.ad), chd: Number(p.chd), inf: Number(p.inf), foc: Number(p.foc),
  group_id: text(p.group_id), sequence: p.sequence === null || p.sequence === undefined ? null : Number(p.sequence), return_van_id: text(p.return_van_id),
  alt: p.source === 'alt_pickup' ? { pick_area_id: text(p.pick_area_id), pick_hotel: text(p.pick_hotel), pick_zone: text(p.pick_zone),
    drop_area_id: text(p.drop_area_id), drop_hotel: text(p.drop_hotel), drop_zone: text(p.drop_zone), pick_time: text(p.pick_time), alt_who: text(p.alt_who) } : null,
});
const vanGroup = (g: Record<string, unknown>): VanGroup => ({
  id: String(g.id), service_date: String(g.service_date), route_id: String(g.route_id), zone: String(g.zone), number: Number(g.number),
  van_id: text(g.van_id), return_van_id: text(g.return_van_id), pickup_time: text(g.pickup_time),
  display_order: g.display_order === null || g.display_order === undefined ? null : Number(g.display_order),
});
const booking = (row: QueryResultRow): Booking => {
  const raw = new Map((row.trips as Record<string, unknown>[]).map((t) => [String(t.id), t]));
  return bookingView(stored(row), (trip) => {
    const t = raw.get(trip.id)!;
    const parts = (t.van_parts as Record<string, unknown>[]) ?? [];
    const groups = new Map(parts.filter((p) => p.group).map((p) => [String(p.group_id), vanGroup(p.group as Record<string, unknown>)]));
    return dispatchView(storedDispatch(t), new Set((t.deployed as string[]) ?? []), vanPartsView(parts.map(vanPart), trip.pax, groups),
      checkinsView(((t.checkins as Record<string, unknown>[]) ?? []).map(storedCheckin)), activeUpgrade(((t.upgrades as Record<string, unknown>[]) ?? []).map(tripUpgrade)));
  }, storedReconfirm(row.reconfirm), new Map(((row.files as AttachmentRef[]) ?? []).map((f) => [f.id, { id: f.id, name: f.name, mime: f.mime, size: Number(f.size) }])), storedDocCheck(row.doc_check),
  ((row.invoices as Record<string, unknown>[]) ?? []).map((i): InvoiceBrief => ({
    id: String(i.id), number: String(i.number), kind: i.kind as InvoiceBrief['kind'], fee_type: (i.fee_type as InvoiceBrief['fee_type']) ?? null, total: Number(i.total),
    issued_at: jsonInstant(i.issued_at), voided: i.voided === true, paid: ((i.paid as unknown[]) ?? []).map(Number), returned: Number(i.returned ?? 0),
  })));
};
/** A check-in record from `CHECKINS_JSON`: its columns as jsonb, timestamps as ISO text. */
const storedCheckin = (r: Record<string, unknown>): StoredCheckin => {
  const t = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const at = (v: unknown): string | null => (v === null || v === undefined ? null : jsonInstant(v));
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    kind: r.kind as CheckinKind, slot: Number(r.slot), expected: n(r.expected), actual_pax: n(r.actual_pax),
    checked_in_at: at(r.checked_in_at), checked_in_by: t(r.checked_in_by), reason_code: t(r.reason_code), reason_note: t(r.reason_note), reason_at: t(r.reason_at),
    arrived_at: at(r.arrived_at), arrived_by: t(r.arrived_by), cleared_at: at(r.cleared_at), cleared_by: t(r.cleared_by),
    flow: (r.flow as StoredCheckin['flow']) ?? null, flow_at: t(r.flow_at), flow_by: t(r.flow_by), flow_note: t(r.flow_note),
    reinstate: r.reinstate_at || r.reinstate_by || r.reinstate_ts ? { at: t(r.reinstate_at), by: t(r.reinstate_by), ts: at(r.reinstate_ts) } : null,
    self_add: r.self_add_pax === null || r.self_add_pax === undefined ? null : {
      pax: Number(r.self_add_pax), ad: n(r.self_add_ad), chd: n(r.self_add_chd), inf: n(r.self_add_inf), foc: n(r.self_add_foc),
      at: t(r.self_add_at), by: t(r.self_add_by), ts: at(r.self_add_ts), note: t(r.self_add_note),
    },
    events: ((r.events as Record<string, unknown>[]) ?? []).map((e) => ({
      type: e.type as 'no_show' | 'cxl', pax: Number(e.pax), ad: n(e.ad), chd: n(e.chd), inf: n(e.inf), foc: n(e.foc),
      reason_code: t(e.reason_code), note: t(e.note), at: t(e.at), by: t(e.by), ts: at(e.ts),
      undone: e.undone_why ? { why: e.undone_why as 'found' | 'mistake', at: t(e.undone_at), by: t(e.undone_by), ts: at(e.undone_ts), note: t(e.undone_note) } : null,
      tries: ((e.tries as Record<string, unknown>[]) ?? []).map((x) => ({ at: t(x.at), by: t(x.by), note: t(x.note), ts: at(x.ts) })),
    })),
    updated_at: jsonInstant(r.updated_at), updated_by: t(r.updated_by),
  };
};
/** A route upgrade row (migration 038), from jsonb or a plain row. */
const tripUpgrade = (r: Record<string, unknown>): TripUpgrade => ({
  id: Number(r.id), booking_trip_id: String(r.booking_trip_id), from_route_id: String(r.from_route_id), to_route_id: String(r.to_route_id),
  reason: String(r.reason), charge: Number(r.charge), upgrade_id: (r.upgrade_id as string) ?? null, at: jsonInstant(r.at), by: (r.by as string) ?? null,
  undone_at: r.undone_at ? jsonInstant(r.undone_at) : null, undone_by: (r.undone_by as string) ?? null,
});
/** The booking's document check from `BOOKING_SELECT` (migration 042). */
const storedDocCheck = (r: Record<string, unknown> | null): DocCheck | null => {
  if (!r) return null;
  const t = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const hasPre = r.pre_at || r.pre_error || r.pre_text || Object.keys((r.results as object) ?? {}).length;
  return {
    status: (r.status as DocCheck['status']) ?? null, by: t(r.by), at: r.at ? jsonInstant(r.at) : null, note: t(r.note),
    items: Object.fromEntries(DOC_ITEMS.map((k) => [k, r[`${k}_ok`] === true])) as DocCheck['items'],
    pre: hasPre ? { at: r.pre_at ? jsonInstant(r.pre_at) : null, lang: t(r.pre_lang), error: t(r.pre_error), text: t(r.pre_text), results: (r.results as NonNullable<DocCheck['pre']>['results']) ?? {} } : null,
  };
};
/** The booking's reconfirmation from `BOOKING_SELECT` (migration 035). */
const storedReconfirm = (r: Record<string, unknown> | null): StoredReconfirm | null => r && {
  status: (r.status as StoredReconfirm['status']) ?? null, via: (r.via as StoredReconfirm['via']) ?? null,
  at: r.at ? jsonInstant(r.at) : null, by: (r.by as string) ?? null, sent_at: r.sent_at ? jsonInstant(r.sent_at) : null, sent_by: (r.sent_by as string) ?? null,
};
const heldOrderRow = (r: QueryResultRow): HeldOrder => ({
  id: String(r.id), action: r.action, external_id: r.external_id ?? null, booking_id: r.booking_id ?? null, request: r.request, problem: String(r.problem),
  attempts: Number(r.attempts), status: r.status, received_at: asIso(r.received_at), last_received_at: asIso(r.last_received_at), received_by: r.received_by ?? null,
  decided_at: r.decided_at ? asIso(r.decided_at) : null, decided_by: r.decided_by ?? null, note: r.note ?? null, resolved_booking_id: r.resolved_booking_id ?? null,
});
/** Every `seat_locks` column, its dates cast to text. */
const LOCK_COLUMNS = `id, version, route_id, service_date::text AS service_date, pax, pending_pax, released_pax, holder_type, agent_id, status, expiry::text AS expiry,
  reason, group_id, parent_id, sub_name, boat_id, created_at, created_by, updated_at, released_at`;
const lockRow = (row: QueryResultRow): LockRow => ({
  id: String(row.id), version: Number(row.version), route_id: String(row.route_id), service_date: String(row.service_date), pax: Number(row.pax),
  pending_pax: Number(row.pending_pax), released_pax: Number(row.released_pax), holder_type: row.holder_type as HolderType, agent_id: row.agent_id ?? null,
  status: row.status as LockRow['status'], expiry: row.expiry ?? null, reason: row.reason ?? null, group_id: row.group_id ?? null, parent_id: row.parent_id ?? null,
  sub_name: row.sub_name ?? null, boat_id: row.boat_id ?? null, created_at: asIso(row.created_at), created_by: row.created_by ?? null, updated_at: asIso(row.updated_at),
  released_at: row.released_at ? asIso(row.released_at) : null,
});
const GROUP_COLUMNS = `id, version, route_id, holder_type, agent_id, date_from::text AS date_from, date_to::text AS date_to, weekdays, pax,
  release_days_before, release_time, reason, created_at, created_by, updated_at`;
const groupRow = (row: QueryResultRow): GroupRow => ({
  id: String(row.id), version: Number(row.version), route_id: String(row.route_id), holder_type: row.holder_type as HolderType, agent_id: row.agent_id ?? null,
  date_from: String(row.date_from), date_to: String(row.date_to), weekdays: (row.weekdays as unknown[]).map(Number), pax: Number(row.pax),
  release_days_before: row.release_days_before === null ? null : Number(row.release_days_before), release_time: row.release_time ?? null, reason: row.reason ?? null,
  created_at: asIso(row.created_at), created_by: row.created_by ?? null, updated_at: asIso(row.updated_at),
});
const lockEvent = (row: QueryResultRow): LockEvent => ({
  id: Number(row.id), lock_id: row.lock_id ?? null, group_id: row.group_id ?? null, type: String(row.type), qty: row.qty === null ? null : Number(row.qty),
  trip_date: row.trip_date ?? null, booking_id: row.booking_id ?? null, note: row.note ?? null, day: String(row.day), at: row.at ? asIso(row.at) : null,
  by: row.by ?? null, imported: row.imported === true,
});

const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/**
 * Every `agents` column with its `DATE`s cast to text, and the programmes in order. The row is read
 * into `StoredAgent` and nothing else; `agents.ts` decides everything the API says about it.
 */
const AGENT_SELECT = `SELECT a.*, a.contract_start::text AS contract_start_text, a.contract_end::text AS contract_end_text,
    a.signatory_signed_date::text AS signatory_signed_date_text,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('route_id', p.route_id, 'book_from', p.book_from::text, 'book_to', p.book_to::text, 'note', p.note) ORDER BY p.idx, p.route_id)
              FROM agent_programs p WHERE p.agent_id = a.id), '[]'::jsonb) AS programs
  FROM agents a`;

const storedAgent = (row: QueryResultRow): StoredAgent => ({
  id: String(row.id), code: text(row.code), name: String(row.name),
  market_id: text(row.market_id), sub_market: text(row.sub_market), sales_id: text(row.sales_id), color: text(row.color),
  pay_type: text(row.pay_type) as PayType | null, vat_mode: String(row.vat_mode) as VatMode,
  credit_days: num(row.credit_days), credit_limit: num(row.credit_limit),
  contact: text(row.contact), email: text(row.email), phone: text(row.phone), note: text(row.note),
  rate_type_id: text(row.rate_type_id), contract_template_id: text(row.contract_template_id),
  contract_status: text(row.contract_status), contract_version: text(row.contract_version),
  contract_start: text(row.contract_start_text), contract_end: text(row.contract_end_text),
  legal_name: text(row.legal_name), tax_id: text(row.tax_id), tat_license: text(row.tat_license), address: text(row.address),
  company_tel: text(row.company_tel), hotline: text(row.hotline), fax: text(row.fax), website: text(row.website),
  signatory_name: text(row.signatory_name), signatory_designation: text(row.signatory_designation), signatory_tel: text(row.signatory_tel),
  signatory_signed_date: text(row.signatory_signed_date_text),
  booking_method: text(row.booking_method), booking_cutoff: text(row.booking_cutoff), booking_cancel_policy: text(row.booking_cancel_policy),
  booking_email: text(row.booking_email), booking_phone: text(row.booking_phone),
  house: row.house === true, active: row.active === true, created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
  programs: (row.programs as Record<string, unknown>[]).map((program) => ({
    route_id: String(program.route_id), book_from: text(program.book_from), book_to: text(program.book_to), note: text(program.note),
  })),
});

/** Groups rows under a route-and-date key, so assembling a range is a lookup per cell rather than a scan. */
const byDay = <T extends QueryResultRow>(rows: T[]): Map<string, T[]> => {
  const days = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.route_id} ${row.service_date}`;
    const bucket = days.get(key);
    if (bucket) bucket.push(row); else days.set(key, [row]);
  }
  return days;
};

const VAN_SELECT = 'SELECT id, name, plate, type, capacity, ownership, partner_name, zone_base, color, driver, driver_phone, active, note FROM vans';
const vanRow = (r: Record<string, unknown>): Van => ({
  id: r.id as string, name: r.name as string, plate: (r.plate as string) ?? null, type: (r.type as string) ?? null, capacity: Number(r.capacity),
  ownership: r.ownership as Van['ownership'], partner_name: (r.partner_name as string) ?? null, zone_base: (r.zone_base as Van['zone_base']) ?? null,
  color: (r.color as string) ?? null, driver: (r.driver as string) ?? null, driver_phone: (r.driver_phone as string) ?? null, active: r.active === true,
  note: (r.note as string) ?? null,
});
const RANGE_SELECT = 'SELECT id, van_id, status, from_date::text AS from_date, to_date::text AS to_date, note FROM van_status_ranges';
const rangeRow = (r: Record<string, unknown>): VanStatusRange => ({
  id: Number(r.id), van_id: r.van_id as string, status: r.status as VanStatusRange['status'], from_date: r.from_date as string, to_date: (r.to_date as string) ?? null, note: (r.note as string) ?? null,
});

const STOP_SELECT = `SELECT id, service_date::text AS service_date, route_id, group_id, kind, label, pax, time, place, area_id, area, leg, phone, note, sequence,
  checked_at, checked_by, checked_seats, created_at, created_by, updated_at, updated_by FROM van_stops`;
const stopRow = (r: Record<string, unknown>): VanStop => ({
  id: r.id as string, service_date: r.service_date as string, route_id: r.route_id as string, group_id: (r.group_id as string) ?? null,
  kind: r.kind as VanStop['kind'], label: r.label as string, pax: Number(r.pax), time: (r.time as string) ?? null, place: r.place as string,
  area_id: (r.area_id as string) ?? null, area: (r.area as string) ?? null, leg: r.leg as VanStop['leg'], phone: (r.phone as string) ?? null,
  note: (r.note as string) ?? null, sequence: r.sequence === null ? null : Number(r.sequence),
  checked_in: r.checked_at ? { at: (r.checked_at as Date).toISOString(), by: (r.checked_by as string) ?? null, seats: Number(r.checked_seats ?? 0) } : null,
  created_at: (r.created_at as Date).toISOString(), created_by: (r.created_by as string) ?? null,
  updated_at: r.updated_at ? (r.updated_at as Date).toISOString() : null, updated_by: (r.updated_by as string) ?? null,
});

/** PostgreSQL repository. Advisory transaction locks serialize one route/day capacity pool across all API instances. */
export class PostgresOperationsStore {
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<PoolClient>();
  /** Fleet part B (todo/fleet-maintenance-model.md), in the same transaction as everything else. */
  readonly fleetRepo = new PostgresFleetRepo(() => this.client());
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }
  private client(): Pool | PoolClient { return this.context.getStore() ?? this.pool; }
  async close(): Promise<void> {
    if (this.listener) { this.listener.release(); this.listener = undefined; }
    await this.pool.end();
  }

  // ── The change feed (migration 044) ──
  /**
   * Writes a transaction's changes just before it commits: under one advisory lock, so version order
   * is commit order and a client reading up to N never misses an N−1 still committing. `pg_notify`
   * reaches the other instances only on commit.
   */
  async recordChanges(rows: readonly ChangeInput[]): Promise<void> {
    if (!rows.length) return;
    await this.client().query("SELECT pg_advisory_xact_lock(hashtext('changes'))");
    for (const c of rows) {
      await this.client().query(`INSERT INTO changes (version, kind, entity_id, action, route_days, changed_by) VALUES (nextval('changes_version_seq'), $1, $2, $3, $4, $5)`,
        [c.kind, c.entity_id, c.action, c.route_days === null ? null : JSON.stringify(c.route_days), c.changed_by]);
    }
    await this.client().query("SELECT pg_notify('changes', '')");
  }
  async changesSince(since: number, limit: number): Promise<Change[]> {
    const { rows } = await this.client().query('SELECT * FROM changes WHERE version > $1 ORDER BY version LIMIT $2', [since, limit]);
    return rows.map((r) => ({ version: Number(r.version), kind: r.kind, entity_id: r.entity_id, action: r.action, route_days: r.route_days ?? null, changed_by: r.changed_by ?? null, changed_at: (r.changed_at as Date).toISOString() }));
  }
  async latestChangeVersion(): Promise<number> { return Number((await this.client().query('SELECT COALESCE(max(version), 0) AS v FROM changes')).rows[0].v); }
  private listener: PoolClient | undefined;
  private listeners = new Set<() => void>();
  /** Calls `onChange` whenever any instance commits changes; one connection per instance listens for all. */
  async subscribeChanges(onChange: () => void): Promise<() => void> {
    this.listeners.add(onChange);
    if (!this.listener) {
      this.listener = await this.pool.connect();
      this.listener.on('notification', () => { for (const fn of this.listeners) fn(); });
      await this.listener.query('LISTEN changes');
    }
    return () => { this.listeners.delete(onChange); };
  }
  /** Migration files not yet applied here: the stream's health (legacy's /api/version reported it). */
  async migrationsPending(): Promise<number> {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    const { rows } = await this.client().query('SELECT count(*)::int AS n FROM schema_migrations');
    return Math.max(0, files.length - Number(rows[0].n));
  }

  /**
   * A serializable unit of work, retried when the database asks us to.
   *
   * Capacity is read from `booking_trips` and written to the same table, so two transactions that
   * never touch the same route or day can still be flagged as a read/write dependency: predicate
   * locks are taken by page, and a small table is a single page. PostgreSQL's answer to `40001` is
   * literally "the transaction might succeed if retried", and a SERIALIZABLE store without a retry
   * loop is incomplete — it turns a contended write into a 500 for the caller.
   *
   * Retrying is safe because a rolled-back attempt leaves nothing behind and every handler re-reads
   * what it needs. Deadlocks (`40P01`) are retried on the same grounds.
   */
  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return await work();
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await this.context.run(client, work);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt >= TRANSACTION_ATTEMPTS || !isRetryable(error)) throw error;
      } finally { client.release(); }
      // Contended pools are already serialized by the advisory lock, so a jittered pause is enough to
      // let the winner commit rather than have both sides collide again immediately. It doubles each
      // time: a write now also touches its history and action records, which every booking read
      // scans, so several writers can keep colliding for longer than a fixed step outlasts.
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 5 * (1 + Math.random())));
    }
  }
  private async lockPool(routeId: string, date: string): Promise<void> { await this.client().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${routeId}:${date}`]); }

  /** One route's day, with per-boat and per-lock detail. The rules are `dayCapacity`'s; this only gathers rows. */
  async day(routeId: string, serviceDate: string, exclude: Exclusion = {}): Promise<DayState> {
    return (await this.dayRange([routeId], serviceDate, serviceDate, exclude))[0];
  }

  async capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Promise<Capacity> {
    return capacityNumbers(await this.day(routeId, serviceDate, exclude));
  }

  /**
   * `day` for every route in `routeIds` on every date in `from..to`: date first, then routes in the
   * order given. Three queries whatever the width of the range; a day with nothing on it still gets
   * an all-zero entry.
   */
  async dayRange(routeIds: readonly string[], from: string, to: string, exclude: Exclusion = {}): Promise<RouteDay[]> {
    // `id IS DISTINCT FROM NULL` is true for every row, so an absent exclusion needs no query variant.
    // The list of statuses that release their seats is passed in rather than written here, and it is
    // a denylist: `booking-status.ts` owns that rule and its direction.
    // Nothing is decided in SQL. The licence clamp, which boats a charter takes and what a lock still
    // holds are all `dayCapacity`'s; writing any of them a second time here is how the stores drift.
    const ids = [...routeIds];
    const releasing = [...SEAT_RELEASING_STATUSES];
    const { rows: deployed } = await this.client().query(
      `SELECT d.route_id, d.service_date::text AS service_date, d.boat_id, d.capacity, d.license_pax, o.capacity AS override_capacity
       FROM deployments d
       LEFT JOIN boat_capacity_overrides o ON o.boat_id = d.boat_id AND o.service_date = d.service_date
       WHERE d.route_id = ANY($1::text[]) AND d.service_date BETWEEN $2 AND $3`, [ids, from, to]);
    const { rows: trips } = await this.client().query(
      `SELECT t.route_id, t.service_date::text AS service_date, t.booking_mode, t.charter_boat_id, SUM(p.count)::int AS pax
       FROM booking_trips t
       JOIN bookings b ON b.id = t.booking_id
       JOIN booking_trip_pax p ON p.booking_trip_id = t.id
       WHERE t.route_id = ANY($1::text[]) AND t.service_date BETWEEN $2 AND $3 AND b.status <> ALL($5::text[]) AND NOT ${WAITING_FOR_SEATS}
         AND t.booking_id IS DISTINCT FROM $4
       GROUP BY t.route_id, t.service_date, t.booking_mode, t.charter_boat_id`, [ids, from, to, exclude.bookingId ?? null, releasing]);
    // Every lock on those days that can count: the active ones, and every sub-group (a released one
    // still counts its draws against its parent). `poolLocks` picks what holds.
    const { rows: locks } = await this.client().query(
      `SELECT ${LOCK_COLUMNS},
              COALESCE((SELECT SUM(d.qty) FROM booking_trip_lock_draws d
                        JOIN booking_trips t ON t.id = d.booking_trip_id
                        JOIN bookings b ON b.id = t.booking_id
                        WHERE d.seat_lock_id = l.id AND b.status <> ALL($5::text[]) AND NOT ${WAITING_FOR_SEATS} AND t.booking_id IS DISTINCT FROM $4), 0)::int AS drawn
       FROM seat_locks l
       WHERE l.route_id = ANY($1::text[]) AND l.service_date BETWEEN $2 AND $3 AND (l.status = 'active' OR l.parent_id IS NOT NULL)`,
      [ids, from, to, exclude.bookingId ?? null, releasing]);
    const today = todayInThailand();
    const { rows: kinds } = await this.client().query('SELECT id, kind FROM routes WHERE id = ANY($1::text[])', [ids]);
    const kindOf = new Map(kinds.map((row) => [String(row.id), row.kind as RouteKind]));

    const deployedByDay = byDay(deployed), tripsByDay = byDay(trips), locksByDay = byDay(locks);
    const days: RouteDay[] = [];
    for (const date of eachDate(from, to)) {
      for (const routeId of ids) {
        const key = `${routeId} ${date}`;
        days.push({
          route_id: routeId, service_date: date,
          ...dayCapacity(
            (deployedByDay.get(key) ?? []).map((row): DayDeployment => ({ boat_id: String(row.boat_id), capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), override_capacity: optionalInt(row.override_capacity) })),
            (tripsByDay.get(key) ?? []).map((row): HeldTrip => ({ booking_mode: String(row.booking_mode), pax: Number(row.pax), charter_boat_id: row.charter_boat_id ?? undefined })),
            (() => { const rows = locksByDay.get(key) ?? []; return poolLocks(rows.map(lockRow), new Map(rows.map((row) => [String(row.id), Number(row.drawn)])), today, exclude.lockId); })(),
            kindOf.get(routeId)),
        });
      }
    }
    return days;
  }

  /**
   * Weighs every day a booking touches, so a multi-day booking is refused as a whole or not at all.
   *
   * Pools are locked before any is read, and in a fixed order: two concurrent bookings covering the
   * same days in opposite order would otherwise each hold what the other is waiting for. `vacating`
   * adds the days an amendment is leaving, which must be held too or a competitor can take the seats
   * between the check and the write. A lock lives on one route and day, so the pool lock also
   * serializes every draw on it.
   */
  private async assertTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, vacating: readonly { route_id: string; service_date: string }[] = [], agentId?: string | null): Promise<void> {
    const days = demandByDay(trips, agentId);
    const pools = new Map<string, { route_id: string; service_date: string }>();
    for (const day of [...days, ...vacating]) pools.set(`${day.route_id} ${day.service_date}`, { route_id: day.route_id, service_date: day.service_date });
    for (const key of [...pools.keys()].sort()) { const pool = pools.get(key)!; await this.lockPool(pool.route_id, pool.service_date); }
    for (const demand of days) assertDayFits(await this.day(demand.route_id, demand.service_date, exclude), demand);
  }

  async createDeployment(input: Deployment): Promise<Deployment> {
    // The licence is resolved from the catalogue on write, so the seat pool never has to reach for
    // it at read time and a deployment row always carries its own ceiling.
    const { rows: [row] } = await this.client().query(`INSERT INTO deployments (boat_id, route_id, service_date, capacity, license_pax, registered_persons)
      VALUES ($1,$2,$3,$4, COALESCE($5, (SELECT license_pax FROM boats WHERE id = $1)), $6)
      ON CONFLICT (service_date, boat_id) DO UPDATE SET route_id = EXCLUDED.route_id, capacity = EXCLUDED.capacity, license_pax = EXCLUDED.license_pax, registered_persons = EXCLUDED.registered_persons
      RETURNING boat_id, route_id, service_date::text, capacity, license_pax, registered_persons`,
      [input.boat_id, input.route_id, input.service_date, input.capacity, input.license_pax ?? null, input.registered_persons ?? input.capacity]);
    return { boat_id: String(row.boat_id), route_id: String(row.route_id), service_date: String(row.service_date), capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), registered_persons: optionalInt(row.registered_persons) };
  }
  async deleteDeployment(date: string, boat: string): Promise<boolean> { return (await this.client().query('DELETE FROM deployments WHERE service_date = $1 AND boat_id = $2', [date, boat])).rowCount === 1; }
  async listDeployments(from?: string, to?: string, routeId?: string): Promise<Deployment[]> {
    const { rows } = await this.client().query('SELECT boat_id, route_id, service_date::text, capacity, license_pax, registered_persons FROM deployments WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) AND ($3::text IS NULL OR route_id = $3) ORDER BY service_date, boat_id', [from ?? null, to ?? null, routeId ?? null]);
    return rows.map((row) => ({ ...row, capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), registered_persons: optionalInt(row.registered_persons) }));
  }

  /**
   * Moves the stored itinerary from `current` to `planned` (see `planTrips`) without deleting any
   * trip that is kept. A kept trip's row is updated in place, because rows in other tables hang off
   * its id and a delete would cascade through them. Only its pax cells and lock draws — which belong
   * to the trip and have no identity of their own — are rewritten. A kept trip that moved to another
   * route or day loses its van data, which was arranged for the old departure (`movedTripIds`).
   */
  private async writeTrips(bookingId: string, current: readonly StoredTrip[], planned: readonly StoredTrip[]): Promise<void> {
    const keep = new Set(planned.map((trip) => trip.id));
    const removed = current.filter((trip) => !keep.has(trip.id)).map((trip) => trip.id);
    if (removed.length > 0) await this.client().query('DELETE FROM booking_trips WHERE booking_id = $1 AND id = ANY($2::text[])', [bookingId, removed]);
    const moved = movedTripIds(current, planned);
    if (moved.length > 0) {
      // Legacy `bkOpsClear`: the dispatch was arranged for the old departure, so it goes; the pier note stays.
      await this.client().query('DELETE FROM booking_trip_van_allocations WHERE booking_trip_id = ANY($1::text[])', [moved]);
      await this.client().query('DELETE FROM booking_trip_checkins WHERE booking_trip_id = ANY($1::text[])', [moved]);
      await this.client().query('DELETE FROM booking_trip_boat_splits WHERE booking_trip_id = ANY($1::text[])', [moved]);
      await this.client().query(`UPDATE booking_trip_operations SET boat_id = NULL, pickup_time_final = NULL, pickup_time_final_end = NULL,
        pickup_final_at_pier = false, return_same_van = false WHERE booking_trip_id = ANY($1::text[])`, [moved]);
    }
    // A boat split no longer adds up once the trip's passengers change, so it is cleared (decided 2026-10-06).
    const repaxed = paxChangedTripIds(current, planned);
    if (repaxed.length > 0) await this.client().query('DELETE FROM booking_trip_boat_splits WHERE booking_trip_id = ANY($1::text[])', [repaxed]);
    // The van parts follow the new passengers: the main part takes the change (`rebalanceParts`).
    for (const id of repaxed) {
      const parts = await this.storedVanParts(id);
      if (parts.length) await this.setVanParts(id, rebalanceParts(parts, planned.find((t) => t.id === id)!.pax));
    }
    const existing = new Set(current.map((trip) => trip.id).filter((id) => keep.has(id)));
    // `UNIQUE (booking_id, seq)` is checked row by row, so reordering in place would collide halfway
    // through a swap. The kept rows are first moved above every position the new list uses.
    if (existing.size > 0) {
      const clear = Math.max(planned.length, ...current.map((trip) => trip.seq + 1));
      await this.client().query('UPDATE booking_trips SET seq = seq + $2 WHERE booking_id = $1', [bookingId, clear]);
    }
    for (const trip of planned) {
      const values = [trip.id, bookingId, trip.seq, trip.route_id, trip.service_date, trip.booking_mode, trip.charter_boat_id ?? null,
        trip.zone ?? null, trip.pickup_time ?? null, trip.ovn ?? null, trip.ovn_return_date ?? null, trip.ovn_leg, trip.ovn_of ?? null,
        trip.pickup_time_end ?? null, trip.pickup_at_pier === true,
        trip.ovn_charge ?? null, trip.charter_price_mode ?? null, trip.charter_price_manual ?? null, trip.charter_price_note ?? null,
        trip.subtotal ?? null, trip.rate_type_id ?? null, trip.promo_id ?? null];
      if (existing.has(trip.id)) {
        await this.client().query(`UPDATE booking_trips SET seq = $3, route_id = $4, service_date = $5, booking_mode = $6, charter_boat_id = $7,
          zone = $8, pickup_time = $9, ovn = $10, ovn_return_date = $11, ovn_leg = $12, ovn_of = $13, pickup_time_end = $14, pickup_at_pier = $15,
          ovn_charge = $16, charter_price_mode = $17, charter_price_manual = $18, charter_price_note = $19, subtotal = $20, rate_type_id = $21, promo_id = $22
          WHERE id = $1 AND booking_id = $2`, values);
        await this.client().query('DELETE FROM booking_trip_pax WHERE booking_trip_id = $1', [trip.id]);
        await this.client().query('DELETE FROM booking_trip_lock_draws WHERE booking_trip_id = $1', [trip.id]);
      } else {
        await this.client().query(`INSERT INTO booking_trips (id, booking_id, seq, route_id, service_date, booking_mode, charter_boat_id, zone, pickup_time, ovn, ovn_return_date, ovn_leg, ovn_of,
          pickup_time_end, pickup_at_pier, ovn_charge, charter_price_mode, charter_price_manual, charter_price_note, subtotal, rate_type_id, promo_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, values);
      }
      for (const cell of trip.pax) {
        await this.client().query('INSERT INTO booking_trip_pax (booking_trip_id, category, residency, count) VALUES ($1,$2,$3,$4)', [trip.id, cell.category, cell.residency, cell.count]);
      }
      for (const draw of trip.lock_draws) {
        await this.client().query('INSERT INTO booking_trip_lock_draws (booking_trip_id, seat_lock_id, qty) VALUES ($1,$2,$3)', [trip.id, draw.lock_id, draw.qty]);
      }
    }
  }

  private async writePassengers(bookingId: string, passengers: readonly BookingPassengerInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_passengers WHERE booking_id = $1', [bookingId]);
    for (const [seq, passenger] of passengers.entries()) {
      await this.client().query(`INSERT INTO booking_passengers (booking_id, seq, name, nationality, type, foc, age, insurance_reviewed_at, insurance_reviewed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [bookingId, seq, passenger.name, passenger.nationality ?? null, passenger.type ?? null, passenger.foc ?? null,
          passenger.age ?? null, passenger.insurance_reviewed_at ?? null, passenger.insurance_reviewed_by ?? null]);
    }
  }

  /** Replaces the whole list, as `writeAddOns` does. */
  private async writeUpgrades(bookingId: string, upgrades: readonly StoredUpgrade[]): Promise<void> {
    await this.client().query('DELETE FROM booking_upgrades WHERE booking_id = $1', [bookingId]);
    for (const [seq, u] of upgrades.entries()) {
      await this.client().query(`INSERT INTO booking_upgrades (booking_id, seq, id, label, sell_price, to_company, seller, note, collected, settle, method, fee_pct, fee, customer_paid, at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [bookingId, seq, u.id, u.label, u.sell_price, u.to_company, u.seller, u.note, u.collected, u.settle, u.method, u.fee_pct, u.fee, u.customer_paid, u.at]);
      for (const [slipSeq, attachmentId] of u.slips.entries()) {
        await this.client().query('INSERT INTO booking_upgrade_slips (booking_id, upgrade_id, seq, attachment_id) VALUES ($1,$2,$3,$4)', [bookingId, u.id, slipSeq, attachmentId]);
      }
    }
  }
  private async writeAllergies(bookingId: string, list: readonly Allergy[]): Promise<void> {
    await this.client().query('DELETE FROM booking_allergies WHERE booking_id = $1', [bookingId]);
    for (const [seq, a] of list.entries()) await this.client().query('INSERT INTO booking_allergies (booking_id, seq, name, qty) VALUES ($1,$2,$3,$4)', [bookingId, seq, a.name, a.qty]);
  }
  // ── Love Kingdom's held orders (migration 100, `b2c.ts`) ──
  /** Newest first (`sortHeld`, as the in-process store). `status` absent lists every one. */
  async listHeldOrders(query: { status?: HeldStatus; externalId?: string } = {}): Promise<HeldOrder[]> {
    const { rows } = await this.client().query(`SELECT * FROM b2c_held_orders WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR external_id = $2)`,
      [query.status ?? null, query.externalId ?? null]);
    return sortHeld(rows.map(heldOrderRow));
  }
  async heldOrder(id: string): Promise<HeldOrder | undefined> {
    const { rows: [row] } = await this.client().query('SELECT * FROM b2c_held_orders WHERE id = $1', [id]);
    return row && heldOrderRow(row);
  }
  /** Inserts or replaces one, whole: what to write is `holdOrder`'s and `decideHeld`'s decision. */
  async putHeldOrder(h: HeldOrder): Promise<void> {
    await this.client().query(`INSERT INTO b2c_held_orders (id, action, external_id, booking_id, request, problem, attempts, status, received_at, last_received_at,
        received_by, decided_at, decided_by, note, resolved_booking_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET request = EXCLUDED.request, problem = EXCLUDED.problem, attempts = EXCLUDED.attempts, status = EXCLUDED.status,
        last_received_at = EXCLUDED.last_received_at, received_by = EXCLUDED.received_by, decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by,
        note = EXCLUDED.note, resolved_booking_id = EXCLUDED.resolved_booking_id`,
      [h.id, h.action, h.external_id, h.booking_id, JSON.stringify(h.request ?? null), h.problem, h.attempts, h.status, h.received_at, h.last_received_at,
        h.received_by, h.decided_at, h.decided_by, h.note, h.resolved_booking_id]);
  }

  // ── Pickup areas and pickup times (migration 043) ──
  async listPickupAreas(): Promise<PickupArea[]> {
    return (await this.client().query('SELECT id, name, zone, region, time_group, active FROM pickup_areas ORDER BY id')).rows
      .map((r) => ({ id: r.id, name: r.name, zone: r.zone, region: r.region ?? null, time_group: r.time_group, active: r.active === true }));
  }
  async putPickupArea(a: PickupArea): Promise<void> {
    await this.client().query(`INSERT INTO pickup_areas (id, name, zone, region, time_group, active) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, zone = EXCLUDED.zone, region = EXCLUDED.region, time_group = EXCLUDED.time_group, active = EXCLUDED.active`,
      [a.id, a.name, a.zone, a.region, a.time_group, a.active]);
  }
  async listTimeProfiles(): Promise<TimeProfile[]> {
    return (await this.client().query('SELECT id, name, from_date::text AS from_date, to_date::text AS to_date, notes, cloned_from, created_at FROM pickup_time_profiles ORDER BY id')).rows
      .map((r) => ({ id: r.id, name: r.name, from_date: r.from_date ?? null, to_date: r.to_date ?? null, notes: r.notes ?? null, cloned_from: r.cloned_from ?? null, created_at: (r.created_at as Date).toISOString() }));
  }
  async putTimeProfile(p: TimeProfile): Promise<void> {
    await this.client().query(`INSERT INTO pickup_time_profiles (id, name, from_date, to_date, notes, cloned_from, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, from_date = EXCLUDED.from_date, to_date = EXCLUDED.to_date, notes = EXCLUDED.notes`,
      [p.id, p.name, p.from_date, p.to_date, p.notes, p.cloned_from, p.created_at]);
  }
  async deleteTimeProfile(id: string): Promise<boolean> { return (await this.client().query('DELETE FROM pickup_time_profiles WHERE id = $1', [id])).rowCount === 1; }
  async listPickupTimes(profileId?: string): Promise<PickupCell[]> {
    const { rows } = await this.client().query('SELECT * FROM pickup_times WHERE $1::text IS NULL OR profile_id = $1 ORDER BY profile_id, route_id, target', [profileId ?? null]);
    return rows.map((r) => ({ profile_id: r.profile_id, route_id: r.route_id, target: r.target,
      ...(r.pickup_time ? { pickup_time: r.pickup_time } : {}), ...(r.pickup_time_end ? { pickup_time_end: r.pickup_time_end } : {}), ...(r.pickup_at_pier ? { pickup_at_pier: true } : {}) }));
  }
  async putPickupTime(c: PickupCell): Promise<void> {
    await this.client().query(`INSERT INTO pickup_times (profile_id, route_id, target, pickup_time, pickup_time_end, pickup_at_pier) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (profile_id, route_id, target) DO UPDATE SET pickup_time = EXCLUDED.pickup_time, pickup_time_end = EXCLUDED.pickup_time_end, pickup_at_pier = EXCLUDED.pickup_at_pier`,
      [c.profile_id, c.route_id, c.target, c.pickup_time ?? null, c.pickup_time_end ?? null, c.pickup_at_pier === true]);
  }
  async deletePickupTime(profileId: string, routeId: string, target: string): Promise<boolean> {
    return (await this.client().query('DELETE FROM pickup_times WHERE profile_id = $1 AND route_id = $2 AND target = $3', [profileId, routeId, target])).rowCount === 1;
  }

  /** Writes a booking's document check whole, its pre-check results included. */
  async setDocCheck(bookingId: string, d: DocCheck): Promise<void> {
    await this.client().query(`INSERT INTO booking_doc_checks (booking_id, status, by, at, note, route_ok, date_ok, lead_ok, pax_ok, voucher_ok, payment_ok, pre_at, pre_lang, pre_error, pre_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (booking_id) DO UPDATE SET status = EXCLUDED.status, by = EXCLUDED.by, at = EXCLUDED.at, note = EXCLUDED.note, route_ok = EXCLUDED.route_ok,
        date_ok = EXCLUDED.date_ok, lead_ok = EXCLUDED.lead_ok, pax_ok = EXCLUDED.pax_ok, voucher_ok = EXCLUDED.voucher_ok, payment_ok = EXCLUDED.payment_ok,
        pre_at = EXCLUDED.pre_at, pre_lang = EXCLUDED.pre_lang, pre_error = EXCLUDED.pre_error, pre_text = EXCLUDED.pre_text`,
      [bookingId, d.status, d.by, d.at, d.note, d.items.route, d.items.date, d.items.lead, d.items.pax, d.items.voucher, d.items.payment,
        d.pre?.at ?? null, d.pre?.lang ?? null, d.pre?.error ?? null, d.pre?.text ?? null]);
    await this.client().query('DELETE FROM booking_doc_check_results WHERE booking_id = $1', [bookingId]);
    for (const [item, r] of Object.entries(d.pre?.results ?? {})) {
      await this.client().query('INSERT INTO booking_doc_check_results (booking_id, item, result, evidence, detail) VALUES ($1,$2,$3,$4,$5)', [bookingId, item, r.result, r.evidence, r.detail]);
    }
  }
  /** The pier's meal editor: who changed the meals there, and when (migration 041). */
  async stampPierMeals(id: string, at: string, by: string | null): Promise<void> {
    await this.client().query('UPDATE bookings SET special_meals_pier_at = $2, special_meals_pier_by = $3 WHERE id = $1', [id, at, by]);
  }
  private async writeDocuments(bookingId: string, rows: readonly DocumentRow[]): Promise<void> {
    await this.client().query('DELETE FROM booking_documents WHERE booking_id = $1', [bookingId]);
    for (const [seq, d] of rows.entries()) {
      await this.client().query('INSERT INTO booking_documents (booking_id, seq, attachment_id, kind, by, at) VALUES ($1,$2,$3,$4,$5,$6)', [bookingId, seq, d.attachment_id, d.kind, d.by, d.at]);
    }
  }
  private async writeAltPickups(bookingId: string, alts: readonly AltPickup[]): Promise<void> {
    await this.client().query('DELETE FROM booking_alt_pickups WHERE booking_id = $1', [bookingId]);
    for (const [seq, a] of alts.entries()) {
      await this.client().query(`INSERT INTO booking_alt_pickups (booking_id, seq, who, ad, chd, inf, foc, area_id, area, zone, place, drop_same, drop_area_id, drop_area, drop_zone, drop_place)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [bookingId, seq, a.who, a.ad, a.chd, a.inf, a.foc, a.area_id, a.area, a.zone, a.place, a.drop_same, a.drop_area_id, a.drop_area, a.drop_zone, a.drop_place]);
    }
  }
  private async writeAdjustments(bookingId: string, adjustments: readonly BookingAdjustmentInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_adjustments WHERE booking_id = $1', [bookingId]);
    for (const [seq, a] of adjustments.entries()) {
      await this.client().query('INSERT INTO booking_adjustments (booking_id, seq, kind, mode, value, label, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [bookingId, seq, a.kind, a.mode, a.value, a.label ?? null, a.note ?? null]);
    }
  }

  /** Replaces the whole list, the same delete-and-insert `writePassengers` does. */
  private async writeAddOns(bookingId: string, addOns: readonly BookingAddOnInput[]): Promise<void> {
    await this.client().query('DELETE FROM booking_addons WHERE booking_id = $1', [bookingId]);
    for (const [seq, addOn] of addOns.entries()) {
      await this.client().query(
        'INSERT INTO booking_addons (booking_id, seq, type, label, amount, qty, note, join_adults, join_children) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [bookingId, seq, addOn.type, addOn.label ?? null, addOn.amount ?? null, addOn.qty ?? null, addOn.note ?? null, addOn.join_adults ?? null, addOn.join_children ?? null]);
    }
  }

  /** Answers 400 before `booking_trips_route_fk` or the lock draw's foreign key can answer 500. */
  /**
   * `assertTrips`, but over the allotment is an answer rather than a refusal: the days the trips put
   * over it (`weighDay`). The same pool locks, in the same order, so the answer cannot go stale before
   * the write.
   */
  private async weighTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, vacating: readonly { route_id: string; service_date: string }[] = [], agentId?: string | null): Promise<ApprovalDay[]> {
    const days = demandByDay(trips, agentId);
    const pools = new Map<string, { route_id: string; service_date: string }>();
    for (const day of [...days, ...vacating]) pools.set(`${day.route_id} ${day.service_date}`, { route_id: day.route_id, service_date: day.service_date });
    for (const key of [...pools.keys()].sort()) { const pool = pools.get(key)!; await this.lockPool(pool.route_id, pool.service_date); }
    const over: ApprovalDay[] = [];
    for (const demand of days) {
      const weight = weighDay(await this.day(demand.route_id, demand.service_date, exclude), demand);
      if (weight) over.push({ route_id: demand.route_id, service_date: demand.service_date, ...weight });
    }
    return over;
  }

  /** One approval waits per kind: a new request replaces a pending one of its kind. */
  private async requestApprovals(bookingId: string, requests: readonly NewApproval[]): Promise<void> {
    for (const request of requests) {
      await this.replacePending(bookingId, request.kind);
      const { rows: [row] } = await this.client().query(
        `INSERT INTO booking_approvals (booking_id, kind, status, over_capacity, over_total, discount, foc_count, target_status, requested_by, reason)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [bookingId, request.kind, request.over_capacity, request.over_total, request.discount, request.foc_count, request.target_status, request.requested_by, request.reason]);
      for (const day of request.days) {
        await this.client().query('INSERT INTO booking_approval_days (approval_id, route_id, service_date, need, over_by, licensed_free) VALUES ($1,$2,$3,$4,$5,$6)',
          [row.id, day.route_id, day.service_date, day.need, day.over_by, day.licensed_free]);
      }
    }
  }
  private async replacePending(bookingId: string, kind: ApprovalKind): Promise<void> {
    await this.client().query("UPDATE booking_approvals SET status = 'replaced' WHERE booking_id = $1 AND kind = $2 AND status = 'pending'", [bookingId, kind]);
  }

  /** `assertRoutesOpen` against the calendar of the routes and days in question, read alone. */
  private async assertOpen(trips: readonly RouteDate[]): Promise<void> {
    if (trips.length === 0) return;
    const ids = [...new Set(trips.map((trip) => trip.route_id))];
    const dates = [...new Set(trips.map((trip) => trip.service_date))];
    const { rows: seasons } = await this.client().query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons WHERE route_id = ANY($1::text[])', [ids]);
    const { rows: overrides } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE route_id = ANY($1::text[]) AND service_date = ANY($2::date[])', [ids, dates]);
    const { rows: names } = await this.client().query('SELECT id, name FROM routes WHERE id = ANY($1::text[])', [ids]);
    assertRoutesOpen(
      routeCalendar(seasons.map(season), overrides.map(dayOverride)),
      trips, new Map(names.map((row) => [String(row.id), String(row.name)])));
  }

  private async assertRoutes(trips: readonly BookingTripInput[]): Promise<void> {
    const ids = [...new Set(trips.map((trip) => trip.route_id))];
    const { rows } = await this.client().query('SELECT id FROM routes WHERE id = ANY($1::text[])', [ids]);
    assertKnownRoutes(new Set(rows.map((row) => String(row.id))), trips);
    const { rows: locks } = await this.client().query('SELECT id FROM seat_locks WHERE id = ANY($1::text[])', [drawnLockIds(trips)]);
    assertKnownLocks(new Set(locks.map((row) => String(row.id))), trips);
  }

  /** Appends one history line inside the transaction of the write it describes. */
  private async log(bookingId: string, entry: HistoryLine): Promise<void> {
    await this.client().query('INSERT INTO booking_history (booking_id, by, kind, tag, text) VALUES ($1,$2,$3,$4,$5)', [bookingId, entry.by, entry.kind, entry.tag, entry.text]);
  }
  /** Oldest first; the serial id orders lines written in one transaction, which share `now()`. */
  async bookingHistory(id: string): Promise<HistoryEntry[] | undefined> {
    const { rows: [known] } = await this.client().query('SELECT 1 FROM bookings WHERE id = $1', [id]);
    if (!known) return undefined;
    const { rows } = await this.client().query('SELECT at, by, kind, tag, text FROM booking_history WHERE booking_id = $1 ORDER BY at, id', [id]);
    return rows.map((row) => ({ at: asIso(row.at), by: textOrNull(row.by), kind: String(row.kind), tag: textOrNull(row.tag), text: String(row.text) }));
  }
  /**
   * What `priceBooking` priced each trip and add-on at, written beside them by position, in the
   * create's or amendment's own transaction. The trips themselves are left alone.
   */
  async setPrices(id: string, prices: BookingPrices): Promise<void> {
    for (const [seq, p] of prices.trips.entries()) {
      await this.client().query('UPDATE booking_trips SET subtotal = $3, rate_type_id = $4, promo_id = $5 WHERE booking_id = $1 AND seq = $2',
        [id, seq, p.subtotal, p.rate_type_id, p.promo_id]);
    }
    for (const [seq, amount] of prices.add_ons.entries()) {
      await this.client().query('UPDATE booking_addons SET amount = $3 WHERE booking_id = $1 AND seq = $2', [id, seq, amount]);
    }
  }

  /** Every action's write is signed by the token's user; without one (auth off) the column is left alone. */
  private async touch(id: string, actor: string | undefined, extra = '', values: unknown[] = []): Promise<void> {
    await this.client().query(`UPDATE bookings SET updated_at = now(), version = version + 1, updated_by = COALESCE($2, updated_by)${extra} WHERE id = $1`, [id, actor ?? null, ...values]);
  }

  async createBooking(input: BookingInput, actor?: string): Promise<Booking> {
    if (input.external_id !== undefined) {
      const { rows: [taken] } = await this.client().query('SELECT id FROM bookings WHERE external_id = $1', [input.external_id]);
      if (taken) externalIdTaken(input.external_id, String(taken.id));
    }
    const planned = planTrips([], input.trips, newTripId);
    await this.assertRoutes(input.trips);
    await this.assertOpen(tripsToCheckOpen(input.external_id, [], planned));
    // Weighed first, then decided: the days over the allotment are a fact the status depends on.
    const decision = decideStatus(input.intent ?? 'confirm', {
      focCount: focCountOf(input.trips), focReason: input.header?.foc_reason, discount: discountOf(input.header ?? {}),
      overDays: await this.weighTrips(input.trips, {}, [], input.agent_id),
    }, actor);
    const status = decision.status;
    const head: BookingHeader = { ...input.header, ...(status === 'confirmed' ? confirmationStamp(actor, new Date().toISOString()) : {}) };
    const id = `booking_${randomUUID()}`;
    // Only the header columns the caller actually supplied are written, so a NULL keeps meaning
    // "never given" rather than "explicitly blanked". The column list is generated rather than
    // typed out: a statement maintained by hand is one that silently stops writing a new field.
    const columns = ['id', 'status', 'external_id', 'agent_id', 'voucher_ref', 'rate_type_ref', 'booking_mode'];
    const values: unknown[] = [id, status, input.external_id ?? null, input.agent_id ?? null, input.voucher_ref ?? null, input.rate_type_ref ?? null, input.trips[0]?.booking_mode ?? null];
    for (const column of BOOKING_HEADER_COLUMNS) {
      const value = head[column];
      if (value === undefined) continue;
      columns.push(column);
      values.push(value);
    }
    const placeholders = values.map((_, index) => `$${index + 1}`);
    // The blob is still written beside the columns: this is the dual-write step, not the drop.
    columns.push('booking_data');
    values.push(JSON.stringify(input.booking_data ?? {}));
    placeholders.push(`$${values.length}::jsonb`);
    try {
      await this.client().query(`INSERT INTO bookings (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
    } catch (error) {
      // A concurrent create with the same external_id committed after the check above.
      const e = error as Error & { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'bookings_external_id_unique') externalIdTaken(input.external_id!);
      throw error;
    }
    await this.writeTrips(id, [], planned);
    await this.writePassengers(id, input.passengers ?? []);
    await this.writeAddOns(id, input.add_ons ?? []);
    await this.writeAdjustments(id, input.adjustments ?? []);
    await this.writeAltPickups(id, input.alt_pickups ?? []);
    await this.writeDocuments(id, input.attachments ?? []);
    await this.writeAllergies(id, input.allergy_list ?? []);
    const sold = storedUpgrades(input.upgrades ?? [], [], new Date().toISOString(), actor ?? null);
    await this.writeUpgrades(id, sold.upgrades);
    await this.requestApprovals(id, decision.approvals);
    await this.log(id, createdLine(actor));
    for (const line of decision.history) await this.log(id, line);
    for (const line of sold.history) await this.log(id, line);
    return (await this.booking(id))!;
  }

  async listBookings(query: BookingListQuery) {
    const cursor = query.cursor ? decodeBookingCursor(query.cursor) : undefined;
    // The direction is one of two fixed strings, never caller text, so it is safe to splice in.
    const [after, order] = query.order === 'desc' ? ['<', 'DESC'] : ['>', 'ASC'];
    // One WHERE for the page and the count, so `total` counts exactly what paging walks through.
    // `q` and `voucherRef` arrive lower-cased; `position` is a plain substring test, so a `%` or `_`
    // in the search text means itself, as it does to the in-process store's `includes`.
    const filters = `EXISTS (SELECT 1 FROM booking_trips t
        WHERE t.booking_id = b.id
          AND ($1::text IS NULL OR t.route_id = $1)
          AND ($2::date IS NULL OR t.service_date = $2)
          AND ($3::date IS NULL OR t.service_date >= $3)
          AND ($4::date IS NULL OR t.service_date <= $4))
        AND ($5::text IS NULL OR b.agent_id = $5)
        AND ($6::text[] IS NULL OR b.status = ANY($6))
        AND ($7::text IS NULL OR lower(b.voucher_ref) = $7)
        AND ($8::text IS NULL OR position($8 IN lower(b.id)) > 0 OR position($8 IN lower(COALESCE(b.voucher_ref, ''))) > 0 OR position($8 IN lower(COALESCE(b.lead_pax, ''))) > 0)
        AND ($9::timestamptz IS NULL OR b.updated_at >= $9)`;
    const params = [query.routeId ?? null, query.serviceDate ?? null, query.from ?? null, query.to ?? null, query.agentId ?? null, query.statuses ?? null, query.voucherRef ?? null, query.q ?? null, query.updatedSince ?? null];
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      this.client().query(`${BOOKING_SELECT}
      WHERE ${filters}
        AND ($10::timestamptz IS NULL OR (b.created_at, b.id) ${after} ($10::timestamptz, $11::text))
      ORDER BY b.created_at ${order}, b.id ${order}
      LIMIT $12`, [...params, cursor?.created_at ?? null, cursor?.id ?? null, query.limit + 1]),
      this.client().query(`SELECT count(*)::int AS total FROM bookings b WHERE ${filters}`, params),
    ]);
    const page = rows.slice(0, query.limit);
    return { bookings: page.map(booking), ...(rows.length > query.limit ? { next_cursor: encodeBookingCursor({ created_at: asIso(page[page.length - 1].created_at), id: String(page[page.length - 1].id) }) } : {}), total: Number(total) };
  }
  async booking(id: string): Promise<Booking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && booking(row); }
  private async storedBooking(id: string): Promise<StoredBooking | undefined> { const { rows: [row] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [id]); return row && stored(row); }

  /** `entry` replaces the default `Edited · …` line, for the older reschedule body that comes through here. */
  async amendBooking(id: string, requested: BookingChanges, actor?: string, entry?: HistoryLine): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    assertEditable(current.status);
    const changes = stripServerOwned(requested, current as unknown as Record<string, unknown> & { status: Booking['status'] });
    const replacement = nextTrips(current.trips, changes);
    const planned = planTrips(current.trips, replacement, newTripId);
    await this.assertRoutes(replacement);
    await this.assertOpen(tripsToCheckOpen(current.external_id, current.trips, planned));
    const reweighed = reweighs(current, changes, claimsMoreSeats(current.trips, planned))
      ? reweigh(current, await this.weighTrips(replacement, { bookingId: id }, current.trips, current.agent_id), actor) : undefined;
    const status = reweighed?.status ?? current.status;
    await this.log(id, entry ?? editedLine(actor, changes, current.status));
    await this.writeTrips(id, current.trips, planned);
    // Only the columns the amendment mentions are in the SET list, so an unmentioned one keeps its
    // value; a mentioned one carrying null is set to NULL. Built from BOOKING_HEADER_COLUMNS for
    // the same reason the INSERT is — a statement typed out by hand stops writing new fields.
    const assignments = ['booking_mode = $2', 'status = $3', 'updated_at = now()', 'version = version + 1'];
    const values: unknown[] = [id, replacement[0]?.booking_mode ?? null, status];
    if (status === 'confirmed' && reweighed && !current.confirmed_at) { values.push(actor ?? null); assignments.push(`confirmed_at = now(), confirmed_by = ${values.length}`); }
    for (const column of BOOKING_HEADER_COLUMNS) {
      const value = changes.header?.[column];
      if (value === undefined) continue;
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }
    await this.client().query(`UPDATE bookings SET ${assignments.join(', ')} WHERE id = $1`, values);
    // `booking_data` is deliberately left as it was written at create time. The blob is on its way
    // out, and re-serialising an amendment into it would grow the thing being deleted.
    if (changes.passengers) await this.writePassengers(id, carryInsurance(current.passengers, changes.passengers));
    if (changes.add_ons) await this.writeAddOns(id, changes.add_ons);
    if (changes.adjustments) await this.writeAdjustments(id, changes.adjustments);
    if (changes.alt_pickups) await this.writeAltPickups(id, changes.alt_pickups);
    if (changes.attachments) await this.writeDocuments(id, changes.attachments);
    if (changes.allergy_list) await this.writeAllergies(id, changes.allergy_list);
    if (changes.upgrades) {
      const sold = storedUpgrades(changes.upgrades, current.upgrades, new Date().toISOString(), actor ?? null);
      await this.writeUpgrades(id, sold.upgrades);
      for (const line of sold.history) await this.log(id, line);
    }
    if (reweighed?.request) await this.requestApprovals(id, [reweighed.request]);
    else if (reweighed) await this.replacePending(id, 'approval');
    for (const line of reweighed?.history ?? []) await this.log(id, line);
    return this.booking(id);
  }

  async cancelBooking(id: string, request: CancelRequest, actor?: string): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    const plan = planCancel(current, request, actor);
    await this.touch(id, actor, ", status = 'cancelled', cancellation_reason = $3", [plan.cancellation_reason]);
    if (plan.record) {
      const r = plan.record;
      await this.client().query(`INSERT INTO booking_cancellations (booking_id, category, grp, note, charge_type, charge_amount, by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (booking_id) DO UPDATE SET category = EXCLUDED.category, grp = EXCLUDED.grp, note = EXCLUDED.note, charge_type = EXCLUDED.charge_type,
          charge_amount = EXCLUDED.charge_amount, at = now(), by = EXCLUDED.by`, [id, r.category, r.group, r.note, r.charge_type, r.charge_amount, r.by]);
    } else {
      await this.client().query('DELETE FROM booking_cancellations WHERE booking_id = $1', [id]);
    }
    await this.log(id, plan.history);
    return this.booking(id);
  }

  /**
   * `/confirm`, `/approve`, `/reject`, `/cancel-weather`. The rules are `planStatusCommand`'s. Approving
   * an over-allotment booking gives it seats even past the licence, with warnings (`licenceWarnings`).
   */
  async changeBookingStatus(
    id: string, command: StatusCommand, request: StatusCommandRequest, actor?: string,
  ): Promise<{ booking: Booking; warnings: ApprovalWarning[] } | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    const plan = planStatusCommand(command, current, request, actor);
    let warnings: ApprovalWarning[] = [];
    if (plan.claims) {
      const days = new Map<string, DayState>();
      for (const trip of current.trips) {
        const key = dayKey(trip.route_id, trip.service_date);
        if (!days.has(key)) days.set(key, await this.day(trip.route_id, trip.service_date, { bookingId: id }));
      }
      warnings = licenceWarnings(current.trips, (routeId, date) => days.get(dayKey(routeId, date))!);
    }
    if (plan.decide) {
      const { rowCount } = await this.client().query(
        "UPDATE booking_approvals SET status = $3, decided_by = $4, decided_at = now(), note = $5 WHERE booking_id = $1 AND kind = $2 AND status = 'pending'",
        [id, plan.decide.kind, plan.decide.status, actor ?? null, plan.decide.note]);
      if (rowCount === 0) {
        const record = decidedRecord(plan.decide.kind, plan.decide.status, plan.status, focCountOf(current.trips), actor, '', plan.decide.note);
        await this.client().query(
          `INSERT INTO booking_approvals (booking_id, kind, status, over_capacity, foc_count, target_status, decided_by, decided_at, note)
           VALUES ($1,$2,$3,false,$4,$5,$6,now(),$7)`,
          [id, record.kind, record.status, record.foc_count, record.target_status, record.decided_by, record.note]);
      }
    }
    await this.requestApprovals(id, plan.request);
    // `touch` binds $1 (id) and $2 (actor); these extra assignments follow from $3.
    const values: unknown[] = [plan.status];
    const sets = [', status = $3'];
    if (plan.confirms) { values.push(actor ?? null); sets.push(`, confirmed_at = now(), confirmed_by = $${values.length + 2}`); }
    if (plan.cancellation_reason !== undefined) { values.push(plan.cancellation_reason); sets.push(`, cancellation_reason = $${values.length + 2}`); }
    await this.touch(id, actor, sets.join(''), values);
    for (const line of plan.history) await this.log(id, line);
    return { booking: (await this.booking(id))!, warnings };
  }

  /**
   * Back to `confirmed`, lock seats redrawn as far as the locks allow (`restoreTrips`). The pools are
   * locked before the days are read, so the lock remainders it decides on cannot move underneath it.
   */
  async restoreBooking(id: string, actor?: string): Promise<{ booking: Booking; warnings: LockShortWarning[] } | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    assertRestorable(current.status);
    const days = new Map<string, DayState>();
    const pools = [...new Map(current.trips.map((trip) => [dayKey(trip.route_id, trip.service_date), trip])).entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [key, trip] of pools) {
      await this.lockPool(trip.route_id, trip.service_date);
      days.set(key, await this.day(trip.route_id, trip.service_date, { bookingId: id }));
    }
    const { trips, warnings } = restoreTrips(current.trips, days);
    await this.assertOpen(current.trips);
    await this.assertTrips(trips, { bookingId: id }, [], current.agent_id);
    await this.writeTrips(id, current.trips, planTrips(current.trips, trips, newTripId));
    await this.touch(id, actor, ", status = 'confirmed', cancellation_reason = NULL");
    await this.client().query('DELETE FROM booking_cancellations WHERE booking_id = $1', [id]);
    await this.log(id, restoredLine(actor, warnings));
    return { booking: (await this.booking(id))!, warnings };
  }

  async partialCancel(id: string, request: PartialCancelRequest, actor?: string): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    if (request.kind === 'count') {
      await this.writeTrips(id, current.trips, planTrips(current.trips, partialCancelTrips(current.trips, current.status, request.count), newTripId));
      await this.touch(id, actor);
      await this.log(id, partialCountLine(actor, request.count));
      return this.booking(id);
    }
    assertOpen(current.status, 'partial cancel');
    // Seats only go down here, so there is no capacity check — see `claimsMoreSeats`.
    const { trips, trip, count } = partialCancelByKey(current.trips, request);
    const record = partialCancelRecord(trip, request, count, actor);
    await this.writeTrips(id, current.trips, planTrips(current.trips, trips, newTripId));
    await this.touch(id, actor, ', total = $3', [totalAfterRefund(current.total, request.waived) ?? null]);
    await this.client().query(`INSERT INTO booking_partial_cancels (booking_id, booking_trip_id, service_date, pax_removed, count, category, grp, note,
        charged_count, charged_amount, waived_count, waived_amount, by) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, record.trip_id, record.service_date, JSON.stringify(record.pax_removed), record.count, record.category, record.group, record.note,
        record.charged.count, record.charged.amount, record.waived.count, record.waived.amount, record.by]);
    await this.log(id, partialCancelLine(actor, record));
    return this.booking(id);
  }

  async rescheduleBooking(id: string, request: RescheduleRequest, actor?: string): Promise<Booking | undefined> {
    const current = await this.storedBooking(id); if (!current) return undefined;
    if (request.kind === 'move') {
      const from = current.trips[0]?.service_date ?? '';
      return this.amendBooking(id, { route_id: request.route_id, service_date: request.service_date, ...(request.pax === undefined ? {} : { pax: request.pax }) }, actor, movedLine(actor, from, request.service_date));
    }
    assertOpen(current.status, 'reschedule');
    const { trips, locksReturned } = rescheduleTrips(current.trips, request.from_date, request.to_date);
    const planned = planTrips(current.trips, trips, newTripId);
    await this.assertRoutes(trips);
    await this.assertOpen(tripsToCheckOpen(undefined, current.trips, planned));
    if (claimsMoreSeats(current.trips, planned)) await this.assertTrips(trips, { bookingId: id }, current.trips, current.agent_id);
    await this.writeTrips(id, current.trips, planned);
    const plan = planRescheduleRecord(current, request, actor, locksReturned);
    const r = plan.record;
    await this.client().query(`INSERT INTO booking_reschedules (booking_id, from_date, to_date, reason, charge_type, charge_amount, collect, by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, r.from_date, r.to_date, r.reason, r.charge_type, r.charge_amount, r.collect, r.by]);
    if (plan.fee_item) {
      await this.client().query('INSERT INTO booking_fee_items (booking_id, type, label, amount) VALUES ($1,$2,$3,$4)', [id, plan.fee_item.type, plan.fee_item.label, plan.fee_item.amount]);
    }
    await this.touch(id, actor);
    await this.log(id, plan.history);
    return this.booking(id);
  }

  // ── Seat locks: the I/O `SeatLockService` needs (seat-lock-service.ts). The rules are not here. ──
  /** The route-day's advisory lock, which every draw on that day also takes. */
  async holdPool(routeId: string, date: string): Promise<void> { await this.lockPool(routeId, date); }
  async lockRows(q: LockQuery): Promise<LockRow[]> {
    const { rows } = await this.client().query(`SELECT ${LOCK_COLUMNS} FROM seat_locks
      WHERE ($1::text[] IS NULL OR id = ANY($1)) AND ($2::text IS NULL OR route_id = $2) AND ($3::date IS NULL OR service_date = $3)
        AND ($4::date IS NULL OR service_date >= $4) AND ($5::date IS NULL OR service_date <= $5) AND ($6::text IS NULL OR group_id = $6)
        AND ($7::text[] IS NULL OR parent_id = ANY($7)) AND ($8::text IS NULL OR agent_id = $8)
      ORDER BY created_at, id`,
    [q.ids ? [...q.ids] : null, q.routeId ?? null, q.serviceDate ?? null, q.from ?? null, q.to ?? null, q.groupId ?? null, q.parentIds ? [...q.parentIds] : null, q.agentId ?? null]);
    return rows.map(lockRow);
  }
  async lockDrawn(ids: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await this.client().query(`SELECT d.seat_lock_id, SUM(d.qty)::int AS drawn FROM booking_trip_lock_draws d
      JOIN booking_trips t ON t.id = d.booking_trip_id JOIN bookings b ON b.id = t.booking_id
      WHERE d.seat_lock_id = ANY($1::text[]) AND b.status <> ALL($2::text[]) AND NOT ${WAITING_FOR_SEATS}
      GROUP BY d.seat_lock_id`, [[...ids], [...SEAT_RELEASING_STATUSES]]);
    const drawn = new Map(ids.map((id) => [id, 0]));
    for (const row of rows) drawn.set(String(row.seat_lock_id), Number(row.drawn));
    return drawn;
  }
  async putLock(r: LockRow): Promise<void> {
    await this.client().query(`INSERT INTO seat_locks (id, version, route_id, service_date, pax, pending_pax, released_pax, holder_type, agent_id, status, expiry,
        reason, group_id, parent_id, sub_name, boat_id, created_at, created_by, updated_at, released_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, route_id = EXCLUDED.route_id, service_date = EXCLUDED.service_date, pax = EXCLUDED.pax,
        pending_pax = EXCLUDED.pending_pax, released_pax = EXCLUDED.released_pax, holder_type = EXCLUDED.holder_type, agent_id = EXCLUDED.agent_id,
        status = EXCLUDED.status, expiry = EXCLUDED.expiry, reason = EXCLUDED.reason, group_id = EXCLUDED.group_id, parent_id = EXCLUDED.parent_id,
        sub_name = EXCLUDED.sub_name, boat_id = EXCLUDED.boat_id, updated_at = EXCLUDED.updated_at, released_at = EXCLUDED.released_at`,
    [r.id, r.version, r.route_id, r.service_date, r.pax, r.pending_pax, r.released_pax, r.holder_type, r.agent_id, r.status, r.expiry,
      r.reason, r.group_id, r.parent_id, r.sub_name, r.boat_id, r.created_at, r.created_by, r.updated_at, r.released_at]);
  }
  async lockGroupRows(q: { ids?: readonly string[]; routeId?: string; agentId?: string }): Promise<GroupRow[]> {
    const { rows } = await this.client().query(`SELECT ${GROUP_COLUMNS} FROM seat_lock_groups
      WHERE ($1::text[] IS NULL OR id = ANY($1)) AND ($2::text IS NULL OR route_id = $2) AND ($3::text IS NULL OR agent_id = $3) ORDER BY created_at, id`,
    [q.ids ? [...q.ids] : null, q.routeId ?? null, q.agentId ?? null]);
    return rows.map(groupRow);
  }
  async putLockGroup(g: GroupRow): Promise<void> {
    await this.client().query(`INSERT INTO seat_lock_groups (id, version, route_id, holder_type, agent_id, date_from, date_to, weekdays, pax,
        release_days_before, release_time, reason, created_at, created_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::smallint[],$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, holder_type = EXCLUDED.holder_type, agent_id = EXCLUDED.agent_id, pax = EXCLUDED.pax,
        release_days_before = EXCLUDED.release_days_before, release_time = EXCLUDED.release_time, reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`,
    [g.id, g.version, g.route_id, g.holder_type, g.agent_id, g.date_from, g.date_to, g.weekdays, g.pax,
      g.release_days_before, g.release_time, g.reason, g.created_at, g.created_by, g.updated_at]);
  }
  async addLockEvents(events: readonly NewLockEvent[]): Promise<void> {
    if (events.length === 0) return;
    // In the order given: the serial id is the log's order.
    await this.client().query(`INSERT INTO seat_lock_events (lock_id, group_id, type, qty, trip_date, booking_id, note, day, at, by)
      SELECT e.lock_id, e.group_id, e.type, e.qty, e.trip_date, e.booking_id, e.note, e.day, e.at, e.by
      FROM jsonb_populate_recordset(NULL::seat_lock_events, $1::jsonb) WITH ORDINALITY AS e ORDER BY e.ordinality`, [JSON.stringify(events)]);
  }
  async lockEvents(q: { lockId?: string; groupId?: string }): Promise<LockEvent[]> {
    const { rows } = await this.client().query(`SELECT id, lock_id, group_id, type, qty, trip_date::text AS trip_date, booking_id, note, day::text AS day, at, by, imported
      FROM seat_lock_events WHERE ($1::text IS NULL OR lock_id = $1) AND ($2::text IS NULL OR group_id = $2) ORDER BY id`, [q.lockId ?? null, q.groupId ?? null]);
    return rows.map(lockEvent);
  }
  async allotment(routeId: string, date: string, exclude: Exclusion = {}): Promise<Capacity & { route_id: string; service_date: string; deployments: Deployment[] }> { return { route_id: routeId, service_date: date, ...(await this.capacity(routeId,date,exclude)), deployments: await this.listDeployments(date,date,routeId) }; }

  /**
   * One edit to a route's calendar: the rules are `applyCalendarChange` and `assertCloseAllowed`, and
   * this gathers the rows and writes the result. The route's row is locked first, so two edits to
   * one route cannot both judge the calendar as it was before the other.
   */
  async changeCalendar(routeId: string, change: CalendarChange, closeAnyway: boolean, today: string): Promise<void> {
    const { rows: [route] } = await this.client().query('SELECT id FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
    if (!route) refuse('Route not found', 404);
    const { rows: seasons } = await this.client().query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons WHERE route_id = $1', [routeId]);
    const { rows: overrides } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE route_id = $1', [routeId]);
    const current = { seasons: seasons.map(season), overrides: overrides.map(dayOverride) };
    const next = applyCalendarChange(current.seasons, current.overrides, change);
    const { rows: trips } = await this.client().query(
      `SELECT DISTINCT t.service_date::text AS service_date, COALESCE(b.voucher_ref, b.id) AS booking_ref
       FROM booking_trips t JOIN bookings b ON b.id = t.booking_id
       WHERE t.route_id = $1 AND t.service_date >= $2 AND b.status <> ALL($3::text[])`, [routeId, today, [...SEAT_RELEASING_STATUSES]]);
    const { rows: boats } = await this.client().query('SELECT service_date::text AS service_date, boat_id FROM deployments WHERE route_id = $1 AND service_date >= $2', [routeId, today]);
    const holds: CalendarHold[] = [
      ...trips.map((row) => ({ service_date: String(row.service_date), booking_ref: String(row.booking_ref) })),
      ...boats.map((row) => ({ service_date: String(row.service_date), boat_id: String(row.boat_id) })),
    ];
    assertCloseAllowed(routeId, routeCalendar(current.seasons, current.overrides), routeCalendar(next.seasons, next.overrides), holds, closeAnyway);
    switch (change.op) {
      case 'add-season': {
        const s = change.season;
        await this.client().query('INSERT INTO route_seasons (id, route_id, kind, from_date, to_date) VALUES ($1,$2,$3,$4,$5)', [s.id, routeId, s.kind, s.from_date, s.to_date]);
        break;
      }
      case 'delete-season': await this.client().query('DELETE FROM route_seasons WHERE id = $1 AND route_id = $2', [change.season_id, routeId]); break;
      case 'set-day':
        await this.client().query(`INSERT INTO route_day_overrides (route_id, service_date, kind) VALUES ($1,$2,$3)
          ON CONFLICT (route_id, service_date) DO UPDATE SET kind = EXCLUDED.kind`, [routeId, change.override.service_date, change.override.kind]);
        break;
      case 'clear-day': await this.client().query('DELETE FROM route_day_overrides WHERE route_id = $1 AND service_date = $2', [routeId, change.service_date]); break;
    }
  }
  newSeasonId(): string { return `season_${randomUUID()}`; }

  /** Reference data. Dates are cast in SQL so the driver never hands back a Date to re-render. */
  async listRoutes(): Promise<Route[]> {
    const { rows } = await this.client().query(`SELECT r.id, r.name, r.kind, r.ext_id, r.pier, r.family_id, r.color, r.islands, r.sort,
      COALESCE((SELECT array_agg(t.departs_at ORDER BY t.idx) FROM route_times t WHERE t.route_id = r.id), '{}') AS times
      FROM routes r ORDER BY r.sort NULLS LAST, r.id`);
    return rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: row.kind, ext_id: row.ext_id ?? undefined, pier: row.pier ?? undefined, family_id: row.family_id ?? undefined, color: row.color ?? undefined, islands: row.islands ?? undefined, sort: row.sort === null ? undefined : Number(row.sort), times: row.times ?? [] }));
  }
  /**
   * The boat catalogue. `license_pax` stays undefined for a boat with no licence on file rather
   * than borrowing `capacity`, so the fallback stays in `charterCeiling` and nothing downstream can
   * mistake a resolved number for a registration the vessel does not hold.
   */
  async listBoats(): Promise<Boat[]> {
    const { rows } = await this.client().query('SELECT id, name, type, pier, capacity, license_pax, crew FROM boats ORDER BY name, id');
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), type: row.type ?? undefined, pier: row.pier ?? undefined,
      capacity: Number(row.capacity), license_pax: row.license_pax === null ? undefined : Number(row.license_pax),
      crew: row.crew === null ? undefined : Number(row.crew),
    }));
  }
  async listSeasons(): Promise<RouteSeason[]> {
    const { rows } = await this.client().query('SELECT id, route_id, kind, from_date::text, to_date::text FROM route_seasons ORDER BY route_id, from_date');
    return rows.map(season);
  }

  // ── Editing the catalogue (migration 070, todo/catalogue-editing-model.md; the rules are `catalogue.ts`'s) ──
  async listRouteFamilies(): Promise<RouteFamily[]> {
    const { rows } = await this.client().query('SELECT id, name, color, sort FROM route_families');
    return sortFamilies(rows.map((r) => ({ id: String(r.id), name: String(r.name), color: r.color ?? null, sort: Number(r.sort) })));
  }
  async insertRouteFamily(f: RouteFamily): Promise<void> {
    await this.client().query('INSERT INTO route_families (id, name, color, sort) VALUES ($1, $2, $3, $4)', [f.id, f.name, f.color, f.sort]);
  }
  async updateRouteFamily(id: string, patch: Partial<Omit<RouteFamily, 'id'>>): Promise<RouteFamily | undefined> {
    const { rows: [r] } = await this.client().query(`UPDATE route_families SET name = COALESCE($2, name), color = CASE WHEN $3 THEN $4 ELSE color END,
      sort = COALESCE($5, sort) WHERE id = $1 RETURNING id, name, color, sort`, [id, patch.name ?? null, patch.color !== undefined, patch.color ?? null, patch.sort ?? null]);
    return r && { id: String(r.id), name: String(r.name), color: r.color ?? null, sort: Number(r.sort) };
  }
  async familyUsage(id: string): Promise<number> { return Number((await this.client().query('SELECT count(*)::int AS n FROM routes WHERE family_id = $1', [id])).rows[0].n); }
  async deleteRouteFamily(id: string): Promise<boolean> { return ((await this.client().query('DELETE FROM route_families WHERE id = $1', [id])).rowCount ?? 0) > 0; }

  async route(id: string): Promise<Route | undefined> { return (await this.listRoutes()).find((r) => r.id === id); }
  async routeByExtId(extId: string): Promise<Route | undefined> { return (await this.listRoutes()).find((r) => r.ext_id === extId); }
  private async writeTimes(routeId: string, times: readonly string[]): Promise<void> {
    await this.client().query('DELETE FROM route_times WHERE route_id = $1', [routeId]);
    for (const [idx, at] of times.entries()) await this.client().query('INSERT INTO route_times (route_id, idx, departs_at) VALUES ($1, $2, $3)', [routeId, idx, at]);
  }
  async insertRoute(r: Route, seasons: readonly RouteSeason[]): Promise<void> {
    await this.client().query(`INSERT INTO routes (id, name, kind, ext_id, pier, family_id, color, islands, sort, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
      [r.id, r.name, r.kind ?? 'marine', r.ext_id ?? null, r.pier ?? null, r.family_id ?? null, r.color ?? null, r.islands ?? null, r.sort ?? null]);
    await this.writeTimes(r.id, r.times ?? []);
    for (const s of seasons) await this.client().query('INSERT INTO route_seasons (id, route_id, kind, from_date, to_date) VALUES ($1,$2,$3,$4,$5)', [s.id, r.id, s.kind, s.from_date, s.to_date]);
  }
  async updateRoute(id: string, f: RouteFields): Promise<void> {
    await this.client().query(`UPDATE routes SET name = $2, kind = $3, ext_id = $4, pier = $5, family_id = $6, color = $7, islands = $8, updated_at = now() WHERE id = $1`,
      [id, f.name, f.kind, f.ext_id, f.pier, f.family_id, f.color, f.islands]);
    await this.writeTimes(id, f.times);
  }
  async setRouteSorts(sorts: ReadonlyMap<string, number>): Promise<void> {
    await this.client().query(`UPDATE routes r SET sort = s.sort, updated_at = now() FROM jsonb_to_recordset($1::jsonb) AS s(id text, sort bigint)
      WHERE r.id = s.id AND r.sort IS DISTINCT FROM s.sort`, [JSON.stringify([...sorts].map(([id, sort]) => ({ id, sort })))]);
  }
  /** Its times, seasons and day overrides go with it (ON DELETE CASCADE). */
  async deleteRoute(id: string): Promise<boolean> { return ((await this.client().query('DELETE FROM routes WHERE id = $1', [id])).rowCount ?? 0) > 0; }
  async routeUsage(id: string): Promise<RouteUsage> {
    const { rows: [u] } = await this.client().query(`SELECT
      (SELECT count(DISTINCT booking_id) FROM booking_trips WHERE route_id = $1)::int AS bookings,
      (SELECT count(*) FROM deployments WHERE route_id = $1)::int AS deployments,
      (SELECT count(*) FROM seat_locks WHERE route_id = $1)::int AS seat_locks,
      (SELECT count(DISTINCT rate_type_id) FROM rate_type_routes WHERE route_id = $1)::int AS rate_types,
      (SELECT count(DISTINCT agent_id) FROM agent_programs WHERE route_id = $1)::int AS agents,
      (SELECT count(*) FROM (SELECT contract_id FROM contract_program_periods WHERE route_id = $1 UNION SELECT contract_id FROM contract_seat_prices WHERE route_id = $1) c)::int AS contracts,
      (SELECT count(*) FROM van_day_routes WHERE route_id = $1)::int AS van_days,
      (SELECT count(*) FROM van_groups WHERE route_id = $1)::int AS van_groups,
      (SELECT count(*) FROM van_stops WHERE route_id = $1)::int AS van_stops,
      (SELECT count(*) FROM booking_trip_upgrades WHERE from_route_id = $1 OR to_route_id = $1)::int AS upgrades,
      (SELECT count(*) FROM pickup_times WHERE route_id = $1)::int AS pickup_times`, [id]);
    return u as RouteUsage;
  }

  // ── Fleet, part A (todo/fleet-maintenance-model.md; migration 130): the rules are `fleet-*.ts`'s ──
  // A record is read whole with `to_jsonb` (dates come back as YYYY-MM-DD text, never a JS Date) and
  // written whole: the row upserted, its child rows replaced in the order sent.

  async fleetAssets<K extends AssetKind>(kind: K, q: AssetQuery = {}): Promise<AssetOf[K][]> {
    const t = FLEET_ASSET_TABLES[kind];
    const { rows } = await this.client().query(`SELECT to_jsonb(a) AS row,
        COALESCE((SELECT jsonb_agg(to_jsonb(l) - '${t.fk}' - 'seq' ORDER BY l.seq) FROM ${t.log} l WHERE l.${t.fk} = a.id), '[]'::jsonb) AS log
      FROM ${t.table} a WHERE ($1::text[] IS NULL OR a.id = ANY($1)) AND ($2::text IS NULL OR a.boat_id = $2)`, [q.ids ?? null, q.boatId ?? null]);
    return sortAssets(rows.map((r) => ({ ...r.row, log: r.log }) as AssetOf[K]));
  }
  async fleetAsset<K extends AssetKind>(kind: K, id: string): Promise<AssetOf[K] | undefined> { return (await this.fleetAssets(kind, { ids: [id] }))[0]; }
  async putFleetAsset<K extends AssetKind>(kind: K, asset: AssetOf[K]): Promise<void> {
    const t = FLEET_ASSET_TABLES[kind];
    await this.upsertWhole(t.table, t.columns, asset as unknown as Record<string, unknown>);
    await this.replaceChildren(t.log, t.fk, asset.id, 'seq', asset.log);
  }
  async fleetIncidents(q: IncidentQuery = {}): Promise<Incident[]> {
    const { rows } = await this.client().query(`SELECT to_jsonb(i) AS row,
        COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'incident_id' - 'idx' ORDER BY a.idx) FROM fleet_incident_assets a WHERE a.incident_id = i.id), '[]'::jsonb) AS damaged_assets,
        COALESCE((SELECT jsonb_agg(to_jsonb(l) - 'incident_id' - 'seq' ORDER BY l.seq) FROM fleet_incident_log l WHERE l.incident_id = i.id), '[]'::jsonb) AS progress_log
      FROM fleet_incidents i WHERE ($1::text[] IS NULL OR i.id = ANY($1)) AND ($2::text IS NULL OR i.boat_id = $2) AND ($3::text IS NULL OR i.job_id = $3)`,
    [q.ids ?? null, q.boatId ?? null, q.jobId ?? null]);
    return sortIncidents(rows.map((r) => ({ ...r.row, damaged_assets: r.damaged_assets, progress_log: r.progress_log }) as Incident));
  }
  async fleetIncident(id: string): Promise<Incident | undefined> { return (await this.fleetIncidents({ ids: [id] }))[0]; }
  async putFleetIncident(i: Incident): Promise<void> {
    await this.upsertWhole('fleet_incidents', FLEET_INCIDENT_COLUMNS, i as unknown as Record<string, unknown>);
    await this.replaceChildren('fleet_incident_assets', 'incident_id', i.id, 'idx', i.damaged_assets);
    await this.replaceChildren('fleet_incident_log', 'incident_id', i.id, 'seq', i.progress_log);
  }
  async deleteFleetIncident(id: string): Promise<boolean> { return ((await this.client().query('DELETE FROM fleet_incidents WHERE id = $1', [id])).rowCount ?? 0) > 0; }
  async fleetJobs(q: JobQuery = {}): Promise<Job[]> {
    const child = (table: string, order: string) =>
      `COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'job_id' - '${order}' ORDER BY c.${order}) FROM ${table} c WHERE c.job_id = j.id), '[]'::jsonb)`;
    const { rows } = await this.client().query(`SELECT to_jsonb(j) AS row, ${child('fleet_job_assets', 'idx')} AS assets, ${child('fleet_job_parts', 'idx')} AS parts,
        ${child('fleet_job_log', 'seq')} AS progress_log, ${child('fleet_job_steps', 'idx')} AS steps
      FROM fleet_jobs j WHERE ($1::text[] IS NULL OR j.id = ANY($1)) AND ($2::text IS NULL OR j.boat_id = $2) AND ($3::text IS NULL OR j.status = $3)
        AND ($4::text IS NULL OR j.incident_id = $4)`, [q.ids ?? null, q.boatId ?? null, q.status ?? null, q.incidentId ?? null]);
    return sortJobs(rows.map((r) => ({ ...r.row, assets: r.assets, parts: r.parts, progress_log: r.progress_log, steps: r.steps }) as Job));
  }
  async fleetJob(id: string): Promise<Job | undefined> { return (await this.fleetJobs({ ids: [id] }))[0]; }
  async putFleetJob(j: Job): Promise<void> {
    await this.upsertWhole('fleet_jobs', FLEET_JOB_COLUMNS, j as unknown as Record<string, unknown>);
    await this.replaceChildren('fleet_job_assets', 'job_id', j.id, 'idx', j.assets);
    await this.replaceChildren('fleet_job_parts', 'job_id', j.id, 'idx', j.parts);
    await this.replaceChildren('fleet_job_log', 'job_id', j.id, 'seq', j.progress_log);
    await this.replaceChildren('fleet_job_steps', 'job_id', j.id, 'idx', j.steps);
  }
  async deleteFleetJob(id: string): Promise<boolean> { return ((await this.client().query('DELETE FROM fleet_jobs WHERE id = $1', [id])).rowCount ?? 0) > 0; }
  async fleetNumbers(table: 'incidents' | 'jobs'): Promise<{ id: string; no: string }[]> {
    const { rows } = await this.client().query(`SELECT id, no FROM ${table === 'incidents' ? 'fleet_incidents' : 'fleet_jobs'}`);
    return rows.map((r) => ({ id: String(r.id), no: String(r.no) }));
  }
  /** The row with these columns, inserted or replaced; JSON turns into each column's type in SQL. */
  private async upsertWhole(table: string, columns: readonly string[], row: Record<string, unknown>): Promise<void> {
    const values = Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));
    await this.client().query(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)
      ON CONFLICT (id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`, [JSON.stringify(values)]);
  }
  /** A record's child rows replaced by `items`, numbered by their place. */
  private async replaceChildren(table: string, fk: string, id: string, order: string, items: readonly object[]): Promise<void> {
    await this.client().query(`DELETE FROM ${table} WHERE ${fk} = $1`, [id]);
    if (!items.length) return;
    await this.client().query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
      [JSON.stringify(items.map((item, n) => ({ ...item, [fk]: id, [order]: n })))]);
  }

  /** Every field of every boat, its documents and status log in order, by name then id. */
  async boatRecords(id?: string): Promise<BoatRecord[]> {
    const { rows } = await this.client().query(`SELECT b.*, b.retired_on::text AS retired_on_text, b.unretired_on::text AS unretired_on_text,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', d.name, 'expires_on', d.expires_on::text, 'renew_status', d.renew_status) ORDER BY d.idx)
        FROM boat_documents d WHERE d.boat_id = b.id), '[]'::jsonb) AS documents_json,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'status', l.status, 'from_date', l.from_date::text, 'to_date', l.to_date::text, 'loc', l.loc,
          'province', l.province, 'loc_type', l.loc_type, 'detail', l.detail, 'note', l.note, 'reason', l.reason, 'project_id', l.project_id,
          'planned_over', to_jsonb(l.planned_over)) ORDER BY l.seq)
        FROM boat_status_log l WHERE l.boat_id = b.id), '[]'::jsonb) AS log_json
      FROM boats b WHERE ($1::text IS NULL OR b.id = $1) ORDER BY b.name, b.id`, [id ?? null]);
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return rows.map((r): BoatRecord => ({
      ...Object.fromEntries(BOAT_TEXT_FIELDS.map((k) => [k, r[k] ?? null])) as Pick<BoatRecord, typeof BOAT_TEXT_FIELDS[number]>,
      ...Object.fromEntries(BOAT_MEASURES.map((k) => [k, num(r[k])])) as Pick<BoatRecord, typeof BOAT_MEASURES[number]>,
      id: String(r.id), name: String(r.name), type: r.type ?? null, pier: r.pier ?? null, ownership: r.ownership, color: r.color ?? null,
      engine_count: num(r.engine_count), capacity: Number(r.capacity), license_pax: num(r.license_pax), crew: num(r.crew), fish_crew: num(r.fish_crew),
      registered_persons: num(r.registered_persons), retired: r.retired === true, retired_on: r.retired_on_text ?? null, retired_reason: r.retired_reason ?? null,
      unretired_on: r.unretired_on_text ?? null, documents: r.documents_json as BoatRecord['documents'], status_log: r.log_json as BoatRecord['status_log'],
      updated_at: isoOrNull(r.updated_at),
    }));
  }
  async boatRecord(id: string): Promise<BoatRecord | undefined> { return (await this.boatRecords(id))[0]; }
  /** Creates or replaces the boat with its documents and status log, stamped as edited here. */
  async writeBoat(b: BoatRecord, now: string): Promise<BoatRecord> {
    const columns = ['name', 'type', 'pier', 'ownership', 'color', 'engine_count', 'capacity', 'license_pax', 'crew', 'fish_crew', 'registered_persons',
      ...BOAT_TEXT_FIELDS, ...BOAT_MEASURES, 'retired', 'retired_on', 'retired_reason', 'unretired_on'] as const;
    const values = columns.map((c) => b[c]);
    await this.client().query(`INSERT INTO boats (id, ${columns.join(', ')}, updated_at) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}, $${columns.length + 2})
      ON CONFLICT (id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = EXCLUDED.updated_at`, [b.id, ...values, now]);
    await this.client().query('DELETE FROM boat_documents WHERE boat_id = $1', [b.id]);
    // Positions are the list's: `idx` and `seq` are assigned here from the order sent.
    await this.client().query('INSERT INTO boat_documents SELECT * FROM jsonb_populate_recordset(NULL::boat_documents, $1::jsonb)',
      [JSON.stringify(b.documents.map((d, idx) => ({ boat_id: b.id, idx, ...d })))]);
    await this.client().query('DELETE FROM boat_status_log WHERE boat_id = $1', [b.id]);
    await this.client().query('INSERT INTO boat_status_log SELECT * FROM jsonb_populate_recordset(NULL::boat_status_log, $1::jsonb)',
      [JSON.stringify(b.status_log.map((e, seq) => ({ boat_id: b.id, seq, ...e })))]);
    return (await this.boatRecord(b.id))!;
  }
  /** The boat's numbers onto each of its deployments from `from` on; answers the days changed. */
  async updateBoatDeployments(boatId: string, from: string, n: Pick<Deployment, 'capacity' | 'license_pax' | 'registered_persons'>): Promise<Deployment[]> {
    const { rows } = await this.client().query(`UPDATE deployments SET capacity = $3, license_pax = $4, registered_persons = $5 WHERE boat_id = $1 AND service_date >= $2
      RETURNING boat_id, route_id, service_date::text, capacity, license_pax, registered_persons`, [boatId, from, n.capacity, n.license_pax ?? null, n.registered_persons ?? n.capacity]);
    return rows.map((row) => ({ boat_id: String(row.boat_id), route_id: String(row.route_id), service_date: String(row.service_date), capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), registered_persons: optionalInt(row.registered_persons) }))
      .sort((a, b) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : 0));
  }
  async boatDeploymentsFrom(boatId: string, from: string): Promise<Deployment[]> {
    const { rows } = await this.client().query(`SELECT boat_id, route_id, service_date::text, capacity, license_pax, registered_persons FROM deployments
      WHERE boat_id = $1 AND service_date >= $2 ORDER BY service_date`, [boatId, from]);
    return rows.map((row) => ({ boat_id: String(row.boat_id), route_id: String(row.route_id), service_date: String(row.service_date), capacity: Number(row.capacity), license_pax: optionalInt(row.license_pax), registered_persons: optionalInt(row.registered_persons) }));
  }
  async boatCapacityOverrides(boatId: string, from?: string, to?: string): Promise<StoredOverride[]> {
    const { rows } = await this.client().query(`SELECT boat_id, service_date::text, capacity, reason, set_by, set_at FROM boat_capacity_overrides
      WHERE boat_id = $1 AND ($2::date IS NULL OR service_date >= $2) AND ($3::date IS NULL OR service_date <= $3) ORDER BY service_date`, [boatId, from ?? null, to ?? null]);
    return rows.map((r) => ({ boat_id: String(r.boat_id), service_date: String(r.service_date), capacity: Number(r.capacity), reason: r.reason ?? null, set_by: r.set_by ?? null, set_at: isoOrNull(r.set_at) }));
  }
  async deleteBoatCapacityOverride(boatId: string, date: string): Promise<boolean> {
    return ((await this.client().query('DELETE FROM boat_capacity_overrides WHERE boat_id = $1 AND service_date = $2', [boatId, date])).rowCount ?? 0) > 0;
  }
  /**
   * Agents, markets and salespeople. There are about 130 agents, so the list is read whole and handed
   * to `selectAgents`: filtering and sorting in SQL would be a second copy of that rule to keep in step.
   */
  async listMarkets(): Promise<Market[]> {
    const { rows } = await this.client().query(`SELECT m.id, m.name, m.color, m.sort,
      COALESCE((SELECT array_agg(s.name ORDER BY s.idx, s.name) FROM market_subs s WHERE s.market_id = m.id), '{}') AS subs FROM markets m`);
    return sortMarkets(rows.map((row) => ({ id: String(row.id), name: String(row.name), color: text(row.color), sort: num(row.sort), subs: (row.subs as string[]).map(String) })));
  }
  async listSalesPeople(): Promise<SalesPersonSummary[]> {
    const { rows } = await this.client().query('SELECT id, code, name, full_name, designation, email, tel, color, active, signature IS NOT NULL AS has_signature FROM sales_people');
    return sortSalesPeople(rows.map((row) => ({
      id: String(row.id), code: text(row.code), name: String(row.name), full_name: text(row.full_name), designation: text(row.designation),
      email: text(row.email), tel: text(row.tel), color: text(row.color), active: row.active === true, has_signature: row.has_signature === true,
    })));
  }
  async listAgents(query: AgentListQuery): Promise<AgentSummary[]> {
    const { rows } = await this.client().query(AGENT_SELECT);
    return selectAgents(rows.map(storedAgent), await this.listMarkets(), await this.listSalesPeople(), query).map(agentSummary);
  }
  async agent(id: string): Promise<Agent | undefined> {
    const { rows: [row] } = await this.client().query(`${AGENT_SELECT} WHERE a.id = $1`, [id]);
    return row && agentView(storedAgent(row), await this.readSeasons(id));
  }
  private async readSeasons(agentId: string): Promise<RateSeason[]> {
    const { rows } = await this.client().query(
      'SELECT rate_type_id, from_date::text AS "from", to_date::text AS "to" FROM agent_rate_seasons WHERE agent_id = $1 ORDER BY from_date', [agentId]);
    return rows.map((row) => ({ rate_type_id: String(row.rate_type_id), from: String(row.from), to: row.to ?? null }));
  }
  /** An agent's rate seasons by `from` (migration 030); undefined for an unknown agent. */
  async rateSeasons(agentId: string): Promise<RateSeason[] | undefined> {
    if (!(await this.client().query('SELECT 1 FROM agents WHERE id = $1', [agentId])).rowCount) return undefined;
    return this.readSeasons(agentId);
  }
  /** Replaces the table and appends `activity` to the agent's log, as legacy's `rtmSave` does. */
  async setRateSeasons(agentId: string, seasons: readonly RateSeason[], activity: AgentActivity): Promise<RateSeason[] | undefined> {
    if (!(await this.client().query('SELECT 1 FROM agents WHERE id = $1 FOR UPDATE', [agentId])).rowCount) return undefined;
    await this.client().query('DELETE FROM agent_rate_seasons WHERE agent_id = $1', [agentId]);
    for (const s of seasons) {
      await this.client().query('INSERT INTO agent_rate_seasons (agent_id, from_date, to_date, rate_type_id) VALUES ($1,$2,$3,$4)', [agentId, s.from, s.to, s.rate_type_id]);
    }
    await this.client().query('INSERT INTO agent_activity (agent_id, at, by, kind, text) VALUES ($1,$2,$3,$4,$5)', [agentId, activity.at, activity.by, activity.kind, activity.text]);
    return this.readSeasons(agentId);
  }
  /** Undefined for an unknown agent. The serial id orders two entries written at the same instant. */
  async agentActivity(id: string, limit: number): Promise<AgentActivity[] | undefined> {
    const { rows: [known] } = await this.client().query('SELECT 1 FROM agents WHERE id = $1', [id]);
    if (!known) return undefined;
    const { rows } = await this.client().query('SELECT id, at, by, kind, text FROM agent_activity WHERE agent_id = $1', [id]);
    return latestActivity(rows.map((row) => ({ at: asIso(row.at), by: text(row.by), kind: String(row.kind), text: String(row.text), seq: Number(row.id) })), limit);
  }

  // ── Sales editing (todo/sales-editing-model.md): the rules are `agent-writes.ts`'s and the
  //    other modules'; these only read and write the rows, as the in-process store keeps them. ──

  async agentRecord(id: string): Promise<StoredAgent | undefined> {
    const { rows: [row] } = await this.client().query(`${AGENT_SELECT} WHERE a.id = $1 FOR UPDATE OF a`, [id]);
    return row && storedAgent(row);
  }
  async agentRecords(): Promise<StoredAgent[]> { return (await this.client().query(AGENT_SELECT)).rows.map(storedAgent); }
  /** Inserts or replaces the agent, replaces its programmes, and appends the activity lines in order. */
  async saveAgent(agent: StoredAgent, activity: readonly AgentActivity[]): Promise<void> {
    const { programs, ...columns } = agent;
    const names = Object.keys(columns);
    await this.client().query(`INSERT INTO agents (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
      ON CONFLICT (id) DO UPDATE SET ${names.filter((n) => n !== 'id' && n !== 'created_at').map((n) => `${n} = EXCLUDED.${n}`).join(', ')}`, Object.values(columns));
    await this.client().query('DELETE FROM agent_programs WHERE agent_id = $1', [agent.id]);
    for (const [idx, p] of programs.entries()) {
      await this.client().query('INSERT INTO agent_programs (agent_id, route_id, idx, book_from, book_to, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [agent.id, p.route_id, idx, p.book_from, p.book_to, p.note]);
    }
    await this.addAgentActivity(agent.id, activity);
  }
  async addAgentActivity(agentId: string, activity: readonly AgentActivity[]): Promise<void> {
    for (const a of activity) {
      await this.client().query('INSERT INTO agent_activity (agent_id, at, by, kind, text) VALUES ($1,$2,$3,$4,$5)', [agentId, a.at, a.by, a.kind, a.text]);
    }
  }
  async agentUsage(id: string): Promise<AgentUsage> {
    const { rows: [u] } = await this.client().query(`SELECT
      (SELECT count(*) FROM bookings WHERE agent_id = $1)::int AS bookings, (SELECT count(*) FROM contracts WHERE agent_id = $1)::int AS contracts,
      (SELECT count(*) FROM seat_locks WHERE agent_id = $1)::int AS seat_locks, (SELECT count(*) FROM invoices WHERE agent_id = $1)::int AS invoices,
      (SELECT count(*) FROM users WHERE agent_id = $1)::int AS logins`, [id]);
    return { bookings: u.bookings, contracts: u.contracts, seat_locks: u.seat_locks, invoices: u.invoices, logins: u.logins };
  }
  async deleteAgent(id: string): Promise<void> {
    // Issued documents name the agent without a cascade; an agent with a contract cannot get here.
    await this.client().query('DELETE FROM contract_documents WHERE agent_id = $1', [id]);
    await this.client().query('DELETE FROM agents WHERE id = $1', [id]);
  }
  /** Newest first. */
  async contractHistory(agentId: string): Promise<ContractHistoryEntry[]> {
    const { rows } = await this.client().query(`SELECT version, archived_at::text, contract_start::text, contract_end::text, rate_type_id, programs, signatory, archived_by
      FROM agent_contract_history WHERE agent_id = $1 ORDER BY id DESC`, [agentId]);
    return rows.map((r) => ({
      version: r.version ?? null, archived_at: r.archived_at, contract_start: r.contract_start ?? null, contract_end: r.contract_end ?? null,
      rate_type_id: r.rate_type_id ?? null, programs: r.programs as AgentProgram[], signatory: r.signatory ?? null, archived_by: r.archived_by ?? null,
    }));
  }
  async addContractHistory(agentId: string, h: ContractHistoryEntry): Promise<void> {
    await this.client().query(`INSERT INTO agent_contract_history (agent_id, version, archived_at, contract_start, contract_end, rate_type_id, programs, signatory, archived_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [agentId, h.version, h.archived_at, h.contract_start, h.contract_end, h.rate_type_id, JSON.stringify(h.programs), h.signatory === null ? null : JSON.stringify(h.signatory), h.archived_by]);
  }
  async setContractFields(id: string, fields: Partial<Pick<Contract, 'rate_type_id' | 'doc_id'>>): Promise<void> {
    if (fields.rate_type_id !== undefined) await this.client().query('UPDATE contracts SET rate_type_id = $2 WHERE id = $1', [id, fields.rate_type_id]);
    if (fields.doc_id !== undefined) await this.client().query('UPDATE contracts SET doc_id = $2 WHERE id = $1', [id, fields.doc_id]);
  }

  async saveMarket(market: Market): Promise<void> {
    await this.client().query(`INSERT INTO markets (id, name, color, sort) VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, sort = EXCLUDED.sort`, [market.id, market.name, market.color, market.sort]);
    await this.client().query('DELETE FROM market_subs WHERE market_id = $1', [market.id]);
    for (const [idx, name] of market.subs.entries()) await this.client().query('INSERT INTO market_subs (market_id, idx, name) VALUES ($1,$2,$3)', [market.id, idx, name]);
  }
  async deleteMarket(id: string): Promise<void> { await this.client().query('DELETE FROM markets WHERE id = $1', [id]); }

  async salesPerson(id: string): Promise<StoredSalesPerson | undefined> {
    const { rows: [r] } = await this.client().query('SELECT id, code, name, full_name, designation, email, tel, color, active, signature FROM sales_people WHERE id = $1', [id]);
    return r && { id: String(r.id), code: text(r.code), name: String(r.name), full_name: text(r.full_name), designation: text(r.designation),
      email: text(r.email), tel: text(r.tel), color: text(r.color), active: r.active === true, signature: text(r.signature) };
  }
  async saveSalesPerson(p: StoredSalesPerson): Promise<void> {
    await this.client().query(`INSERT INTO sales_people (id, code, name, full_name, designation, email, tel, color, active, signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, full_name = EXCLUDED.full_name, designation = EXCLUDED.designation,
        email = EXCLUDED.email, tel = EXCLUDED.tel, color = EXCLUDED.color, active = EXCLUDED.active, signature = EXCLUDED.signature`,
    [p.id, p.code, p.name, p.full_name, p.designation, p.email, p.tel, p.color, p.active, p.signature]);
  }
  async salesUsage(id: string): Promise<{ logins: number; rate_types: number }> {
    const { rows: [u] } = await this.client().query(`SELECT (SELECT count(*) FROM users WHERE sales_id = $1)::int AS logins,
      (SELECT count(*) FROM rate_types WHERE owner_sales_id = $1)::int AS rate_types`, [id]);
    return { logins: u.logins, rate_types: u.rate_types };
  }
  async deleteSalesPerson(id: string): Promise<void> { await this.client().query('DELETE FROM sales_people WHERE id = $1', [id]); }

  async listTemplates(): Promise<ContractTemplate[]> {
    const { rows } = await this.client().query(`SELECT id, code, name, active, is_default, created_date::text, note, form, accent, accent_hex, font, sections, text, created_at, updated_at
      FROM contract_templates`);
    return sortTemplates(rows.map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name), active: r.active === true, is_default: r.is_default === true, created_date: r.created_date ?? null,
      note: text(r.note), form: text(r.form), accent: text(r.accent), accent_hex: text(r.accent_hex), font: text(r.font),
      sections: r.sections as ContractTemplate['sections'], text: r.text as ContractTemplate['text'], created_at: asIso(r.created_at), updated_at: asIso(r.updated_at),
    })));
  }
  async saveTemplate(t: ContractTemplate): Promise<void> {
    await this.client().query(`INSERT INTO contract_templates (id, code, name, active, is_default, created_date, note, form, accent, accent_hex, font, sections, text, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, active = EXCLUDED.active, is_default = EXCLUDED.is_default,
        note = EXCLUDED.note, form = EXCLUDED.form, accent = EXCLUDED.accent, accent_hex = EXCLUDED.accent_hex, font = EXCLUDED.font,
        sections = EXCLUDED.sections, text = EXCLUDED.text, updated_at = EXCLUDED.updated_at`,
    [t.id, t.code, t.name, t.active, t.is_default, t.created_date, t.note, t.form, t.accent, t.accent_hex, t.font, JSON.stringify(t.sections), JSON.stringify(t.text), t.created_at, t.updated_at]);
  }
  /** Makes it the default, and active; the old default first, as the index allows one. */
  async setDefaultTemplate(id: string, now: string): Promise<void> {
    await this.client().query('UPDATE contract_templates SET is_default = false, updated_at = $2 WHERE is_default AND id <> $1', [id, now]);
    await this.client().query('UPDATE contract_templates SET is_default = true, active = true, updated_at = $2 WHERE id = $1', [id, now]);
  }
  async deleteTemplate(id: string): Promise<void> { await this.client().query('DELETE FROM contract_templates WHERE id = $1', [id]); }

  private async readDocuments(where: string, param: string): Promise<ContractDocument[]> {
    const { rows } = await this.client().query(`SELECT id, agent_id, contract_id, version, lang, generated_at, generated_by, template_id, template_name, rate_type_ref,
      rate_type_name, page_count, content FROM contract_documents WHERE ${where} = $1`, [param]);
    return sortDocuments(rows.map((r) => ({
      id: String(r.id), agent_id: String(r.agent_id), contract_id: text(r.contract_id), version: String(r.version), lang: (r.lang ?? null) as ContractDocument['lang'],
      generated_at: asIso(r.generated_at), generated_by: text(r.generated_by), template_id: text(r.template_id), template_name: text(r.template_name),
      rate_type_ref: text(r.rate_type_ref), rate_type_name: text(r.rate_type_name), page_count: num(r.page_count), content: r.content as Record<string, unknown>,
    })));
  }
  async listDocuments(agentId: string): Promise<ContractDocument[]> { return this.readDocuments('agent_id', agentId); }
  async contractDocument(id: string): Promise<ContractDocument | undefined> { return (await this.readDocuments('id', id))[0]; }
  async addDocument(d: ContractDocument): Promise<void> {
    await this.client().query(`INSERT INTO contract_documents (id, agent_id, contract_id, version, lang, generated_at, generated_by, template_id, template_name,
      rate_type_ref, rate_type_name, page_count, content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [d.id, d.agent_id, d.contract_id, d.version, d.lang, d.generated_at, d.generated_by, d.template_id, d.template_name, d.rate_type_ref, d.rate_type_name, d.page_count, JSON.stringify(d.content)]);
  }
  async deleteDocument(id: string): Promise<void> {
    await this.client().query('UPDATE contracts SET doc_id = NULL WHERE doc_id = $1', [id]);
    await this.client().query('DELETE FROM contract_documents WHERE id = $1', [id]);
  }

  async listAddonServices(): Promise<AddonService[]> {
    const { rows } = await this.client().query(`SELECT s.id, s.name, s.type, s.description, s.active, s.sort, s.created_at, s.updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'unit', v.unit, 'selling', v.selling, 'net', v.net) ORDER BY v.seq)
        FROM addon_service_variants v WHERE v.service_id = s.id), '[]'::jsonb) AS variants FROM addon_services s`);
    return sortAddonServices(rows.map((r) => ({
      id: String(r.id), name: String(r.name), type: r.type as AddonService['type'], description: text(r.description), active: r.active === true, sort: num(r.sort),
      variants: (r.variants as Record<string, unknown>[]).map((v) => ({ id: String(v.id), name: String(v.name), unit: text(v.unit), selling: num(v.selling), net: num(v.net) })),
      created_at: asIso(r.created_at), updated_at: asIso(r.updated_at),
    })));
  }
  async addonService(id: string): Promise<AddonService | undefined> { return (await this.listAddonServices()).find((s) => s.id === id); }
  async saveAddonService(s: AddonService): Promise<void> {
    await this.client().query(`INSERT INTO addon_services (id, name, type, description, active, sort, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, description = EXCLUDED.description, active = EXCLUDED.active,
        sort = EXCLUDED.sort, updated_at = EXCLUDED.updated_at`, [s.id, s.name, s.type, s.description, s.active, s.sort, s.created_at, s.updated_at]);
    await this.client().query('DELETE FROM addon_service_variants WHERE service_id = $1', [s.id]);
    for (const [seq, v] of s.variants.entries()) {
      await this.client().query('INSERT INTO addon_service_variants (service_id, seq, id, name, unit, selling, net) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [s.id, seq, v.id, v.name, v.unit, v.selling, v.net]);
    }
  }
  async deleteAddonService(id: string): Promise<void> { await this.client().query('DELETE FROM addon_services WHERE id = $1', [id]); }

  async listNationalities(): Promise<StoredNationality[]> {
    const { rows } = await this.client().query('SELECT code, name, builtin, sort, created_at, created_by FROM nationalities');
    return rows.map((r) => ({ code: String(r.code), name: String(r.name), builtin: r.builtin === true, sort: num(r.sort), created_at: asIso(r.created_at), created_by: text(r.created_by) }));
  }
  async addNationality(n: StoredNationality): Promise<void> {
    await this.client().query('INSERT INTO nationalities (code, name, builtin, sort, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [n.code, n.name, n.builtin, n.sort, n.created_at, n.created_by]);
  }

  /** The insurance command's result (`insurance.ts`): the lead's fields and the named passengers'. */
  async setInsurance(bookingId: string, lead: InsuranceFields | undefined, passengers: ReadonlyMap<number, InsuranceFields>): Promise<void> {
    if (lead) {
      await this.client().query('UPDATE bookings SET lead_age = $2, lead_insurance_reviewed_at = $3, lead_insurance_reviewed_by = $4 WHERE id = $1',
        [bookingId, lead.age, lead.reviewed_at, lead.reviewed_by]);
    }
    for (const [seq, f] of passengers) {
      await this.client().query('UPDATE booking_passengers SET age = $3, insurance_reviewed_at = $4, insurance_reviewed_by = $5 WHERE booking_id = $1 AND seq = $2',
        [bookingId, seq, f.age, f.reviewed_at, f.reviewed_by]);
    }
  }

  // ── Rate types ─────────────────────────────────────────────────────────────────────────────────
  // The rows are read and written here; everything the API says about them is `rate-types.ts`'s.

  /** Every row of the given rate types (all of them when `ids` is undefined), grouped by rate type. */
  private async readRateTypes(ids?: readonly string[]): Promise<RateTypeRows[]> {
    const params = [ids === undefined ? null : [...ids]];
    const where = (column: string) => `WHERE ($1::text[] IS NULL OR ${column} = ANY($1))`;
    const n = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    // One after another, not Promise.all: inside a transaction these share one connection, and `pg`
    // deprecates queuing a query on a client that is still running one (removed in pg@9).
    const select = async (sql: string) => (await this.client().query(sql, params)).rows;
    const rates = await select(`SELECT id, code, name, note, color, owner_sales_id, valid_from::text, valid_to::text, active, nationality_scope, transfer_unit,
      created_on::text, created_at, updated_at FROM rate_types ${where('id')}`);
    const routes = await select(`SELECT rate_type_id, route_id, seq, travel_from::text, travel_to::text, longtail_bundle, longtail_bundle_adult, longtail_bundle_child,
      longtail_bundle_applies_to FROM rate_type_routes ${where('rate_type_id')}`);
    const seat = await select(`SELECT rate_type_id, route_id, zone, category, residency, tier, price FROM rate_type_seat_prices ${where('rate_type_id')}`);
    const charter = await select(`SELECT rate_type_id, route_id, boat_type, starter_price, starter_includes, extra_per_pax FROM rate_type_charter_prices ${where('rate_type_id')}`);
    const longtail = await select(`SELECT rate_type_id, route_id, join_adult, join_child, charter_price, charter_capacity FROM rate_type_longtail_prices ${where('rate_type_id')}`);
    const transfer = await select(`SELECT rate_type_id, route_id, zone, vehicle, price FROM rate_type_transfer_prices ${where('rate_type_id')}`);
    const all = new Map<string, RateTypeRows>();
    for (const r of rates) {
      all.set(String(r.id), {
        rate: {
          id: String(r.id), code: String(r.code), name: String(r.name), note: text(r.note), color: text(r.color), owner_sales_id: text(r.owner_sales_id),
          valid_from: text(r.valid_from), valid_to: text(r.valid_to), active: r.active === true, nationality_scope: text(r.nationality_scope) as NationalityScope | null,
          transfer_unit: text(r.transfer_unit), created_on: text(r.created_on), created_at: asIso(r.created_at), updated_at: asIso(r.updated_at),
        },
        routes: [], seat: [], charter: [], longtail: [], transfer: [],
      });
    }
    const of = (row: QueryResultRow) => all.get(String(row.rate_type_id));
    for (const r of routes) of(r)?.routes.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), seq: Number(r.seq), travel_from: text(r.travel_from), travel_to: text(r.travel_to),
      longtail_bundle: text(r.longtail_bundle) as BundleMode | null, longtail_bundle_adult: n(r.longtail_bundle_adult), longtail_bundle_child: n(r.longtail_bundle_child),
      longtail_bundle_applies_to: text(r.longtail_bundle_applies_to) as BundleAppliesTo | null,
    });
    for (const r of seat) of(r)?.seat.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), zone: String(r.zone), category: r.category as SeatPriceRow['category'],
      residency: r.residency as SeatPriceRow['residency'], tier: r.tier as RateTier, price: Number(r.price),
    });
    for (const r of charter) of(r)?.charter.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), boat_type: String(r.boat_type),
      starter_price: n(r.starter_price), starter_includes: n(r.starter_includes), extra_per_pax: n(r.extra_per_pax),
    });
    for (const r of longtail) of(r)?.longtail.push({
      rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), join_adult: n(r.join_adult), join_child: n(r.join_child),
      charter_price: n(r.charter_price), charter_capacity: n(r.charter_capacity),
    });
    for (const r of transfer) of(r)?.transfer.push({ rate_type_id: String(r.rate_type_id), route_id: String(r.route_id), zone: String(r.zone), vehicle: String(r.vehicle), price: Number(r.price) });
    return [...all.values()];
  }

  async listContracts(query: ContractListQuery): Promise<Contract[]> { return selectContracts(await this.readContracts(query), query).map(contractView); }
  async contract(id: string): Promise<Contract | undefined> { const [found] = await this.readContracts({ id }); return found && contractView(found); }
  /** Contracts with their periods and prices; ordering and the view are `selectContracts`/`contractView`'s. */
  private async readContracts(filter: ContractListQuery & { id?: string }): Promise<Contract[]> {
    const { rows } = await this.client().query(
      `SELECT id, agent_id, kind, status, rate_type_id, active_from::text, active_to::text, priority, version, price_mode, discount_mode,
              discount_value, bonus_buy, bonus_free, bonus_basis, book_window, created_date::text, created_by, note, doc_id
       FROM contracts WHERE ($1::text IS NULL OR id = $1) AND ($2::text IS NULL OR agent_id = $2) AND ($3::text IS NULL OR kind = $3) AND ($4::text IS NULL OR status = $4)`,
      [filter.id ?? null, filter.agentId ?? null, filter.kind ?? null, filter.status ?? null]);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row.id));
    const periods = new Map<string, ContractPeriod[]>(), prices = new Map<string, ContractSeatPrice[]>();
    for (const p of (await this.client().query(
      `SELECT contract_id, route_id, book_from::text, book_to::text, travel_from::text, travel_to::text, note
       FROM contract_program_periods WHERE contract_id = ANY($1::text[]) ORDER BY contract_id, seq`, [ids])).rows) {
      (periods.get(p.contract_id) ?? periods.set(p.contract_id, []).get(p.contract_id)!)
        .push({ route_id: p.route_id, book_from: p.book_from, book_to: p.book_to, travel_from: p.travel_from ?? null, travel_to: p.travel_to ?? null, note: p.note ?? null });
    }
    for (const p of (await this.client().query(
      'SELECT contract_id, route_id, zone, category, residency, price FROM contract_seat_prices WHERE contract_id = ANY($1::text[])', [ids])).rows) {
      (prices.get(p.contract_id) ?? prices.set(p.contract_id, []).get(p.contract_id)!)
        .push({ route_id: p.route_id, zone: p.zone, category: p.category, residency: p.residency, price: Number(p.price) });
    }
    return rows.map((row): Contract => ({
      id: row.id, agent_id: row.agent_id, kind: row.kind, status: row.status, rate_type_id: row.rate_type_id ?? null,
      active_from: row.active_from ?? null, active_to: row.active_to ?? null, priority: Number(row.priority), version: row.version ?? null,
      price_mode: row.price_mode ?? null,
      discount: row.discount_mode === null ? null : { mode: row.discount_mode, value: Number(row.discount_value) },
      bonus: row.bonus_buy === null ? null : { buy: Number(row.bonus_buy), free: Number(row.bonus_free), basis: row.bonus_basis ?? null },
      book_window: row.book_window === true, created_date: row.created_date ?? null, created_by: row.created_by ?? null,
      note: row.note ?? null, doc_id: row.doc_id ?? null,
      program_periods: periods.get(row.id) ?? [], seat_prices: prices.get(row.id) ?? [],
    }));
  }

  /** The trip, its booking and its dispatch as stored, for a dispatch write; undefined for an unknown trip. */
  async tripForDispatch(tripId: string): Promise<{ booking: Booking; trip: Booking['trips'][number]; dispatch: StoredDispatch | undefined; deployedBoats: Set<string> } | undefined> {
    const { rows: [row] } = await this.client().query('SELECT booking_id FROM booking_trips WHERE id = $1', [tripId]);
    if (!row) return undefined;
    const { rows: [full] } = await this.client().query(`${BOOKING_SELECT} WHERE b.id = $1`, [row.booking_id]);
    const view = booking(full);
    const raw = (full.trips as Record<string, unknown>[]).find((t) => t.id === tripId)!;
    return { booking: view, trip: view.trips.find((t) => t.id === tripId)!, dispatch: storedDispatch(raw), deployedBoats: new Set((raw.deployed as string[]) ?? []) };
  }
  /** Writes a trip's dispatch whole: its row in booking_trip_operations and its boat splits. */
  async setDispatch(tripId: string, d: StoredDispatch): Promise<void> {
    await this.client().query(`INSERT INTO booking_trip_operations (booking_trip_id, boat_id, pickup_time_final, pickup_time_final_end, pickup_final_at_pier,
        return_same_van, pier_note, pier_note_at, pier_note_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (booking_trip_id) DO UPDATE SET boat_id = EXCLUDED.boat_id, pickup_time_final = EXCLUDED.pickup_time_final,
        pickup_time_final_end = EXCLUDED.pickup_time_final_end, pickup_final_at_pier = EXCLUDED.pickup_final_at_pier, return_same_van = EXCLUDED.return_same_van,
        pier_note = EXCLUDED.pier_note, pier_note_at = EXCLUDED.pier_note_at, pier_note_by = EXCLUDED.pier_note_by`,
      [tripId, d.boat_id, d.pickup_time_final, d.pickup_time_final_end, d.pickup_final_at_pier, d.return_same_van, d.pier_note?.text ?? null, d.pier_note?.at ?? null, d.pier_note?.by ?? null]);
    await this.client().query('DELETE FROM booking_trip_boat_splits WHERE booking_trip_id = $1', [tripId]);
    for (const [idx, s] of d.boat_splits.entries()) {
      await this.client().query('INSERT INTO booking_trip_boat_splits (booking_trip_id, idx, boat_id, ad, chd, inf, foc) VALUES ($1,$2,$3,$4,$5,$6,$7)', [tripId, idx, s.boat_id, s.ad, s.chd, s.inf, s.foc]);
    }
  }

  // ── Van parts and groups (migration 016, slice A2) ──
  /** Serializes van-group writes on one route's day across instances, as group numbers come from the day's highest. */
  async lockVanDay(date: string, routeId: string): Promise<void> { await this.client().query('SELECT pg_advisory_xact_lock(hashtext($1))', [`van:${date}:${routeId}`]); }
  async bookingsOn(date: string, routeId: string): Promise<Booking[]> {
    const { rows } = await this.client().query(`${BOOKING_SELECT} WHERE b.id IN (SELECT booking_id FROM booking_trips WHERE service_date = $1 AND route_id = $2) ORDER BY b.id`, [date, routeId]);
    return rows.map(booking);
  }
  async vanGroupsOn(date: string, routeId: string): Promise<VanGroup[]> {
    return (await this.client().query(`SELECT ${VAN_GROUP_JSON} AS g FROM van_groups g WHERE service_date = $1 AND route_id = $2 ORDER BY number`, [date, routeId])).rows.map((r) => vanGroup(r.g));
  }
  async vanGroup(id: string): Promise<VanGroup | undefined> {
    const { rows: [row] } = await this.client().query(`SELECT ${VAN_GROUP_JSON} AS g FROM van_groups g WHERE id = $1`, [id]);
    return row && vanGroup(row.g);
  }
  async storedVanParts(tripId: string): Promise<StoredVanPart[]> {
    return (await this.client().query(`SELECT jsonb_build_object(${VAN_PART_FIELDS}) AS p FROM booking_trip_van_allocations a WHERE booking_trip_id = $1 ORDER BY idx`, [tripId])).rows.map((r) => vanPart(r.p));
  }
  async writeVanGroup(g: VanGroup): Promise<void> {
    await this.client().query(`INSERT INTO van_groups (id, service_date, route_id, zone, number, van_id, return_van_id, pickup_time, display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET zone = EXCLUDED.zone, number = EXCLUDED.number, van_id = EXCLUDED.van_id, return_van_id = EXCLUDED.return_van_id, pickup_time = EXCLUDED.pickup_time,
        display_order = EXCLUDED.display_order`,
      [g.id, g.service_date, g.route_id, g.zone, g.number, g.van_id, g.return_van_id, g.pickup_time, g.display_order]);
  }

  // ── Van job orders (migration 080) ──
  /** Every booking with a trip on the date, on any route. */
  async bookingsOnDate(date: string): Promise<Booking[]> {
    const { rows } = await this.client().query(`${BOOKING_SELECT} WHERE b.id IN (SELECT booking_id FROM booking_trips WHERE service_date = $1) ORDER BY b.id`, [date]);
    return rows.map(booking);
  }
  async vanGroupsOnDate(date: string): Promise<VanGroup[]> {
    return (await this.client().query(`SELECT ${VAN_GROUP_JSON} AS g FROM van_groups g WHERE service_date = $1 ORDER BY route_id, number`, [date])).rows.map((r) => vanGroup(r.g));
  }
  /** The day's marks: those on its groups, and the return-only ones dated that day. */
  async vanJobSends(date: string): Promise<VanJobSend[]> {
    const { rows } = await this.client().query(`SELECT s.group_id, s.service_date::text AS service_date, s.route_id, s.van_id, s.sent_at, s.sent_by, s.fingerprint
      FROM van_job_sends s LEFT JOIN van_groups g ON g.id = s.group_id WHERE g.service_date = $1 OR s.service_date = $1 ORDER BY s.id`, [date]);
    return rows.map((r) => ({
      group_id: r.group_id ?? null, service_date: r.service_date ?? null, route_id: r.route_id ?? null, van_id: r.van_id ?? null,
      sent_at: (r.sent_at as Date).toISOString(), sent_by: r.sent_by ?? null, fingerprint: r.fingerprint ?? null,
    }));
  }
  /** Replaces the job's mark (a job is one group, or one date, route and van). */
  async putVanJobSend(s: VanJobSend): Promise<void> {
    await this.deleteVanJobSend(s);
    await this.client().query('INSERT INTO van_job_sends (group_id, service_date, route_id, van_id, sent_at, sent_by, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [s.group_id, s.service_date, s.route_id, s.van_id, s.sent_at, s.sent_by, s.fingerprint]);
  }
  async deleteVanJobSend(s: Pick<VanJobSend, 'group_id' | 'service_date' | 'route_id' | 'van_id'>): Promise<void> {
    if (s.group_id) await this.client().query('DELETE FROM van_job_sends WHERE group_id = $1', [s.group_id]);
    else await this.client().query('DELETE FROM van_job_sends WHERE group_id IS NULL AND service_date = $1 AND route_id = $2 AND van_id = $3', [s.service_date, s.route_id, s.van_id]);
  }
  async pickupNamesTh(): Promise<PickupNameTh[]> {
    const { rows } = await this.client().query('SELECT name_key, name, name_th, updated_at, updated_by FROM pickup_name_th ORDER BY name_key');
    return rows.map((r) => ({ name_key: r.name_key, name: r.name, name_th: r.name_th, updated_at: (r.updated_at as Date).toISOString(), updated_by: r.updated_by ?? null }));
  }
  async putPickupNameTh(n: PickupNameTh): Promise<void> {
    await this.client().query(`INSERT INTO pickup_name_th (name_key, name, name_th, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (name_key) DO UPDATE SET name = EXCLUDED.name, name_th = EXCLUDED.name_th, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [n.name_key, n.name, n.name_th, n.updated_at, n.updated_by]);
  }
  async deletePickupNameTh(nameKey: string): Promise<boolean> {
    return (await this.client().query('DELETE FROM pickup_name_th WHERE name_key = $1', [nameKey])).rowCount === 1;
  }

  // ── Partner van bills, van rates, the daily report's settings (migration 120) ──
  private async vanBillsWhere(where: string, params: unknown[]): Promise<StoredVanBill[]> {
    const { rows } = await this.client().query(`SELECT b.*, b.paid_on::text AS paid_on,
        COALESCE((SELECT jsonb_object_agg(r.code, r.rate) FROM van_bill_route_rates r WHERE r.bill_id = b.id), '{}'::jsonb) AS route_rates,
        COALESCE((SELECT jsonb_object_agg(o.row_key, jsonb_build_object('rate', o.rate, 'ex', o.ex, 'cut', o.cut, 'per', o.per)) FROM van_bill_row_overrides o WHERE o.bill_id = b.id), '{}'::jsonb) AS row_overrides,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'date', x.line_date::text, 'note', x.note, 'vans', x.vans, 'pax', x.pax, 'rate', x.rate,
          'ex', x.ex, 'cut', x.cut, 'per_pax', x.per_pax) ORDER BY x.seq) FROM van_bill_extra_lines x WHERE x.bill_id = b.id), '[]'::jsonb) AS extra_lines
      FROM van_bills b WHERE ${where} ORDER BY b.partner COLLATE "C"`, params);
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return rows.map((r): StoredVanBill => ({
      id: String(r.id), partner: String(r.partner), month: String(r.month), period: Number(r.period) as StoredVanBill['period'],
      per_pax: Number(r.per_pax), rate: Number(r.rate),
      route_rates: Object.fromEntries(Object.entries(r.route_rates as Record<string, unknown>).map(([k, v]) => [k, Number(v)])),
      row_overrides: Object.fromEntries(Object.entries(r.row_overrides as Record<string, Record<string, unknown>>)
        .map(([k, o]) => [k, { rate: num(o.rate), ex: num(o.ex), cut: num(o.cut), per: num(o.per) }])),
      extra_lines: (r.extra_lines as Record<string, unknown>[]).map((x) => ({
        id: String(x.id), date: (x.date as string | null) ?? null, note: (x.note as string | null) ?? null, vans: Number(x.vans), pax: Number(x.pax),
        rate: Number(x.rate), ex: Number(x.ex), cut: Number(x.cut), per_pax: Number(x.per_pax),
      })),
      seen: (r.seen as string[] | null) ?? null, updated_at: r.updated_at ? asIso(r.updated_at) : null, updated_by: r.updated_by ?? null,
      sent_at: r.sent_at ? asIso(r.sent_at) : null, sent_by: r.sent_by ?? null, sent_bill: num(r.sent_bill),
      paid_at: r.paid_at ? asIso(r.paid_at) : null, paid_by: r.paid_by ?? null, paid_on: r.paid_on ?? null, paid_via: r.paid_via ?? null,
      paid_ref: r.paid_ref ?? null, paid_amount: num(r.paid_amount),
    }));
  }
  async vanBill(partner: string, month: string, period: number): Promise<StoredVanBill | undefined> {
    return (await this.vanBillsWhere('b.partner = $1 AND b.month = $2 AND b.period = $3', [partner, month, period]))[0];
  }
  async vanBillsOf(month: string, period: number): Promise<StoredVanBill[]> { return this.vanBillsWhere('b.month = $1 AND b.period = $2', [month, period]); }
  /** Upserts the bill on its address and replaces its rates, overrides and lines. */
  async putVanBill(b: StoredVanBill): Promise<void> {
    const { rows: [saved] } = await this.client().query(`INSERT INTO van_bills (id, partner, month, period, per_pax, rate, seen, updated_at, updated_by,
        sent_at, sent_by, sent_bill, paid_at, paid_by, paid_on, paid_via, paid_ref, paid_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (partner, month, period) DO UPDATE SET per_pax = EXCLUDED.per_pax, rate = EXCLUDED.rate, seen = EXCLUDED.seen,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, sent_at = EXCLUDED.sent_at, sent_by = EXCLUDED.sent_by, sent_bill = EXCLUDED.sent_bill,
        paid_at = EXCLUDED.paid_at, paid_by = EXCLUDED.paid_by, paid_on = EXCLUDED.paid_on, paid_via = EXCLUDED.paid_via, paid_ref = EXCLUDED.paid_ref, paid_amount = EXCLUDED.paid_amount
      RETURNING id`,
    [b.id, b.partner, b.month, b.period, b.per_pax, b.rate, b.seen, b.updated_at, b.updated_by, b.sent_at, b.sent_by, b.sent_bill,
      b.paid_at, b.paid_by, b.paid_on, b.paid_via, b.paid_ref, b.paid_amount]);
    const id = String(saved.id);
    for (const table of ['van_bill_route_rates', 'van_bill_row_overrides', 'van_bill_extra_lines']) await this.client().query(`DELETE FROM ${table} WHERE bill_id = $1`, [id]);
    await this.client().query(`INSERT INTO van_bill_route_rates (bill_id, code, rate) SELECT $1, r.key, r.value::numeric FROM jsonb_each_text($2::jsonb) AS r`,
      [id, JSON.stringify(b.route_rates)]);
    await this.client().query(`INSERT INTO van_bill_row_overrides (bill_id, row_key, rate, ex, cut, per)
      SELECT $1, o.key, (o.value->>'rate')::numeric, (o.value->>'ex')::numeric, (o.value->>'cut')::numeric, (o.value->>'per')::numeric FROM jsonb_each($2::jsonb) AS o`,
    [id, JSON.stringify(b.row_overrides)]);
    await this.client().query(`INSERT INTO van_bill_extra_lines (bill_id, id, seq, line_date, note, vans, pax, rate, ex, cut, per_pax)
      SELECT $1, x.id, x.seq, x.date, x.note, x.vans, x.pax, x.rate, x.ex, x.cut, x.per_pax
      FROM jsonb_to_recordset($2::jsonb) AS x(id text, seq int, date date, note text, vans int, pax int, rate numeric, ex numeric, cut numeric, per_pax numeric)`,
    [id, JSON.stringify(b.extra_lines.map((x, seq) => ({ ...x, seq })))]);
  }
  async vanRates(): Promise<VanRate[]> {
    const { rows } = await this.client().query(`SELECT group_key, route_id, field, rate, updated_at, updated_by FROM van_rates
      ORDER BY group_key COLLATE "C", COALESCE(route_id, '') COLLATE "C", field COLLATE "C"`);
    return rows.map((r) => ({ group_key: r.group_key, route_id: r.route_id ?? null, field: r.field, rate: Number(r.rate), updated_at: r.updated_at ? asIso(r.updated_at) : null, updated_by: r.updated_by ?? null }));
  }
  async putVanRate(r: VanRate): Promise<void> {
    await this.client().query(`INSERT INTO van_rates (group_key, route_id, field, rate, updated_at, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (group_key, route_id, field) DO UPDATE SET rate = EXCLUDED.rate, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [r.group_key, r.route_id, r.field, r.rate, r.updated_at, r.updated_by]);
  }
  async deleteVanRate(groupKey: string, routeId: string | null, field: VanRateField): Promise<boolean> {
    return ((await this.client().query('DELETE FROM van_rates WHERE group_key = $1 AND route_id IS NOT DISTINCT FROM $2 AND field = $3', [groupKey, routeId, field])).rowCount ?? 0) > 0;
  }
  async dailyReportSettings(): Promise<DailySettings | undefined> {
    const { rows: [r] } = await this.client().query('SELECT van_cost, van_quota, target_per_pax, updated_at, updated_by FROM daily_report_settings');
    return r && { van_cost: r.van_cost === null ? null : Number(r.van_cost), van_quota: r.van_quota ?? null, target_per_pax: r.target_per_pax === null ? null : Number(r.target_per_pax),
      updated_at: r.updated_at ? asIso(r.updated_at) : null, updated_by: r.updated_by ?? null };
  }
  async putDailyReportSettings(s: DailySettings): Promise<void> {
    await this.client().query(`INSERT INTO daily_report_settings (id, van_cost, van_quota, target_per_pax, updated_at, updated_by) VALUES (true, $1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET van_cost = EXCLUDED.van_cost, van_quota = EXCLUDED.van_quota, target_per_pax = EXCLUDED.target_per_pax,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`, [s.van_cost, s.van_quota, s.target_per_pax, s.updated_at, s.updated_by]);
  }
  async deleteVanGroup(id: string): Promise<void> { await this.client().query('DELETE FROM van_groups WHERE id = $1', [id]); }
  /** `[]` is no rows: one whole, ungrouped part. */
  async setVanParts(tripId: string, parts: readonly StoredVanPart[]): Promise<void> {
    await this.client().query('DELETE FROM booking_trip_van_allocations WHERE booking_trip_id = $1', [tripId]);
    for (const p of parts) {
      await this.client().query(`INSERT INTO booking_trip_van_allocations (booking_trip_id, idx, ad, chd, inf, foc, van_group_id, sequence, return_van_id, source,
          pick_area_id, pick_hotel, pick_zone, drop_area_id, drop_hotel, drop_zone, pick_time, alt_who) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [tripId, p.idx, p.ad, p.chd, p.inf, p.foc, p.group_id, p.sequence, p.return_van_id, p.source,
          p.alt?.pick_area_id ?? null, p.alt?.pick_hotel ?? null, p.alt?.pick_zone ?? null, p.alt?.drop_area_id ?? null, p.alt?.drop_hotel ?? null, p.alt?.drop_zone ?? null, p.alt?.pick_time ?? null, p.alt?.alt_who ?? null]);
    }
  }
  /** Sets some of a trip's dispatch fields; a new final pickup is a plain time, with no window. */
  async patchDispatch(tripId: string, fields: { pickup_time_final?: string | null; return_same_van?: boolean }): Promise<void> {
    await this.client().query('INSERT INTO booking_trip_operations (booking_trip_id) VALUES ($1) ON CONFLICT (booking_trip_id) DO NOTHING', [tripId]);
    if (fields.pickup_time_final !== undefined) {
      await this.client().query('UPDATE booking_trip_operations SET pickup_time_final = $2, pickup_time_final_end = NULL, pickup_final_at_pier = false WHERE booking_trip_id = $1', [tripId, fields.pickup_time_final]);
    }
    if (fields.return_same_van !== undefined) await this.client().query('UPDATE booking_trip_operations SET return_same_van = $2 WHERE booking_trip_id = $1', [tripId, fields.return_same_van]);
  }

  // ── Vans and the month matrix (migration 016, slice A3) ──
  async listVans(): Promise<Van[]> { return (await this.client().query(`${VAN_SELECT} ORDER BY id`)).rows.map(vanRow); }
  async van(id: string): Promise<Van | undefined> { const { rows: [row] } = await this.client().query(`${VAN_SELECT} WHERE id = $1`, [id]); return row && vanRow(row); }
  async createVan(input: VanInput): Promise<Van> {
    // Ids are numbered like legacy's; the lock keeps two concurrent creates from taking the same one.
    await this.client().query("SELECT pg_advisory_xact_lock(hashtext('vans'))");
    const id = nextVanId((await this.client().query('SELECT id FROM vans')).rows.map((r) => r.id as string));
    await this.writeVan({ id, ...input }, true);
    return (await this.van(id))!;
  }
  async updateVan(id: string, patch: VanPatch): Promise<Van | undefined> {
    const van = await this.van(id);
    if (!van) return undefined;
    await this.writeVan(applyVanPatch(van, patch), false);
    return this.van(id);
  }
  private async writeVan(v: Van, insert: boolean): Promise<void> {
    const values = [v.id, v.name, v.plate, v.type, v.capacity, v.ownership, v.partner_name, v.zone_base, v.color, v.driver, v.driver_phone, v.active, v.note];
    await this.client().query(insert
      ? 'INSERT INTO vans (id, name, plate, type, capacity, ownership, partner_name, zone_base, color, driver, driver_phone, active, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
      : 'UPDATE vans SET name = $2, plate = $3, type = $4, capacity = $5, ownership = $6, partner_name = $7, zone_base = $8, color = $9, driver = $10, driver_phone = $11, active = $12, note = $13 WHERE id = $1', values);
  }
  async vanStatusRanges(vanId?: string): Promise<VanStatusRange[]> {
    return (await this.client().query(`${RANGE_SELECT} WHERE $1::text IS NULL OR van_id = $1 ORDER BY van_id, id`, [vanId ?? null])).rows.map(rangeRow);
  }
  async addStatusRange(vanId: string, input: VanStatusRangeInput): Promise<VanStatusRange> {
    const { rows: [row] } = await this.client().query('INSERT INTO van_status_ranges (van_id, status, from_date, to_date, note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [vanId, input.status, input.from_date, input.to_date, input.note]);
    return { id: Number(row.id), van_id: vanId, ...input };
  }
  async putStatusRange(r: VanStatusRange): Promise<void> {
    await this.client().query('UPDATE van_status_ranges SET status = $2, from_date = $3, to_date = $4, note = $5 WHERE id = $1', [r.id, r.status, r.from_date, r.to_date, r.note]);
  }
  async deleteStatusRange(vanId: string, id: number): Promise<boolean> {
    return (await this.client().query('DELETE FROM van_status_ranges WHERE van_id = $1 AND id = $2', [vanId, id])).rowCount === 1;
  }
  async vanDays(from: string, to: string): Promise<StoredVanDay[]> { return this.readVanDays('service_date BETWEEN $1 AND $2', [from, to]); }
  async vanDay(vanId: string, date: string): Promise<StoredVanDay | undefined> { return (await this.readVanDays('van_id = $1 AND service_date = $2', [vanId, date]))[0]; }
  /** A cell is a van_days row and its van_day_routes; both are rewritten, and nothing is left for an empty cell. */
  private async readVanDays(where: string, params: unknown[]): Promise<StoredVanDay[]> {
    const { rows } = await this.client().query(`
      SELECT van_id, service_date::text AS service_date,
        COALESCE((SELECT array_agg(r.route_id ORDER BY r.route_id) FROM van_day_routes r WHERE r.van_id = c.van_id AND r.service_date = c.service_date), '{}') AS route_ids,
        d.status, d.zone, d.driver, d.driver_phone, d.plate
      FROM (SELECT van_id, service_date FROM van_days WHERE ${where} UNION SELECT van_id, service_date FROM van_day_routes WHERE ${where}) c
      LEFT JOIN van_days d USING (van_id, service_date)
      ORDER BY van_id, service_date`, params);
    return rows.map((r) => ({
      van_id: r.van_id, service_date: r.service_date, route_ids: r.route_ids, status: r.status ?? null, zone: r.zone ?? null, driver: r.driver ?? null,
      driver_phone: r.driver_phone ?? null, plate: r.plate ?? null,
    }));
  }
  async setVanDay(day: StoredVanDay): Promise<void> {
    const key = [day.van_id, day.service_date];
    await this.client().query('DELETE FROM van_day_routes WHERE van_id = $1 AND service_date = $2', key);
    for (const routeId of day.route_ids) await this.client().query('INSERT INTO van_day_routes (van_id, service_date, route_id) VALUES ($1,$2,$3)', [...key, routeId]);
    const { route_ids: _r, ...fields } = day;
    if (isEmptyVanDay({ ...day, route_ids: [] })) { await this.client().query('DELETE FROM van_days WHERE van_id = $1 AND service_date = $2', key); return; }
    await this.client().query(`INSERT INTO van_days (van_id, service_date, status, zone, driver, driver_phone, plate) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (van_id, service_date) DO UPDATE SET status = EXCLUDED.status, zone = EXCLUDED.zone, driver = EXCLUDED.driver, driver_phone = EXCLUDED.driver_phone,
        plate = EXCLUDED.plate`, [...key, fields.status, fields.zone, fields.driver, fields.driver_phone, fields.plate]);
  }

  /** A van no group uses (outbound, return, or a part's return van) and with no day in the matrix. */
  async vanInUse(id: string): Promise<boolean> {
    const { rows: [row] } = await this.client().query(`SELECT
      EXISTS (SELECT 1 FROM van_groups WHERE van_id = $1 OR return_van_id = $1)
      OR EXISTS (SELECT 1 FROM booking_trip_van_allocations WHERE return_van_id = $1)
      OR EXISTS (SELECT 1 FROM van_days WHERE van_id = $1) OR EXISTS (SELECT 1 FROM van_day_routes WHERE van_id = $1) AS used`, [id]);
    return row.used === true;
  }
  /** Its log, status ranges and zone ranges go with it (ON DELETE CASCADE). */
  async deleteVan(id: string): Promise<boolean> { return (await this.client().query('DELETE FROM vans WHERE id = $1', [id])).rowCount === 1; }

  async vanZoneRanges(vanId?: string): Promise<VanZoneRange[]> {
    const { rows } = await this.client().query(`SELECT id, van_id, zone, from_date::text AS from_date, to_date::text AS to_date FROM van_zone_ranges
      WHERE $1::text IS NULL OR van_id = $1 ORDER BY van_id, id`, [vanId ?? null]);
    return rows.map((r) => ({ id: Number(r.id), van_id: r.van_id, zone: r.zone, from_date: r.from_date ?? null, to_date: r.to_date ?? null }));
  }
  async addZoneRange(vanId: string, input: VanZoneRangeInput): Promise<VanZoneRange> {
    const { rows: [row] } = await this.client().query('INSERT INTO van_zone_ranges (van_id, zone, from_date, to_date) VALUES ($1,$2,$3,$4) RETURNING id', [vanId, input.zone, input.from_date, input.to_date]);
    return { id: Number(row.id), van_id: vanId, ...input };
  }
  async putZoneRange(r: VanZoneRange): Promise<void> {
    await this.client().query('UPDATE van_zone_ranges SET zone = $2, from_date = $3, to_date = $4 WHERE id = $1', [r.id, r.zone, r.from_date, r.to_date]);
  }
  async deleteZoneRange(vanId: string, id: number): Promise<boolean> {
    return (await this.client().query('DELETE FROM van_zone_ranges WHERE van_id = $1 AND id = $2', [vanId, id])).rowCount === 1;
  }

  /** Appends lines in order; the serial id keeps the order of lines written together. */
  async addVanLog(vanId: string, entries: readonly VanLogEntry[]): Promise<void> {
    for (const e of entries) await this.client().query('INSERT INTO van_log (van_id, at, kind, text, by) VALUES ($1,$2,$3,$4,$5)', [vanId, e.at, e.kind, e.text, e.by]);
  }
  /** Newest first. */
  async vanLog(vanId: string, limit: number): Promise<VanLogEntry[]> {
    const { rows } = await this.client().query('SELECT at, kind, text, by FROM van_log WHERE van_id = $1 ORDER BY id DESC LIMIT $2', [vanId, limit]);
    return rows.map((r) => ({ at: (r.at as Date).toISOString(), kind: r.kind, text: r.text, by: r.by ?? null }));
  }

  // ── Van stops (migration 034) ──
  async vanStopsOn(date: string, routeId?: string): Promise<VanStop[]> {
    return (await this.client().query(`${STOP_SELECT} WHERE service_date = $1 AND ($2::text IS NULL OR route_id = $2)`, [date, routeId ?? null])).rows.map(stopRow);
  }
  async vanStop(id: string): Promise<VanStop | undefined> {
    const { rows: [row] } = await this.client().query(`${STOP_SELECT} WHERE id = $1`, [id]);
    return row && stopRow(row);
  }
  async writeVanStop(x: VanStop): Promise<void> {
    await this.client().query(`INSERT INTO van_stops (id, service_date, route_id, group_id, kind, label, pax, time, place, area_id, area, leg, phone, note, sequence,
        checked_at, checked_by, checked_seats, created_at, created_by, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (id) DO UPDATE SET service_date = EXCLUDED.service_date, route_id = EXCLUDED.route_id, group_id = EXCLUDED.group_id, kind = EXCLUDED.kind,
        label = EXCLUDED.label, pax = EXCLUDED.pax, time = EXCLUDED.time, place = EXCLUDED.place, area_id = EXCLUDED.area_id, area = EXCLUDED.area,
        leg = EXCLUDED.leg, phone = EXCLUDED.phone, note = EXCLUDED.note, sequence = EXCLUDED.sequence, checked_at = EXCLUDED.checked_at,
        checked_by = EXCLUDED.checked_by, checked_seats = EXCLUDED.checked_seats, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [x.id, x.service_date, x.route_id, x.group_id, x.kind, x.label, x.pax, x.time, x.place, x.area_id, x.area, x.leg, x.phone, x.note, x.sequence,
        x.checked_in?.at ?? null, x.checked_in?.by ?? null, x.checked_in?.seats ?? null, x.created_at, x.created_by, x.updated_at, x.updated_by]);
  }
  async deleteVanStop(id: string): Promise<boolean> { return (await this.client().query('DELETE FROM van_stops WHERE id = $1', [id])).rowCount === 1; }

  /** Replaces one check-in record, its events and their tries. */
  async setCheckin(tripId: string, r: StoredCheckin): Promise<void> {
    await this.deleteCheckin(tripId, r.kind, r.slot);
    const key = [tripId, r.kind, r.slot];
    await this.client().query(`INSERT INTO booking_trip_checkins (booking_trip_id, kind, slot, expected, actual_pax, checked_in_at, checked_in_by,
        reason_code, reason_note, reason_at, arrived_at, arrived_by, cleared_at, cleared_by, flow, flow_at, flow_by, flow_note,
        reinstate_at, reinstate_by, reinstate_ts, self_add_pax, self_add_ad, self_add_chd, self_add_inf, self_add_foc, self_add_at, self_add_by, self_add_ts, self_add_note,
        updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [...key, r.expected, r.actual_pax, r.checked_in_at, r.checked_in_by, r.reason_code, r.reason_note, r.reason_at, r.arrived_at, r.arrived_by,
        r.cleared_at, r.cleared_by, r.flow, r.flow_at, r.flow_by, r.flow_note, r.reinstate?.at ?? null, r.reinstate?.by ?? null, r.reinstate?.ts ?? null,
        r.self_add?.pax ?? null, r.self_add?.ad ?? null, r.self_add?.chd ?? null, r.self_add?.inf ?? null, r.self_add?.foc ?? null,
        r.self_add?.at ?? null, r.self_add?.by ?? null, r.self_add?.ts ?? null, r.self_add?.note ?? null, r.updated_at, r.updated_by]);
    for (const [seq, e] of r.events.entries()) {
      await this.client().query(`INSERT INTO booking_trip_checkin_events (booking_trip_id, kind, slot, seq, type, pax, ad, chd, inf, foc, reason_code, note, at, by, ts,
          undone_why, undone_at, undone_by, undone_ts, undone_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [...key, seq, e.type, e.pax, e.ad, e.chd, e.inf, e.foc, e.reason_code, e.note, e.at, e.by, e.ts,
          e.undone?.why ?? null, e.undone?.at ?? null, e.undone?.by ?? null, e.undone?.ts ?? null, e.undone?.note ?? null]);
      for (const [trySeq, x] of e.tries.entries()) {
        await this.client().query('INSERT INTO booking_trip_checkin_event_tries (booking_trip_id, kind, slot, event_seq, seq, at, by, note, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [...key, seq, trySeq, x.at, x.by, x.note, x.ts]);
      }
    }
  }
  async deleteCheckin(tripId: string, kind: CheckinKind, slot: number): Promise<boolean> {
    return (await this.client().query('DELETE FROM booking_trip_checkins WHERE booking_trip_id = $1 AND kind = $2 AND slot = $3', [tripId, kind, slot])).rowCount === 1;
  }

  // ── Attachments (migration 040) ──
  // ── Invoices and payments (migration 045) ──
  /**
   * The next number of the month. The counter row serializes two issues at once; the highest number
   * already issued keeps it ahead of an import.
   */
  async nextInvoiceNumber(month: string): Promise<number> {
    const { rows: [r] } = await this.client().query(`WITH issued AS (
        SELECT COALESCE(max((regexp_match(number, '^INV-[0-9]{4}-([0-9]+)'))[1]::int), 0) AS n FROM invoices WHERE number LIKE 'INV-' || $1 || '-%')
      INSERT INTO invoice_number_counters (year_month, last) SELECT $1, n + 1 FROM issued
      ON CONFLICT (year_month) DO UPDATE SET last = GREATEST(invoice_number_counters.last, (SELECT n FROM issued)) + 1
      RETURNING last`, [month]);
    return Number(r.last);
  }
  async putInvoice(i: StoredInvoice): Promise<void> {
    await this.client().query(`INSERT INTO invoices (id, number, agent_id, kind, fee_type, vat_mode, vat_rate, subtotal, net_amount, vat_amount, total, wht_amount,
        issued_at, due_at, note, ref, dear, accept_at, remark, voided, voided_at, voided_by, void_reason, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      ON CONFLICT (id) DO UPDATE SET subtotal = EXCLUDED.subtotal, net_amount = EXCLUDED.net_amount, vat_amount = EXCLUDED.vat_amount, total = EXCLUDED.total,
        wht_amount = EXCLUDED.wht_amount, note = EXCLUDED.note, ref = EXCLUDED.ref, dear = EXCLUDED.dear, accept_at = EXCLUDED.accept_at, remark = EXCLUDED.remark,
        voided = EXCLUDED.voided, voided_at = EXCLUDED.voided_at, voided_by = EXCLUDED.voided_by, void_reason = EXCLUDED.void_reason`,
    [i.id, i.number, i.agent_id, i.kind, i.fee_type, i.vat_mode, i.vat_rate, i.subtotal, i.net_amount, i.vat_amount, i.total, i.wht_amount,
      i.issued_at, i.due_at, i.note, i.ref, i.dear, i.accept_at, i.remark, i.voided, i.voided_at, i.voided_by, i.void_reason, i.created_by]);
    await this.client().query('DELETE FROM invoice_lines WHERE invoice_id = $1', [i.id]);
    await this.client().query(`INSERT INTO invoice_lines (invoice_id, seq, booking_id, label, amount, discount, removed_at, removed_by, removed_reason, cot_date)
      SELECT $1, l.seq, l.booking_id, l.label, l.amount, l.discount, l.removed_at, l.removed_by, l.removed_reason, l.cot_date
      FROM jsonb_to_recordset($2::jsonb) AS l(seq int, booking_id text, label text, amount numeric, discount numeric, removed_at timestamptz, removed_by text, removed_reason text, cot_date date)`,
    [i.id, JSON.stringify(i.lines)]);
  }
  private async invoicesWhere(where: string, params: unknown[]): Promise<StoredInvoice[]> {
    const { rows } = await this.client().query(`SELECT i.*, i.accept_at::text AS accept_at, COALESCE((SELECT jsonb_agg(jsonb_build_object('seq', l.seq, 'booking_id', l.booking_id,
        'label', l.label, 'amount', l.amount, 'discount', l.discount, 'removed_at', l.removed_at, 'removed_by', l.removed_by, 'removed_reason', l.removed_reason,
        'cot_date', l.cot_date::text) ORDER BY l.seq)
        FROM invoice_lines l WHERE l.invoice_id = i.id), '[]'::jsonb) AS lines
      FROM invoices i WHERE ${where} ORDER BY i.issued_at, i.id`, params);
    return rows.map(storedInvoice);
  }
  async invoice(id: string): Promise<StoredInvoice | undefined> { return (await this.invoicesWhere('i.id = $1', [id]))[0]; }
  /** Oldest first. */
  async listInvoices(q: { agentId?: string; bookingId?: string } = {}): Promise<StoredInvoice[]> {
    return this.invoicesWhere('($1::text IS NULL OR i.agent_id = $1) AND ($2::text IS NULL OR i.id IN (SELECT invoice_id FROM invoice_lines WHERE booking_id = $2))',
      [q.agentId ?? null, q.bookingId ?? null]);
  }
  async invoicesOfBookings(ids: readonly string[]): Promise<StoredInvoice[]> {
    return this.invoicesWhere('i.id IN (SELECT invoice_id FROM invoice_lines WHERE booking_id = ANY($1::text[]))', [ids]);
  }
  async putPayment(p: StoredPayment): Promise<void> {
    await this.client().query(`INSERT INTO payments (id, invoice_id, amount, method, paid_on, ref, recorded_by, recorded_at, deleted_at, deleted_by, delete_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET amount = EXCLUDED.amount, method = EXCLUDED.method, paid_on = EXCLUDED.paid_on, ref = EXCLUDED.ref,
        deleted_at = EXCLUDED.deleted_at, deleted_by = EXCLUDED.deleted_by, delete_reason = EXCLUDED.delete_reason`,
    [p.id, p.invoice_id, p.amount, p.method, p.paid_on, p.ref, p.recorded_by, p.recorded_at, p.deleted_at, p.deleted_by, p.delete_reason]);
    await this.client().query('DELETE FROM payment_slips WHERE payment_id = $1', [p.id]);
    await this.client().query(`INSERT INTO payment_slips (payment_id, seq, attachment_id) SELECT $1, s.ordinality - 1, s.id
      FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS s(id, ordinality)`, [p.id, JSON.stringify(p.slips)]);
  }
  /** Deleted ones too, oldest first. */
  async paymentsOf(invoiceIds: readonly string[]): Promise<StoredPayment[]> {
    const { rows } = await this.client().query(`SELECT p.*, p.paid_on::text AS paid_on,
        COALESCE((SELECT jsonb_agg(s.attachment_id ORDER BY s.seq) FROM payment_slips s WHERE s.payment_id = p.id), '[]'::jsonb) AS slips
      FROM payments p WHERE p.invoice_id = ANY($1::text[]) ORDER BY p.recorded_at, p.id`, [invoiceIds]);
    return rows.map((r): StoredPayment => ({
      id: String(r.id), invoice_id: String(r.invoice_id), amount: Number(r.amount), method: r.method, paid_on: String(r.paid_on), ref: r.ref ?? null,
      recorded_by: r.recorded_by ?? null, recorded_at: asIso(r.recorded_at), deleted_at: r.deleted_at ? asIso(r.deleted_at) : null,
      deleted_by: r.deleted_by ?? null, delete_reason: r.delete_reason ?? null, slips: (r.slips as string[]) ?? [],
    }));
  }

  // ── Refunds and credits (migration 061) ──
  async putRefund(r: StoredRefund): Promise<void> {
    await this.client().query(`INSERT INTO refunds (id, kind, invoice_id, booking_id, agent_id, amount, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, r.kind, r.invoice_id, r.booking_id, r.agent_id, r.amount, r.reason, r.created_by, r.created_at]);
  }
  /** Oldest first. */
  async listRefunds(q: { invoiceIds?: readonly string[]; agentId?: string; bookingId?: string } = {}): Promise<StoredRefund[]> {
    const { rows } = await this.client().query(`SELECT * FROM refunds WHERE ($1::text[] IS NULL OR invoice_id = ANY($1::text[]))
      AND ($2::text IS NULL OR agent_id = $2) AND ($3::text IS NULL OR booking_id = $3) ORDER BY created_at, id COLLATE "C"`, [q.invoiceIds ? [...q.invoiceIds] : null, q.agentId ?? null, q.bookingId ?? null]);
    return rows.map(storedRefund);
  }

  // ── Weather closures (migration 060) ──
  async listWeatherClosures(q: Partial<ClosureListQuery> = {}): Promise<WeatherClosure[]> {
    const { rows } = await this.client().query(`SELECT ${WEATHER_CLOSURE_COLUMNS} FROM weather_closures
      WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) AND ($3::text IS NULL OR route_id = $3) AND ($4 OR reopened_at IS NULL)
      ORDER BY service_date, route_id COLLATE "C", closed_at, id COLLATE "C"`, [q.from ?? null, q.to ?? null, q.route_id ?? null, q.include_reopened === true]);
    return rows.map(weatherClosureRow);
  }
  async weatherClosure(id: string): Promise<WeatherClosure | undefined> {
    const { rows: [row] } = await this.client().query(`SELECT ${WEATHER_CLOSURE_COLUMNS} FROM weather_closures WHERE id = $1`, [id]);
    return row && weatherClosureRow(row);
  }
  /** One open closure per trip: the unique index's refusal is the same `409` the route gives. */
  async putWeatherClosure(c: WeatherClosure): Promise<void> {
    try {
      await this.client().query(`INSERT INTO weather_closures (id, route_id, service_date, note, closed_by, closed_at, updated_by, updated_at, reopened_by, reopened_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at,
          reopened_by = EXCLUDED.reopened_by, reopened_at = EXCLUDED.reopened_at`,
      [c.id, c.route_id, c.service_date, c.note, c.closed_by, c.closed_at, c.updated_by, c.updated_at, c.reopened_by, c.reopened_at]);
    } catch (error) {
      // Only a close racing another one gets here (the route checks first); the transaction is aborted, so nothing more is read.
      if ((error as { constraint?: string }).constraint !== 'weather_closures_open') throw error;
      refuse(`${c.route_id} on ${c.service_date} is already closed for weather`, 409, 'already_closed');
    }
  }
  /** By booking id. */
  async weatherCases(closureId: string): Promise<WeatherCase[]> {
    return (await this.client().query(`SELECT ${WEATHER_CASE_COLUMNS} FROM weather_cases WHERE closure_id = $1 ORDER BY booking_id COLLATE "C"`, [closureId])).rows.map(weatherCaseRow);
  }
  async weatherCasesOfBooking(bookingId: string): Promise<WeatherCase[]> {
    return (await this.client().query(`SELECT ${WEATHER_CASE_COLUMNS} FROM weather_cases WHERE booking_id = $1 ORDER BY closure_id COLLATE "C"`, [bookingId])).rows.map(weatherCaseRow);
  }
  async putWeatherCase(r: WeatherCase): Promise<void> {
    await this.client().query(`INSERT INTO weather_cases (closure_id, booking_id, status, notified_at, notified_by, outcome, new_date, resolved_at, resolved_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (closure_id, booking_id) DO UPDATE SET status = EXCLUDED.status, notified_at = EXCLUDED.notified_at, notified_by = EXCLUDED.notified_by,
        outcome = EXCLUDED.outcome, new_date = EXCLUDED.new_date, resolved_at = EXCLUDED.resolved_at, resolved_by = EXCLUDED.resolved_by`,
    [r.closure_id, r.booking_id, r.status, r.notified_at, r.notified_by, r.outcome, r.new_date, r.resolved_at, r.resolved_by]);
  }
  async deleteWeatherCase(closureId: string, bookingId: string): Promise<void> {
    await this.client().query('DELETE FROM weather_cases WHERE closure_id = $1 AND booking_id = $2', [closureId, bookingId]);
  }

  // ── Money: proforma, pier money, after the trip (migrations 110–112) ──
  /** A command that writes beside the booking (a pier payment, a decision): the booking's version moves on. */
  async bumpBooking(id: string, actor?: string): Promise<void> { await this.touch(id, actor); }
  async pfmEvents(bookingIds: readonly string[]): Promise<PfmEvent[]> {
    const { rows } = await this.client().query('SELECT * FROM booking_pfm_events WHERE booking_id = ANY($1::text[]) ORDER BY at, id', [bookingIds]);
    return rows.map((r) => ({ id: Number(r.id), booking_id: String(r.booking_id), kind: r.kind, approver: r.approver ?? null, by: r.by ?? null, at: asIso(r.at) }));
  }
  async addPfmEvent(e: Omit<PfmEvent, 'id'>): Promise<void> {
    await this.client().query('INSERT INTO booking_pfm_events (booking_id, kind, approver, by, at) VALUES ($1,$2,$3,$4,$5)', [e.booking_id, e.kind, e.approver, e.by, e.at]);
  }
  private async pierPaymentsWhere(where: string, params: unknown[]): Promise<StoredPierPayment[]> {
    const { rows } = await this.client().query(`SELECT p.*, p.service_date::text AS day,
        COALESCE((SELECT jsonb_agg(s.attachment_id ORDER BY s.seq) FROM booking_pier_payment_slips s WHERE s.payment_id = p.id), '[]'::jsonb) AS slips
      FROM booking_pier_payments p WHERE ${where} ORDER BY p.at, p.id COLLATE "C"`, params);
    return rows.map((r): StoredPierPayment => ({
      id: String(r.id), booking_id: String(r.booking_id), service_date: String(r.day), method: r.method, amount: Number(r.amount), fee: Number(r.fee),
      fee_pct: r.fee_pct === null ? null : Number(r.fee_pct), note: r.note ?? null, by: r.by ?? null, at: asIso(r.at),
      deleted_at: r.deleted_at ? asIso(r.deleted_at) : null, deleted_by: r.deleted_by ?? null, delete_reason: r.delete_reason ?? null, slips: (r.slips as string[]) ?? [],
    }));
  }
  /** Deleted ones too, oldest first. */
  async pierPayments(bookingIds: readonly string[]): Promise<StoredPierPayment[]> { return this.pierPaymentsWhere('p.booking_id = ANY($1::text[])', [bookingIds]); }
  async putPierPayment(p: StoredPierPayment): Promise<void> {
    await this.client().query(`INSERT INTO booking_pier_payments (id, booking_id, service_date, method, amount, fee, fee_pct, note, by, at, deleted_at, deleted_by, delete_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at, deleted_by = EXCLUDED.deleted_by, delete_reason = EXCLUDED.delete_reason, note = EXCLUDED.note`,
    [p.id, p.booking_id, p.service_date, p.method, p.amount, p.fee, p.fee_pct, p.note, p.by, p.at, p.deleted_at, p.deleted_by, p.delete_reason]);
    await this.client().query('DELETE FROM booking_pier_payment_slips WHERE payment_id = $1', [p.id]);
    await this.client().query(`INSERT INTO booking_pier_payment_slips (payment_id, seq, attachment_id) SELECT $1, s.ordinality - 1, s.id
      FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS s(id, ordinality)`, [p.id, JSON.stringify(p.slips)]);
  }
  /** Oldest first. */
  async tourSales(bookingIds: readonly string[]): Promise<StoredTourSale[]> {
    const { rows } = await this.client().query(`SELECT t.*, t.trip_date::text AS day,
        COALESCE((SELECT jsonb_agg(s.attachment_id ORDER BY s.seq) FROM booking_tour_sale_slips s WHERE s.sale_id = t.id), '[]'::jsonb) AS slips
      FROM booking_tour_sales t WHERE t.booking_id = ANY($1::text[]) ORDER BY t.sold_at, t.id COLLATE "C"`, [bookingIds]);
    return rows.map((r): StoredTourSale => ({
      id: String(r.id), booking_id: String(r.booking_id), trip_date: r.day ?? null, service: String(r.service), qty: Number(r.qty), unit_price: Number(r.unit_price),
      to_company: Number(r.to_company), seller: r.seller ?? null, method: r.method, fee_pct: Number(r.fee_pct), fee: Number(r.fee),
      collected_at: r.collected_at ? asIso(r.collected_at) : null, collected_by: r.collected_by ?? null, sold_at: asIso(r.sold_at), sold_by: r.sold_by ?? null,
      slips: (r.slips as string[]) ?? [],
    }));
  }
  async putTourSale(s: StoredTourSale): Promise<void> {
    await this.client().query(`INSERT INTO booking_tour_sales (id, booking_id, trip_date, service, qty, unit_price, to_company, seller, method, fee_pct, fee,
        collected_at, collected_by, sold_at, sold_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET trip_date = EXCLUDED.trip_date, service = EXCLUDED.service, qty = EXCLUDED.qty, unit_price = EXCLUDED.unit_price,
        to_company = EXCLUDED.to_company, seller = EXCLUDED.seller, method = EXCLUDED.method, fee_pct = EXCLUDED.fee_pct, fee = EXCLUDED.fee,
        collected_at = EXCLUDED.collected_at, collected_by = EXCLUDED.collected_by`,
    [s.id, s.booking_id, s.trip_date, s.service, s.qty, s.unit_price, s.to_company, s.seller, s.method, s.fee_pct, s.fee, s.collected_at, s.collected_by, s.sold_at, s.sold_by]);
    await this.client().query('DELETE FROM booking_tour_sale_slips WHERE sale_id = $1', [s.id]);
    await this.client().query(`INSERT INTO booking_tour_sale_slips (sale_id, seq, attachment_id) SELECT $1, s.ordinality - 1, s.id
      FROM jsonb_array_elements_text($2::jsonb) WITH ORDINALITY AS s(id, ordinality)`, [s.id, JSON.stringify(s.slips)]);
  }
  async deleteTourSale(id: string): Promise<void> { await this.client().query('DELETE FROM booking_tour_sales WHERE id = $1', [id]); }
  async cotDecisions(bookingIds: readonly string[]): Promise<StoredCotDecision[]> {
    const { rows } = await this.client().query(`SELECT d.*, d.service_date::text AS day,
        COALESCE((SELECT jsonb_agg(s.attachment_id ORDER BY s.seq) FROM booking_cot_decision_slips s WHERE s.booking_id = d.booking_id AND s.service_date = d.service_date), '[]'::jsonb) AS slips
      FROM booking_cot_decisions d WHERE d.booking_id = ANY($1::text[]) ORDER BY d.booking_id COLLATE "C", d.service_date`, [bookingIds]);
    return rows.map((r): StoredCotDecision => ({
      booking_id: String(r.booking_id), service_date: String(r.day), mode: r.mode, deduct: Number(r.deduct), payout: Number(r.payout), ref: r.ref ?? null,
      by: r.by ?? null, at: asIso(r.at), slips: (r.slips as string[]) ?? [],
    }));
  }
  async putCotDecision(d: StoredCotDecision): Promise<void> {
    await this.client().query(`INSERT INTO booking_cot_decisions (booking_id, service_date, mode, deduct, payout, ref, by, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (booking_id, service_date) DO UPDATE SET mode = EXCLUDED.mode, deduct = EXCLUDED.deduct, payout = EXCLUDED.payout, ref = EXCLUDED.ref, by = EXCLUDED.by, at = EXCLUDED.at`,
    [d.booking_id, d.service_date, d.mode, d.deduct, d.payout, d.ref, d.by, d.at]);
    await this.client().query('DELETE FROM booking_cot_decision_slips WHERE booking_id = $1 AND service_date = $2', [d.booking_id, d.service_date]);
    await this.client().query(`INSERT INTO booking_cot_decision_slips (booking_id, service_date, seq, attachment_id) SELECT $1, $2, s.ordinality - 1, s.id
      FROM jsonb_array_elements_text($3::jsonb) WITH ORDINALITY AS s(id, ordinality)`, [d.booking_id, d.service_date, JSON.stringify(d.slips)]);
  }
  async deleteCotDecision(bookingId: string, date: string): Promise<boolean> {
    return ((await this.client().query('DELETE FROM booking_cot_decisions WHERE booking_id = $1 AND service_date = $2', [bookingId, date])).rowCount ?? 0) > 0;
  }
  async noshowCharges(bookingIds: readonly string[]): Promise<StoredNoshowCharge[]> {
    const { rows } = await this.client().query(`SELECT c.*, c.service_date::text AS day FROM booking_noshow_charges c WHERE c.booking_id = ANY($1::text[])
      ORDER BY c.booking_id COLLATE "C", c.service_date`, [bookingIds]);
    return rows.map((r): StoredNoshowCharge => ({ booking_id: String(r.booking_id), service_date: String(r.day), decision: r.decision, amount: Number(r.amount), note: r.note ?? null, by: r.by ?? null, at: asIso(r.at) }));
  }
  async putNoshowCharge(c: StoredNoshowCharge): Promise<void> {
    await this.client().query(`INSERT INTO booking_noshow_charges (booking_id, service_date, decision, amount, note, by, at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (booking_id, service_date) DO UPDATE SET decision = EXCLUDED.decision, amount = EXCLUDED.amount, note = EXCLUDED.note, by = EXCLUDED.by, at = EXCLUDED.at`,
    [c.booking_id, c.service_date, c.decision, c.amount, c.note, c.by, c.at]);
  }
  async deleteNoshowCharge(bookingId: string, date: string): Promise<boolean> {
    return ((await this.client().query('DELETE FROM booking_noshow_charges WHERE booking_id = $1 AND service_date = $2', [bookingId, date])).rowCount ?? 0) > 0;
  }
  /** By day, then pier, then when handed over. */
  async handovers(q: { from?: string; to?: string; pier?: string; ids?: readonly string[] } = {}): Promise<StoredHandover[]> {
    const { rows } = await this.client().query(`SELECT h.*, h.service_date::text AS day FROM pier_handovers h
      WHERE ($1::date IS NULL OR h.service_date >= $1) AND ($2::date IS NULL OR h.service_date <= $2) AND ($3::text IS NULL OR h.pier = $3) AND ($4::text[] IS NULL OR h.id = ANY($4))
      ORDER BY h.service_date, h.pier COLLATE "C", h.handed_at, h.id COLLATE "C"`, [q.from ?? null, q.to ?? null, q.pier ?? null, q.ids ? [...q.ids] : null]);
    return rows.map((r): StoredHandover => ({
      id: String(r.id), service_date: String(r.day), pier: String(r.pier), expected: r.expected as Takings, cash_counted: Number(r.cash_counted), note: r.note ?? null,
      handed_by: r.handed_by ?? null, handed_at: asIso(r.handed_at), accepted_by: r.accepted_by ?? null, accepted_at: r.accepted_at ? asIso(r.accepted_at) : null,
      accept_note: r.accept_note ?? null, voided_by: r.voided_by ?? null, voided_at: r.voided_at ? asIso(r.voided_at) : null, void_reason: r.void_reason ?? null,
    }));
  }
  /** One live hand-over per day and pier: the unique index's refusal is the route's `409`. */
  async putHandover(h: StoredHandover): Promise<void> {
    try {
      await this.client().query(`INSERT INTO pier_handovers (id, service_date, pier, expected, cash_counted, note, handed_by, handed_at, accepted_by, accepted_at, accept_note, voided_by, voided_at, void_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at, accept_note = EXCLUDED.accept_note,
          voided_by = EXCLUDED.voided_by, voided_at = EXCLUDED.voided_at, void_reason = EXCLUDED.void_reason`,
      [h.id, h.service_date, h.pier, JSON.stringify(h.expected), h.cash_counted, h.note, h.handed_by, h.handed_at, h.accepted_by, h.accepted_at, h.accept_note, h.voided_by, h.voided_at, h.void_reason]);
    } catch (error) {
      if ((error as { constraint?: string }).constraint !== 'pier_handovers_live') throw error;
      refuse(`${h.pier} was already handed over for ${h.service_date}`, 409, 'already_handed_over');
    }
  }
  /** Newest last. */
  async payouts(q: { seller?: string; from?: string; to?: string; ids?: readonly string[] } = {}): Promise<StoredPayout[]> {
    const { rows } = await this.client().query(`SELECT p.*, p.paid_on::text AS day, COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', i.kind, 'booking_id', i.booking_id,
        'item_id', i.item_id, 'amount', i.amount) ORDER BY i.kind, i.booking_id COLLATE "C", i.item_id COLLATE "C") FROM commission_payout_items i WHERE i.payout_id = p.id), '[]'::jsonb) AS items
      FROM commission_payouts p WHERE ($1::text IS NULL OR p.seller = $1) AND ($2::date IS NULL OR p.paid_on >= $2) AND ($3::date IS NULL OR p.paid_on <= $3)
        AND ($4::text[] IS NULL OR p.id = ANY($4)) ORDER BY p.created_at, p.id COLLATE "C"`, [q.seller ?? null, q.from ?? null, q.to ?? null, q.ids ? [...q.ids] : null]);
    return rows.map((r): StoredPayout => ({
      id: String(r.id), seller: String(r.seller), amount: Number(r.amount), method: r.method, paid_on: String(r.day), ref: r.ref ?? null, note: r.note ?? null,
      created_by: r.created_by ?? null, created_at: asIso(r.created_at), voided_by: r.voided_by ?? null, voided_at: r.voided_at ? asIso(r.voided_at) : null,
      void_reason: r.void_reason ?? null, items: ((r.items as PayoutItem[]) ?? []).map((i) => ({ ...i, amount: Number(i.amount) })),
    }));
  }
  async putPayout(p: StoredPayout): Promise<void> {
    await this.client().query(`INSERT INTO commission_payouts (id, seller, amount, method, paid_on, ref, note, created_by, created_at, voided_by, voided_at, void_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET voided_by = EXCLUDED.voided_by, voided_at = EXCLUDED.voided_at, void_reason = EXCLUDED.void_reason`,
    [p.id, p.seller, p.amount, p.method, p.paid_on, p.ref, p.note, p.created_by, p.created_at, p.voided_by, p.voided_at, p.void_reason]);
    await this.client().query('DELETE FROM commission_payout_items WHERE payout_id = $1', [p.id]);
    await this.client().query(`INSERT INTO commission_payout_items (payout_id, kind, booking_id, item_id, amount)
      SELECT $1, i.kind, i.booking_id, i.item_id, i.amount FROM jsonb_to_recordset($2::jsonb) AS i(kind text, booking_id text, item_id text, amount numeric)`, [p.id, JSON.stringify(p.items)]);
  }

  /** A boat's capacity for one day (migration 046 records who and when): the trip-ops raise. */
  async putBoatCapacityOverride(o: { boat_id: string; service_date: string; capacity: number; reason: string; set_by: string | null; set_at: string }): Promise<void> {
    await this.client().query(`INSERT INTO boat_capacity_overrides (boat_id, service_date, capacity, reason, set_by, set_at) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (boat_id, service_date) DO UPDATE SET capacity = EXCLUDED.capacity, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
    [o.boat_id, o.service_date, o.capacity, o.reason, o.set_by, o.set_at]);
  }

  async putAttachment(f: StoredFile): Promise<void> {
    await this.client().query('INSERT INTO attachments (id, filename, mime, size, data, uploaded_by, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [f.id, f.name, f.mime, f.size, f.data, f.uploaded_by, f.uploaded_at]);
  }
  async attachmentFile(id: string): Promise<StoredFile | undefined> {
    const { rows: [r] } = await this.client().query('SELECT id, filename, mime, size, data, uploaded_by, uploaded_at FROM attachments WHERE id = $1', [id]);
    return r && { id: r.id, name: r.filename, mime: r.mime, size: Number(r.size), data: r.data as Buffer, uploaded_by: r.uploaded_by ?? null, uploaded_at: (r.uploaded_at as Date).toISOString() };
  }
  /** The files that exist among `ids`. */
  async attachmentRefs(ids: readonly string[]): Promise<Map<string, AttachmentRef>> {
    const { rows } = await this.client().query('SELECT id, filename, mime, size FROM attachments WHERE id = ANY($1::text[])', [ids]);
    return new Map(rows.map((r) => [r.id as string, { id: r.id as string, name: r.filename as string, mime: r.mime as string, size: Number(r.size) }]));
  }
  /** The bookings that point at a file, by their documents or their upgrade slips. */
  async attachmentBookings(id: string): Promise<Booking[]> {
    const { rows } = await this.client().query(`${BOOKING_SELECT} WHERE b.id IN (SELECT booking_id FROM booking_documents WHERE attachment_id = $1
      UNION SELECT booking_id FROM booking_upgrade_slips WHERE attachment_id = $1
      UNION SELECT l.booking_id FROM payment_slips s JOIN payments p ON p.id = s.payment_id JOIN invoice_lines l ON l.invoice_id = p.invoice_id WHERE s.attachment_id = $1
      UNION SELECT p.booking_id FROM booking_pier_payment_slips s JOIN booking_pier_payments p ON p.id = s.payment_id WHERE s.attachment_id = $1
      UNION SELECT t.booking_id FROM booking_tour_sale_slips s JOIN booking_tour_sales t ON t.id = s.sale_id WHERE s.attachment_id = $1
      UNION SELECT booking_id FROM booking_cot_decision_slips WHERE attachment_id = $1)`, [id]);
    return rows.map(booking);
  }
  async deleteAttachment(id: string): Promise<boolean> { return (await this.client().query('DELETE FROM attachments WHERE id = $1', [id])).rowCount === 1; }

  /** Moves one trip to another route through the ordinary edit, which checks the route's calendar and seats. */
  async upgradeRoute(id: string, tripId: string, routeId: string, actor: string | undefined, entry: HistoryLine): Promise<Booking | undefined> {
    const current = await this.storedBooking(id);
    return current && this.amendBooking(id, { trips: retargetTrip(current.trips, tripId, routeId) }, actor, entry);
  }
  /** Replaces the upgrades list as given, writing no history (a route upgrade's charge). */
  async setUpgrades(bookingId: string, upgrades: readonly StoredUpgrade[]): Promise<void> { await this.writeUpgrades(bookingId, upgrades); }
  async tripUpgradesOf(tripId: string): Promise<TripUpgrade[]> {
    return (await this.client().query('SELECT * FROM booking_trip_upgrades WHERE booking_trip_id = $1 ORDER BY id', [tripId])).rows.map(tripUpgrade);
  }
  async addTripUpgrade(row: Omit<TripUpgrade, 'id'>): Promise<TripUpgrade> {
    const { rows: [saved] } = await this.client().query(`INSERT INTO booking_trip_upgrades (booking_trip_id, from_route_id, to_route_id, reason, charge, upgrade_id, at, by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [row.booking_trip_id, row.from_route_id, row.to_route_id, row.reason, row.charge, row.upgrade_id, row.at, row.by]);
    return tripUpgrade(saved);
  }
  async undoTripUpgrade(id: number, at: string, by: string | null): Promise<void> {
    await this.client().query('UPDATE booking_trip_upgrades SET undone_at = $2, undone_by = $3 WHERE id = $1', [id, at, by]);
  }

  /** `null` removes it. */
  async setReconfirm(bookingId: string, r: StoredReconfirm | null): Promise<void> {
    if (!r) { await this.client().query('DELETE FROM booking_reconfirmations WHERE booking_id = $1', [bookingId]); return; }
    await this.client().query(`INSERT INTO booking_reconfirmations (booking_id, status, via, at, by, sent_at, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (booking_id) DO UPDATE SET status = EXCLUDED.status, via = EXCLUDED.via, at = EXCLUDED.at, by = EXCLUDED.by,
        sent_at = EXCLUDED.sent_at, sent_by = EXCLUDED.sent_by`, [bookingId, r.status, r.via, r.at, r.by, r.sent_at, r.sent_by]);
  }
  /** Appends a line to a booking's history, inside the write it describes. */
  async addHistory(bookingId: string, line: HistoryLine): Promise<void> { await this.log(bookingId, line); }

  async listUsers(): Promise<StoredUser[]> { return (await this.client().query('SELECT * FROM users ORDER BY id')).rows.map(storedUser); }
  async user(id: number): Promise<StoredUser | undefined> {
    const { rows: [row] } = await this.client().query('SELECT * FROM users WHERE id = $1', [id]);
    return row && storedUser(row);
  }
  async userByUsername(username: string): Promise<StoredUser | undefined> {
    const { rows: [row] } = await this.client().query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    return row && storedUser(row);
  }
  async createUser(input: NewUser): Promise<StoredUser> {
    try {
      const { rows: [row] } = await this.client().query(
        `INSERT INTO users (username, pass_hash, name, role, can_edit, edit_areas, actions, view_perms, sales_id, agent_id, dept, disabled_at, tokens_valid_after, legacy_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [input.username, input.pass_hash, input.name, input.role, input.can_edit, input.edit_areas, input.actions, input.view_perms,
          input.sales_id, input.agent_id, input.dept, input.disabled_at, input.tokens_valid_after, input.legacy_id]);
      return storedUser(row);
    } catch (error) {
      if ((error as { code?: string; constraint?: string }).constraint === 'users_username') usernameTaken(input.username);
      throw error;
    }
  }
  async updateUser(id: number, patch: UserPatch): Promise<StoredUser | undefined> {
    const keys = Object.keys(patch) as (keyof UserPatch)[];
    const sets = keys.map((key, i) => `${key} = $${i + 2}`);
    const { rows: [row] } = await this.client().query(
      `UPDATE users SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((key) => patch[key])]);
    return row && storedUser(row);
  }

  async listRateTypes(query: RateTypeListQuery): Promise<RateTypeSummary[]> { return selectRateTypes(await this.readRateTypes(), query); }
  async rateType(id: string): Promise<RateType | undefined> { const [rows] = await this.readRateTypes([id]); return rows && rateTypeView(rows); }

  /** Answers 400 before a foreign key could answer 500: unknown routes, wrong zones, an owner who is not a salesperson. */
  private async assertRateTypeRefs(blocks: readonly { route_id: string; block: RouteBlock; label: string }[], owner: string | null | undefined): Promise<void> {
    if (blocks.length > 0) {
      const { rows } = await this.client().query('SELECT id, pier FROM routes WHERE id = ANY($1::text[])', [blocks.map((b) => b.route_id)]);
      const catalogue = new Map(rows.map((row) => [String(row.id), { id: String(row.id), pier: row.pier ?? undefined }]));
      for (const { route_id, block, label } of blocks) assertRouteBlock(block, route_id, catalogue, label);
    }
    if (owner !== null && owner !== undefined) {
      const { rows } = await this.client().query('SELECT id FROM sales_people WHERE id = $1', [owner]);
      assertOwner(owner, new Set(rows.map((row) => String(row.id))));
    }
  }

  /** One route's rows: the route, then each price table in one statement however many cells it has. */
  private async insertRouteRows(rows: RouteRows): Promise<void> {
    const r = rows.route;
    await this.client().query(`INSERT INTO rate_type_routes (rate_type_id, route_id, seq, travel_from, travel_to, longtail_bundle, longtail_bundle_adult,
      longtail_bundle_child, longtail_bundle_applies_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [r.rate_type_id, r.route_id, r.seq, r.travel_from, r.travel_to, r.longtail_bundle, r.longtail_bundle_adult, r.longtail_bundle_child, r.longtail_bundle_applies_to]);
    const key = [r.rate_type_id, r.route_id];
    if (rows.seat.length > 0) {
      await this.client().query(`INSERT INTO rate_type_seat_prices (rate_type_id, route_id, zone, category, residency, tier, price)
        SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[])`,
      [...key, rows.seat.map((s) => s.zone), rows.seat.map((s) => s.category), rows.seat.map((s) => s.residency), rows.seat.map((s) => s.tier), rows.seat.map((s) => s.price)]);
    }
    if (rows.charter.length > 0) {
      await this.client().query(`INSERT INTO rate_type_charter_prices (rate_type_id, route_id, boat_type, starter_price, starter_includes, extra_per_pax)
        SELECT $1, $2, * FROM unnest($3::text[], $4::numeric[], $5::int[], $6::numeric[])`,
      [...key, rows.charter.map((c) => c.boat_type), rows.charter.map((c) => c.starter_price), rows.charter.map((c) => c.starter_includes), rows.charter.map((c) => c.extra_per_pax)]);
    }
    for (const l of rows.longtail) {
      await this.client().query('INSERT INTO rate_type_longtail_prices (rate_type_id, route_id, join_adult, join_child, charter_price, charter_capacity) VALUES ($1,$2,$3,$4,$5,$6)',
        [...key, l.join_adult, l.join_child, l.charter_price, l.charter_capacity]);
    }
    if (rows.transfer.length > 0) {
      await this.client().query(`INSERT INTO rate_type_transfer_prices (rate_type_id, route_id, zone, vehicle, price)
        SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::numeric[])`,
      [...key, rows.transfer.map((t) => t.zone), rows.transfer.map((t) => t.vehicle), rows.transfer.map((t) => t.price)]);
    }
  }

  async createRateType(input: RateTypeCreate): Promise<RateType> {
    await this.assertRateTypeRefs(input.routes.map(({ route_id, block }, index) => ({ route_id, block, label: `routes[${index}]` })), input.header.owner);
    if (input.header.id !== undefined && (await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [input.header.id])).rowCount) rateTypeExists('id', input.header.id);
    const codes = new Set((await this.client().query('SELECT code FROM rate_types')).rows.map((row) => String(row.code)));
    if (input.header.code !== undefined && codes.has(input.header.code)) rateTypeExists('code', input.header.code);
    const id = input.header.id ?? `rt_${randomUUID()}`;
    const row = newRateTypeRow(input.header, id, input.header.code ?? generateRateTypeCode(input.header.name, codes), new Date().toISOString());
    try {
      await this.client().query(`INSERT INTO rate_types (id, code, name, note, color, owner_sales_id, valid_from, valid_to, active, nationality_scope, transfer_unit, created_on)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id, row.code, row.name, row.note, row.color, row.owner_sales_id, row.valid_from, row.valid_to, row.active, row.nationality_scope, row.transfer_unit, row.created_on]);
    } catch (error) {
      // Two creates racing for the same id or code: the checks above both passed, the index caught it.
      const e = error as Error & { code?: string; constraint?: string };
      if (e.code === '23505') rateTypeExists(e.constraint === 'rate_types_pkey' ? 'id' : 'code', e.constraint === 'rate_types_pkey' ? row.id : row.code);
      throw error;
    }
    for (const [seq, { route_id, block }] of input.routes.entries()) await this.insertRouteRows(routeRows(id, route_id, seq, block));
    return (await this.rateType(id))!;
  }

  async patchRateType(id: string, patch: RateTypePatch): Promise<RateType | undefined> {
    const [current] = await this.readRateTypes([id]);
    if (!current) return undefined;
    await this.assertRateTypeRefs([], patch.owner);
    const next = patchedRateTypeRow(current.rate, patch, new Date().toISOString());
    await this.client().query(`UPDATE rate_types SET name = $2, note = $3, color = $4, owner_sales_id = $5, valid_from = $6, valid_to = $7, active = $8,
      nationality_scope = $9, transfer_unit = $10, updated_at = now() WHERE id = $1`,
    [id, next.name, next.note, next.color, next.owner_sales_id, next.valid_from, next.valid_to, next.active, next.nationality_scope, next.transfer_unit]);
    return this.rateType(id);
  }

  /** Replaces one route's block; a route new to the rate goes after the ones it has. */
  async putRateTypeRoute(id: string, routeId: string, block: RouteBlock): Promise<RateType | undefined> {
    if (!(await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [id])).rowCount) return undefined;
    await this.assertRateTypeRefs([{ route_id: routeId, block, label: '' }], undefined);
    const { rows } = await this.client().query('SELECT route_id, seq FROM rate_type_routes WHERE rate_type_id = $1', [id]);
    const existing = rows.find((row) => String(row.route_id) === routeId);
    const seq = existing ? Number(existing.seq) : nextRouteSeq(rows.map((row) => ({ seq: Number(row.seq) })));
    // The prices cascade from the route row, so deleting it and writing the block again replaces the lot.
    await this.client().query('DELETE FROM rate_type_routes WHERE rate_type_id = $1 AND route_id = $2', [id, routeId]);
    await this.insertRouteRows(routeRows(id, routeId, seq, block));
    await this.client().query('UPDATE rate_types SET updated_at = now() WHERE id = $1', [id]);
    return this.rateType(id);
  }

  /** Undefined for an unknown rate type, false for a route the rate does not cover. */
  async deleteRateTypeRoute(id: string, routeId: string): Promise<boolean | undefined> {
    if (!(await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [id])).rowCount) return undefined;
    const { rowCount } = await this.client().query('DELETE FROM rate_type_routes WHERE rate_type_id = $1 AND route_id = $2', [id, routeId]);
    if (!rowCount) return false;
    await this.client().query('UPDATE rate_types SET updated_at = now() WHERE id = $1', [id]);
    return true;
  }

  async deleteRateType(id: string): Promise<boolean> {
    if (!(await this.client().query('SELECT 1 FROM rate_types WHERE id = $1', [id])).rowCount) return false;
    const { rows: [used] } = await this.client().query(`SELECT (SELECT count(*) FROM agents a WHERE a.rate_type_id = $1 OR EXISTS (SELECT 1 FROM agent_rate_seasons s WHERE s.agent_id = a.id AND s.rate_type_id = $1))::int AS agents,
      (SELECT count(*) FROM bookings WHERE rate_type_ref = $1)::int AS bookings`, [id]);
    assertRateTypeUnused(id, { agents: Number(used.agents), bookings: Number(used.bookings) });
    await this.client().query('DELETE FROM rate_types WHERE id = $1', [id]);
    return true;
  }

  async listDayOverrides(from?: string, to?: string): Promise<RouteDayOverride[]> {
    const { rows } = await this.client().query('SELECT route_id, service_date::text, kind FROM route_day_overrides WHERE ($1::date IS NULL OR service_date >= $1) AND ($2::date IS NULL OR service_date <= $2) ORDER BY route_id, service_date', [from ?? null, to ?? null]);
    return rows.map(dayOverride);
  }
}
