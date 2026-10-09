import { applyCalendarChange, assertCloseAllowed, assertRoutesOpen, eachDate, isLegacyB2C, routeCalendar, todayInThailand, type CalendarChange, type CalendarHold, type Route, type RouteDate, type RouteDayOverride, type RouteSeason } from './calendar.js';
import { byCreated, matchesLock, poolLocks, type GroupRow, type LockEvent, type LockQuery, type LockRow, type NewLockEvent } from './seat-locks.js';
import { formatPaxGrid, paxKey, paxTotal, retargetPax, type PaxGrid, type PaxRow } from './pax.js';
import { holdsSeats, type BookingStatus } from './booking-status.js';
import { assertDayFits, capacityNumbers, dayCapacity, licenceShortfall, weighDay, type Capacity, type DayDemand, type DayState, type HeldTrip } from './capacity.js';
import { applyBookingHeader, type BookingHeader, type BookingHeaderPatch } from './booking-header.js';
import { withSeq, type BookingPassenger, type BookingPassengerInput } from './booking-passengers.js';
import type { BookingAddOn, BookingAddOnInput } from './booking-addons.js';
import type { BookingAdjustment, BookingAdjustmentInput } from './booking-adjustments.js';
import type { AltPickup } from './alt-pickups.js';
import { allergyCount, type Allergy } from './allergies.js';
import type { PickupArea, PickupCell, TimeProfile } from './pickup-areas.js';
import type { Change, ChangeInput } from './changes.js';
import { docCheckStatus, docCheckView, copyDocCheck, type DocCheck, type DocCheckView } from './doc-check.js';
import type { AttachmentRef, BookingDocument, DocumentRow, StoredFile } from './attachments.js';
import { bookingIdsOf, bookingInvoice, copyInvoice, returnedOf, type BookingInvoice, type InvoiceBrief, type PaymentState, type StoredInvoice, type StoredPayment, type StoredRefund } from './invoices.js';
import { matchesClosureQuery, planClose, sortClosures, type ClosureListQuery, type WeatherCase, type WeatherClosure } from './weather.js';
import type { PfmEvent } from './pfm.js';
import type { StoredHandover, StoredPayout, StoredPierPayment, StoredTourSale } from './pier-money.js';
import type { StoredCotDecision, StoredNoshowCharge } from './after-trip.js';
import { activeUpgrade, storedUpgrades, upgradeView, type StoredUpgrade, type TripUpgrade, type Upgrade, type UpgradeInput } from './upgrades.js';
import {
  assertEditable, assertOpen, assertRestorable, createdLine, editedLine, movedLine, partialCancelLine, partialCancelRecord, partialCountLine, planCancel, planRescheduleRecord,
  confirmationStamp, externalIdTaken, planStatusCommand, refuse, restoredLine, stripServerOwned, totalAfterRefund, type StatusCommand, type StatusCommandRequest,
  type BookingCancellation, type BookingFeeItem, type BookingPartialCancel, type BookingReschedule, type CancelRequest, type HistoryEntry, type HistoryLine,
  type LockShortWarning, type PartialCancelRequest, type RescheduleRequest,
} from './booking-actions.js';
import {
  agentSummary, agentView, latestActivity, selectAgents, sortMarkets, sortSalesPeople,
  type Agent, type AgentActivity, type AgentListQuery, type AgentSummary, type Market, type SalesPerson, type StoredActivity, type StoredAgent,
} from './agents.js';
import {
  addRouteRows, assertOwner, assertRateTypeUnused, assertRouteBlock, generateRateTypeCode, newRateTypeRow, nextRouteSeq, patchedRateTypeRow, rateTypeExists, rateTypeView,
  removeRouteRows, routeRows, selectRateTypes,
  type CatalogueRoute, type RateType, type RateTypeCreate, type RateTypeListQuery, type RateTypePatch, type RateTypeRows, type RateTypeSummary, type RouteBlock,
} from './rate-types.js';
import {
  bookingHoldsSeats, decidedRecord, decideStatus, discountOf, focCountOf, pendingApproval, reweigh, sortApprovalDays,
  type ApprovalDay, type ApprovalKind, type ApprovalWarning, type BookingApproval, type Intent, type NewApproval,
} from './booking-approvals.js';
import { pickupFields, type PickupWindow } from './pickup.js';
import { usernameTaken, type NewUser, type StoredUser, type UserPatch } from './users.js';
import { clearedOnMove, dispatchView, EMPTY_DISPATCH, type StoredDispatch, type TripDispatch } from './dispatch.js';
import { rebalanceParts, vanPartsView, type StoredVanPart, type VanGroup } from './van-groups.js';
import { reconfirmView, type Reconfirm, type StoredReconfirm } from './reconfirm.js';
import { checkinsView, copyCheckin, type CheckinKind, type StoredCheckin } from './checkin.js';
import { applyVanPatch, isEmptyVanDay, nextVanId, sortRanges, sortVans, type StoredVanDay, type Van, type VanInput, type VanLogEntry, type VanPatch, type VanStatusRange, type VanStatusRangeInput, type VanZoneRange, type VanZoneRangeInput } from './vans.js';
import { copyStop, type VanStop } from './van-stops.js';
import { specialRequest, type PickupNameTh, type VanJobSend } from './van-jobs.js';
import { contractView, selectContracts, type Contract, type ContractListQuery } from './contracts.js';
import type { RateSeason } from './rate-seasons.js';
import { sortHeld, type HeldOrder, type HeldStatus } from './b2c.js';
import {
  blankBoat, boatOf, compactRoute, copyBoat, LEGACY_FAMILIES, sortFamilies,
  type BoatRecord, type RouteFamily, type RouteFields, type RouteUsage, type StoredOverride,
} from './catalogue.js';
import type { AgentUsage, ContractHistoryEntry } from './agent-writes.js';
import { salesSummary, type StoredSalesPerson, type SalesPersonSummary } from './team.js';
import { sortDocuments, sortTemplates, type ContractDocument, type ContractTemplate } from './contract-templates.js';
import { addonServiceView, sortAddonServices, type AddonService } from './addon-services.js';
import { builtinNationalities, type StoredNationality } from './nationalities.js';
import { carryInsurance, type InsuranceFields } from './insurance.js';
import { MemoryFleetRepo } from './fleet-store.js';
import { MemoryMoneyRepo } from './money-store.js';
import { copyBill, type StoredVanBill, type VanRate, type VanRateField } from './van-bills.js';
import type { DailySettings } from './money-reports.js';
import { copyAsset, matchesAsset, sortAssets, type AssetKind, type AssetOf, type AssetQuery, type Engine, type Gearbox, type Propeller } from './fleet-assets.js';
import {
  copyIncident, copyJob, matchesIncident, matchesJob, sortIncidents, sortJobs, type Incident, type IncidentQuery, type Job, type JobQuery,
} from './fleet-jobs.js';

export type Deployment = {
  boat_id: string;
  route_id: string;
  service_date: string;
  /** Normal-seat booking capacity — the commercial decision, clamped by `license_pax` when selling. */
  capacity: number;
  /** Registered passenger maximum. Filled from the boat catalogue when the caller omits it. */
  license_pax?: number;
  /** Registered total persons aboard (passengers + crew). A vessel fact, never a selling ceiling. */
  registered_persons?: number;
};

/** A per-day capacity change for one boat, from `boat_capacity_overrides`. */
export type BoatCapacityOverride = { boat_id: string; service_date: string; capacity: number; reason?: string; set_by?: string | null; set_at?: string };
/**
 * The boat catalogue entry a deployment's licence is resolved from.
 *
 * `name` and `capacity` are required because the `boats` table declares them NOT NULL. Leaving them
 * optional let the in-process store hold a boat PostgreSQL would reject, which is the divergence
 * shape that kept the seat-lock `service_date` bug alive: only one store was ever exercised.
 */
export type Boat = { id: string; name: string; type?: string; pier?: string; capacity: number; license_pax?: number; crew?: number };



/** Seats a trip takes from an agent's lock rather than from the general pool. */
export type LockDraw = { lock_id: string; qty: number };

/**
 * One departure. Seats are consumed here, so this is what every capacity query reads.
 *
 * `charter_boat_id` is the boat a charter takes whole, and only a charter carries one.
 * `lock_draws` are the seats a seat trip takes from locks; they never exceed the trip's pax.
 * `id` names the stored trip an amendment is editing; a trip without one is new. See `planTrips`.
 * The overnight fields are described in migration 015 and checked by `assertItinerary`; the pickup
 * window is `src/domain/pickup.ts`'s.
 */
/** What `priceBooking` priced a booking's trips (by position) and add-ons at (src/domain/pricing.ts). */
export type BookingPrices = { trips: { subtotal: number; rate_type_id: string | null; promo_id: string | null }[]; add_ons: number[] };
export type TripDetails = PickupWindow & { zone?: string; ovn?: OvnMode; ovn_return_date?: string; ovn_leg?: boolean;
  /** Client facts the price reads (migration 032). */
  ovn_charge?: number; charter_price_mode?: 'rate' | 'manual'; charter_price_manual?: number; charter_price_note?: string;
  /** What the trip was priced at (computed by `priceBooking`, migration 032). */
  subtotal?: number; rate_type_id?: string; promo_id?: string;
};
export type OvnMode = 'return' | 'self';
/** `ovn_of` is an index into the same trip list, on input and on the wire. */
export type BookingTripInput = TripDetails & { id?: string; route_id: string; service_date: string; booking_mode?: string; pax: PaxRow[]; charter_boat_id?: string; lock_draws?: LockDraw[]; ovn_of?: number };
export type BookingTrip = TripDetails & { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxGrid; pax_total: number; charter_boat_id?: string; lock_draws: Record<string, number>; ovn_leg: boolean; ovn_of?: number;
  /** Day-of-operations dispatch (src/domain/dispatch.ts): always present, empty when nothing is set. */
  operations: TripDispatch;
};

export type BookingInput = {
  trips: BookingTripInput[];
  /**
   * Which save button: "Save as quote" or "Confirm" (default). The server decides the status from it
   * and the facts (`decideStatus`); a client no longer sends a status.
   */
  intent?: Intent;
  external_id?: string;
  agent_id?: string;
  voucher_ref?: string;
  rate_type_ref?: string;
  /**
   * The header scalars, already read out of the caller's document by `bookingHeader()`. Both stores
   * persist these as columns; neither parses the document itself.
   */
  header?: BookingHeader;
  /** The passenger list, already parsed by `parseBookingPassengers()`. Defaults to none. */
  passengers?: BookingPassengerInput[];
  /** The add-on list, already parsed by `parseBookingAddOns()`. Defaults to none. */
  add_ons?: BookingAddOnInput[];
  /** Discounts and extras, already parsed by `parseBookingAdjustments()`. Defaults to none. */
  adjustments?: BookingAdjustmentInput[];
  /** Extra pickup or drop-off points (`alt-pickups.ts`). Defaults to none. */
  alt_pickups?: AltPickup[];
  /** On-tour upgrades sold (`upgrades.ts`). Defaults to none. */
  upgrades?: UpgradeInput[];
  /** The booking's documents, stamped by the route (`attachments.ts`). Defaults to none. */
  attachments?: DocumentRow[];
  /** Who can't eat what, for the kitchen (`allergies.ts`). Defaults to none. */
  allergy_list?: Allergy[];
  /**
   * Original booking payload retained for operations, reconciliation, and audit import.
   *
   * Written beside the header columns during the dual-write step, and on its way out — a field that
   * is not modelled is dropped rather than kept here. See `todo/booking-model.md`.
   */
  booking_data?: Record<string, unknown>;
};

export type Booking = BookingHeader & {
  id: string;
  status: BookingStatus;
  /** 1 on create, +1 on every write. Send it back as `If-Match` to refuse a stale save. */
  version: number;
  created_at: string;
  updated_at: string;
  cancellation_reason?: string;
  /** Source-system identifiers and commercial context. */
  external_id?: string;
  agent_id?: string;
  voucher_ref?: string;
  rate_type_ref?: string;
  booking_data?: Record<string, unknown>;
  passengers: BookingPassenger[];
  add_ons: BookingAddOn[];
  adjustments: BookingAdjustment[];
  alt_pickups: AltPickup[];
  upgrades: Upgrade[];
  /** The booking's documents: the agent's voucher, passports (migration 040). */
  attachments: BookingDocument[];
  /** The document check (`doc-check.ts`), or null; `doc_check_status` is legacy's `docCheckStatus`, computed. */
  doc_check: DocCheckView | null;
  doc_check_status: string;
  allergy_list: Allergy[];
  /** The kitchen's count (legacy `bkV2AllergyCount`): the list's people, or 1 for free text alone. Computed. */
  allergy_count: number;
  /**
   * What the van job order, van check-in and the pier print as the special request (legacy
   * `vanJobsSreqFinal`): `job_note` when set (`""` = nothing), else the notes. Computed; `null` = none.
   */
  special_request: string | null;
  /** Every approval the booking waited for, oldest first. The last `pending` one of a kind is the one waiting. */
  approvals: BookingApproval[];
  /** The current cancellation's category and charge. Absent unless the booking was cancelled with one. */
  cancellation?: BookingCancellation;
  /** Every reschedule, partial cancel and fee item, oldest first. See `booking-actions.ts`. */
  reschedules: BookingReschedule[];
  partial_cancels: BookingPartialCancel[];
  fee_items: BookingFeeItem[];
  trips: BookingTrip[];
  /**
   * The first trip's route and date, the total pax across every trip, and the seats that total is
   * currently holding. All four are derived from `trips` and the status — they are not stored, and
   * they exist so a single-departure client needs to know nothing about trips.
   */
  route_id: string;
  service_date: string;
  booking_mode?: string;
  pax: number;
  allocated_pax: number;
  /** Did the customer confirm their pickup, and was the agent's list sent (`reconfirm.ts`). */
  reconfirm: Reconfirm | null;
  /** The booking's live invoice and what is paid on it (`invoices.ts`). Computed. */
  invoice: BookingInvoice | null;
  payment_state: PaymentState;
};

/**
 * An amendment. `header` merges: a column it does not mention keeps the value it had, and one it
 * mentions with no value is cleared — see `BookingHeaderPatch`. The itinerary fields are the
 * exception and replace outright, because a trip list is one fact rather than fifty-seven.
 */
export type BookingChanges = {
  trips?: BookingTripInput[]; route_id?: string; service_date?: string; pax?: number; status?: BookingStatus;
  header?: BookingHeaderPatch;
  /** Present replaces the whole list outright, the same way `trips` does. Absent leaves it alone. */
  passengers?: BookingPassengerInput[];
  /** Same rule as `passengers`: present replaces outright, `[]` clears, absent leaves it alone. */
  add_ons?: BookingAddOnInput[];
  /** Same rule again. */
  adjustments?: BookingAdjustmentInput[];
  /** Same rule again. */
  alt_pickups?: AltPickup[];
  /** Same rule again. */
  upgrades?: UpgradeInput[];
  /** Same rule again. */
  attachments?: DocumentRow[];
  /** Same rule again. */
  allergy_list?: Allergy[];
};

/** A seat lock as the API answers it (seat-locks.ts). */
export type { SeatLock } from './seat-locks.js';

/**
 * Seats already held by the reservation being edited. Excluding them stops a booking from competing
 * with itself: without this, raising a 6-pax booking to 8 on a full day is refused even though the
 * six seats it is about to release would cover it, and a no-op edit on a sold-out day cannot save.
 */
export type Exclusion = { bookingId?: string; lockId?: string };

export type BookingListQuery = {
  routeId?: string;
  agentId?: string;
  serviceDate?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
  /** By `created_at`, then id. `desc` is newest first, which an agent's recent bookings want. Defaults to `asc`. */
  order?: 'asc' | 'desc';
  /** Any of these statuses. Absent means every status. */
  statuses?: BookingStatus[];
  /** Already lower-cased: a substring of the id, `voucher_ref` or `lead_pax`, compared lower-cased. */
  q?: string;
  /** Already lower-cased: the whole `voucher_ref`, compared lower-cased. */
  voucherRef?: string;
  /** An ISO instant: bookings whose `updated_at` is at or after it (Love Kingdom's reconciliation read). */
  updatedSince?: string;
};

/** `total` counts every booking the filters match, regardless of `cursor` and `limit`. */
export type BookingPage = { bookings: Booking[]; next_cursor?: string; total: number };

/** One route on one date, as the availability range returns it. */
export type RouteDay = DayState & { route_id: string; service_date: string };

/** A booking exactly as it is stored: trips as rows, nothing derived. Both stores hydrate into this. */
/** Stored, `ovn_of` is the outbound trip's id rather than its index, so it survives a reorder. */
export type StoredTrip = TripDetails & { id: string; seq: number; route_id: string; service_date: string; booking_mode: string; pax: PaxRow[]; charter_boat_id?: string; lock_draws: LockDraw[]; ovn_leg: boolean; ovn_of?: string };
export type StoredBooking = Omit<Booking, 'trips' | 'route_id' | 'service_date' | 'booking_mode' | 'pax' | 'allocated_pax' | 'reconfirm' | 'upgrades' | 'attachments' | 'allergy_count' | 'special_request' | 'doc_check' | 'doc_check_status' | 'invoice' | 'payment_state'> & { trips: StoredTrip[]; upgrades: StoredUpgrade[]; attachments: DocumentRow[] };

/**
 * The wire shape of a stored booking.
 *
 * Every derived field is computed here and nowhere else — pax totals, the first trip's route and
 * date, and the seats the booking is holding. Deriving them in SQL for one store and in JavaScript
 * for the other is how the two drift, so the SQL side returns rows and calls this.
 */
type BookingCursor = { created_at: string; id: string };
export const encodeBookingCursor = (booking: { created_at: string; id: string }): string => Buffer.from(JSON.stringify({ created_at: booking.created_at, id: booking.id }), 'utf8').toString('base64url');
export const decodeBookingCursor = (value: string): BookingCursor => {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<BookingCursor>;
    if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { created_at: parsed.created_at, id: parsed.id };
  } catch { return fail('Invalid cursor', 400); }
};

/** `dispatch` gives each trip's dispatch as a read shows it; without it, every trip's is empty. */
export function bookingView(stored: StoredBooking, dispatch: (trip: StoredTrip) => TripDispatch, reconfirm: StoredReconfirm | null = null,
  files: ReadonlyMap<string, AttachmentRef> = new Map(), docCheck: DocCheck | null = null, invoices: readonly InvoiceBrief[] = []): Booking {
  const trips = stored.trips.map(({ ovn_of, ...trip }): BookingTrip => ({
    ...trip, pax: formatPaxGrid(trip.pax), pax_total: paxTotal(trip.pax), lock_draws: Object.fromEntries(trip.lock_draws.map((draw) => [draw.lock_id, draw.qty])),
    ...ovnOfIndex(stored.trips, ovn_of), operations: dispatch({ ovn_of, ...trip }),
  }));
  const pax = trips.reduce((sum, trip) => sum + trip.pax_total, 0);
  const first = stored.trips[0];
  const seats = stored.trips.filter((trip) => trip.booking_mode !== 'charter').reduce((sum, trip) => sum + paxTotal(trip.pax), 0);
  // Approvals are copied: the store decides them in place, and a view already handed out must not change.
  const approvals = (stored.approvals ?? []).map((approval) => ({ ...approval, days: approval.days.map((day) => ({ ...day })) }));
  return {
    ...stored, approvals, trips, alt_pickups: (stored.alt_pickups ?? []).map((a) => ({ ...a })), upgrades: (stored.upgrades ?? []).map((u) => upgradeView(u, files)),
    doc_check: docCheckView(docCheck), doc_check_status: docCheckStatus(docCheck, (stored.attachments ?? []).length),
    allergy_list: (stored.allergy_list ?? []).map((a) => ({ ...a })), allergy_count: allergyCount(stored.allergy_list ?? [], stored.special_meals_allergies),
    special_request: specialRequest(stored),
    attachments: (stored.attachments ?? []).map((d) => ({ ...(files.get(d.attachment_id) ?? { id: d.attachment_id, name: d.attachment_id, mime: 'application/octet-stream', size: 0 }), kind: d.kind, by: d.by, at: d.at })), route_id: first?.route_id ?? '', service_date: first?.service_date ?? '', booking_mode: first?.booking_mode, pax,
    allocated_pax: bookingHoldsSeats(stored) ? seats : 0, reconfirm: reconfirmView(reconfirm), ...bookingInvoice(invoices),
  };
}

const fail = (message: string, statusCode: number): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = statusCode; throw error; };

/** A stored `ovn_of` id as the index the API speaks, or nothing when the trip has none. */
const ovnOfIndex = (trips: readonly StoredTrip[], id: string | undefined): { ovn_of?: number } => {
  const index = id === undefined ? -1 : trips.findIndex((trip) => trip.id === id);
  return index < 0 ? {} : { ovn_of: index };
};

/**
 * The rules an itinerary must meet as a whole, checked whenever a client sends `trips`.
 *
 * - One trip per route per day. The van board, the manifest and every day-of-operations screen
 *   address a booking's passengers by route and day; a second trip on the same departure would be
 *   a second row nobody can tell apart from the first. Send one trip with the combined pax.
 * - Overnight trips follow legacy's booking screen (`bkV2CreateOvnReturnLeg`): an outbound
 *   `ovn: 'return'` names the day it comes back, and its return leg is a trip on that route and that
 *   day, pointing back at it with `ovn_of`. The leg is booked as its outbound is: a seat outbound
 *   comes back on a seat trip; a charter outbound on a charter, of any boat deployed that day
 *   (decided 2026-10-09; legacy builds it on the same boat). The boat is not held on the nights
 *   between.
 *
 * Not applied to an amendment that leaves the trips alone, so a booking imported before these rules
 * existed can still have its header edited.
 */
export function assertItinerary(trips: readonly BookingTripInput[]): void {
  const seen = new Map<string, number>();
  trips.forEach((trip, index) => {
    const label = `trips[${index}]`;
    const key = `${trip.route_id} ${trip.service_date}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) fail(`${label} repeats trips[${earlier}]: one trip per route per day (${trip.route_id} on ${trip.service_date})`, 400);
    seen.set(key, index);

    if (trip.ovn === 'return' && trip.ovn_return_date === undefined) fail(`${label}.ovn_return_date is required when ovn is return`, 400);
    if (trip.ovn !== 'return' && trip.ovn_return_date !== undefined) fail(`${label}.ovn_return_date applies only when ovn is return`, 400);
    if (trip.ovn_return_date !== undefined && trip.ovn_return_date <= trip.service_date) fail(`${label}.ovn_return_date must be after the trip's date`, 400);

    if (!trip.ovn_leg) {
      if (trip.ovn_of !== undefined) fail(`${label}.ovn_of applies only to a return leg (ovn_leg)`, 400);
      return;
    }
    if (trip.ovn !== undefined) fail(`${label} is a return leg and cannot itself be an overnight outbound`, 400);
    if (trip.ovn_of === undefined) fail(`${label}.ovn_of is required on a return leg`, 400);
    const outbound = trip.ovn_of === index ? undefined : trips[trip.ovn_of as number];
    if (!outbound) fail(`${label}.ovn_of must be the index of another trip in this list`, 400);
    if (outbound!.ovn !== 'return') fail(`${label}.ovn_of must point at a trip with ovn return`, 400);
    const legMode = trip.booking_mode === 'charter' ? 'charter' : 'seat', outboundMode = outbound!.booking_mode === 'charter' ? 'charter' : 'seat';
    if (legMode !== outboundMode) fail(`${label} is a return leg and must be a ${outboundMode} trip, as its outbound is`, 400);
    if (outbound!.route_id !== trip.route_id || outbound!.ovn_return_date !== trip.service_date) {
      fail(`${label} must be on its outbound's route (${outbound!.route_id}) and return date (${outbound!.ovn_return_date})`, 400);
    }
  });
}

/** What a set of trips asks of each route/day, so two trips on one day are weighed together. */
export function demandByDay(trips: readonly BookingTripInput[], agentId?: string | null): DayDemand[] {
  const days = new Map<string, DayDemand>();
  for (const trip of trips) {
    const key = `${trip.route_id}\u0000${trip.service_date}`;
    const day: DayDemand = days.get(key) ?? { route_id: trip.route_id, service_date: trip.service_date, seat: 0, draws: new Map(), charters: [], agent_id: agentId ?? null };
    if (trip.booking_mode === 'charter') day.charters.push({ boat_id: trip.charter_boat_id, pax: paxTotal(trip.pax) });
    else day.seat += paxTotal(trip.pax);
    for (const draw of trip.lock_draws ?? []) day.draws.set(draw.lock_id, (day.draws.get(draw.lock_id) ?? 0) + draw.qty);
    days.set(key, day);
  }
  return [...days.values()];
}

/** Seats each lock has given to bookings that hold seats, the booking being edited aside. */
export function drawnByLock(bookings: Iterable<StoredBooking>, exclude: Exclusion = {}): Map<string, number> {
  const drawn = new Map<string, number>();
  for (const booking of bookings) {
    if (booking.id === exclude.bookingId || !bookingHoldsSeats(booking)) continue;
    for (const trip of booking.trips) for (const draw of trip.lock_draws) drawn.set(draw.lock_id, (drawn.get(draw.lock_id) ?? 0) + draw.qty);
  }
  return drawn;
}

/** A small serialized in-memory unit of work. Replace this adapter with a DB transaction in production. */
export class OperationsStore {
  /** Fleet part B (todo/fleet-maintenance-model.md): stock, memos, projects, the Daily Fleet Log, safety. */
  readonly fleetRepo = new MemoryFleetRepo();
  /** The rest of Money (migrations 160–161): the cost model, trip actuals, deposits, refund payouts. */
  readonly moneyRepo = new MemoryMoneyRepo();
  private deployments: Deployment[] = [];
  private bookings = new Map<string, StoredBooking>();
  private histories = new Map<string, HistoryEntry[]>();
  private locks = new Map<string, LockRow>();
  private lockGroups = new Map<string, GroupRow>();
  private lockLog: LockEvent[] = [];
  private tail: Promise<void> = Promise.resolve();
  /**
   * Reference data. Empty unless seeded or written through the catalogue endpoints: with no database
   * there is no catalogue to read. The families start as migration 070 seeds them.
   */
  private catalogue: { routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[]; boats: BoatRecord[]; boatOverrides: BoatCapacityOverride[]; families: RouteFamily[] } =
    { routes: [], seasons: [], overrides: [], boats: [], boatOverrides: [], families: LEGACY_FAMILIES.map((f) => ({ ...f })) };

  /** Agents and what they point at. Empty unless seeded: a PostgreSQL deployment gets these from the import. */
  private directory: { markets: Market[]; sales: StoredSalesPerson[]; agents: StoredAgent[]; activity: Map<string, StoredActivity[]> } =
    { markets: [], sales: [], agents: [], activity: new Map() };

  /**
   * Loads agents, markets, salespeople and activity, as `import-legacy.ts` does for PostgreSQL.
   * Activity is given oldest first; its position is what orders two entries at the same instant.
   */
  seedAgents(data: Partial<{ markets: Market[]; sales: (SalesPerson & { signature?: string | null })[]; agents: StoredAgent[]; activity: Record<string, AgentActivity[]> }>): void {
    if (data.markets) this.directory.markets = data.markets.map((market) => ({ ...market, subs: [...market.subs] }));
    if (data.sales) this.directory.sales = data.sales.map((person) => ({ ...person, signature: person.signature ?? null }));
    if (data.agents) this.directory.agents = data.agents.map((agent) => ({ ...agent, programs: agent.programs.map((program) => ({ ...program })) }));
    if (data.activity) {
      this.directory.activity = new Map(Object.entries(data.activity).map(([agentId, entries]) =>
        [agentId, entries.map((entry, seq) => ({ ...entry, at: new Date(entry.at).toISOString(), seq }))]));
    }
  }
  listMarkets(): Market[] { return sortMarkets(this.directory.markets).map((market) => ({ ...market, subs: [...market.subs] })); }
  listSalesPeople(): SalesPersonSummary[] { return sortSalesPeople(this.directory.sales).map(salesSummary); }
  listAgents(query: AgentListQuery): AgentSummary[] {
    return selectAgents(this.directory.agents, this.directory.markets, this.directory.sales, query).map(agentSummary);
  }
  agent(id: string): Agent | undefined { const found = this.directory.agents.find((agent) => agent.id === id); return found && agentView(found, this.seasons.get(id)); }
  /** An agent's rate seasons by `from` (migration 030); undefined for an unknown agent. */
  private seasons = new Map<string, RateSeason[]>();
  rateSeasons(agentId: string): RateSeason[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === agentId)) return undefined;
    return (this.seasons.get(agentId) ?? []).map((season) => ({ ...season }));
  }
  /** Replaces the table and appends `activity` to the agent's log, as legacy's `rtmSave` does. */
  setRateSeasons(agentId: string, seasons: readonly RateSeason[], activity: AgentActivity): RateSeason[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === agentId)) return undefined;
    this.seasons.set(agentId, seasons.map((season) => ({ ...season })));
    const log = this.directory.activity.get(agentId) ?? [];
    log.push({ ...activity, seq: log.reduce((max, entry) => Math.max(max, entry.seq), -1) + 1 });
    this.directory.activity.set(agentId, log);
    return this.rateSeasons(agentId);
  }
  /** Undefined for an unknown agent, so the route can answer 404 rather than an empty log. */
  agentActivity(id: string, limit: number): AgentActivity[] | undefined {
    if (!this.directory.agents.some((agent) => agent.id === id)) return undefined;
    return latestActivity(this.directory.activity.get(id) ?? [], limit);
  }

  // ── Sales editing (todo/sales-editing-model.md): the rules are `agent-writes.ts`'s and the
  //    other modules'; these only keep the rows, as PostgreSQL does. ──

  private copyAgent = (agent: StoredAgent): StoredAgent => ({ ...agent, programs: agent.programs.map((p) => ({ ...p })) });
  /** An agent as stored, for a write to start from; undefined when unknown. */
  agentRecord(id: string): StoredAgent | undefined { const found = this.directory.agents.find((a) => a.id === id); return found && this.copyAgent(found); }
  agentRecords(): StoredAgent[] { return this.directory.agents.map(this.copyAgent); }
  /** Inserts or replaces the agent, its programmes included, and appends the activity lines in order. */
  saveAgent(agent: StoredAgent, activity: readonly AgentActivity[]): void {
    const i = this.directory.agents.findIndex((a) => a.id === agent.id);
    if (i >= 0) this.directory.agents[i] = this.copyAgent(agent); else this.directory.agents.push(this.copyAgent(agent));
    this.addAgentActivity(agent.id, activity);
  }
  addAgentActivity(agentId: string, activity: readonly AgentActivity[]): void {
    if (!activity.length) return;
    const log = this.directory.activity.get(agentId) ?? [];
    for (const entry of activity) log.push({ ...entry, seq: log.length });
    this.directory.activity.set(agentId, log);
  }
  agentUsage(id: string): AgentUsage {
    return {
      bookings: [...this.bookings.values()].filter((b) => b.agent_id === id).length,
      contracts: this.contracts.filter((c) => c.agent_id === id).length,
      seat_locks: [...this.locks.values()].filter((l) => l.agent_id === id).length,
      invoices: [...this.invoices.values()].filter((i) => i.agent_id === id).length,
      logins: this.users.filter((u) => u.agent_id === id).length,
    };
  }
  deleteAgent(id: string): void {
    this.directory.agents = this.directory.agents.filter((a) => a.id !== id);
    this.directory.activity.delete(id);
    this.seasons.delete(id);
    this.history.delete(id);
    for (const doc of [...this.documents.values()]) if (doc.agent_id === id) this.documents.delete(doc.id);
  }
  private history = new Map<string, ContractHistoryEntry[]>();
  /** Newest first. */
  contractHistory(agentId: string): ContractHistoryEntry[] {
    return [...(this.history.get(agentId) ?? [])].reverse().map((h) => ({ ...h, programs: h.programs.map((p) => ({ ...p })), signatory: h.signatory && { ...h.signatory } }));
  }
  addContractHistory(agentId: string, entry: ContractHistoryEntry): void {
    this.history.set(agentId, [...(this.history.get(agentId) ?? []), { ...entry, programs: entry.programs.map((p) => ({ ...p })) }]);
  }
  /** Sets a contract's rate or document; legacy's `_ctSyncMainRate` and `ctArtifactSave` write nothing else. */
  setContractFields(id: string, fields: Partial<Pick<Contract, 'rate_type_id' | 'doc_id'>>): void {
    const found = this.contracts.find((c) => c.id === id);
    if (found) Object.assign(found, fields);
  }

  saveMarket(market: Market): void {
    const copy = { ...market, subs: [...market.subs] };
    const i = this.directory.markets.findIndex((m) => m.id === market.id);
    if (i >= 0) this.directory.markets[i] = copy; else this.directory.markets.push(copy);
  }
  deleteMarket(id: string): void { this.directory.markets = this.directory.markets.filter((m) => m.id !== id); }

  salesPerson(id: string): StoredSalesPerson | undefined { const found = this.directory.sales.find((p) => p.id === id); return found && { ...found }; }
  saveSalesPerson(person: StoredSalesPerson): void {
    const i = this.directory.sales.findIndex((p) => p.id === person.id);
    if (i >= 0) this.directory.sales[i] = { ...person }; else this.directory.sales.push({ ...person });
  }
  salesUsage(id: string): { logins: number; rate_types: number } {
    return { logins: this.users.filter((u) => u.sales_id === id).length, rate_types: [...this.rateTypes.values()].filter((r) => r.rate.owner_sales_id === id).length };
  }
  deleteSalesPerson(id: string): void { this.directory.sales = this.directory.sales.filter((p) => p.id !== id); }

  private templates = new Map<string, ContractTemplate>();
  private copyTemplate = (t: ContractTemplate): ContractTemplate => JSON.parse(JSON.stringify(t)) as ContractTemplate;
  listTemplates(): ContractTemplate[] { return sortTemplates([...this.templates.values()]).map(this.copyTemplate); }
  saveTemplate(template: ContractTemplate): void { this.templates.set(template.id, this.copyTemplate(template)); }
  /** Makes it the default, and active (legacy `cttSetDefault`); every other one stops being the default. */
  setDefaultTemplate(id: string, now: string): void {
    for (const t of this.templates.values()) {
      if (t.id === id) Object.assign(t, { is_default: true, active: true, updated_at: now });
      else if (t.is_default) Object.assign(t, { is_default: false, updated_at: now });
    }
  }
  deleteTemplate(id: string): void { this.templates.delete(id); }

  private documents = new Map<string, ContractDocument>();
  listDocuments(agentId: string): ContractDocument[] {
    return sortDocuments([...this.documents.values()].filter((d) => d.agent_id === agentId)).map((d) => JSON.parse(JSON.stringify(d)) as ContractDocument);
  }
  contractDocument(id: string): ContractDocument | undefined { const found = this.documents.get(id); return found && JSON.parse(JSON.stringify(found)) as ContractDocument; }
  addDocument(doc: ContractDocument): void { this.documents.set(doc.id, JSON.parse(JSON.stringify(doc)) as ContractDocument); }
  deleteDocument(id: string): void {
    this.documents.delete(id);
    for (const c of this.contracts) if (c.doc_id === id) c.doc_id = null;
  }

  private addonServices = new Map<string, AddonService>();
  listAddonServices(): AddonService[] { return sortAddonServices([...this.addonServices.values()]).map(addonServiceView); }
  addonService(id: string): AddonService | undefined { const found = this.addonServices.get(id); return found && addonServiceView(found); }
  saveAddonService(service: AddonService): void { this.addonServices.set(service.id, addonServiceView(service)); }
  deleteAddonService(id: string): void { this.addonServices.delete(id); }

  private nationalities: StoredNationality[] = builtinNationalities();
  listNationalities(): StoredNationality[] { return this.nationalities.map((n) => ({ ...n })); }
  addNationality(nationality: StoredNationality): void { this.nationalities.push({ ...nationality }); }

  /** The insurance command's result (`insurance.ts`): the lead's fields and the named passengers'. */
  setInsurance(bookingId: string, lead: InsuranceFields | undefined, passengers: ReadonlyMap<number, InsuranceFields>): void {
    const booking = this.bookings.get(bookingId);
    if (!booking) return;
    const put = (target: Record<string, unknown>, key: string, value: unknown) => { if (value === null) delete target[key]; else target[key] = value; };
    if (lead) {
      put(booking as Record<string, unknown>, 'lead_age', lead.age);
      put(booking as Record<string, unknown>, 'lead_insurance_reviewed_at', lead.reviewed_at);
      put(booking as Record<string, unknown>, 'lead_insurance_reviewed_by', lead.reviewed_by);
    }
    for (const p of booking.passengers) {
      const f = passengers.get(p.seq);
      if (!f) continue;
      put(p as Record<string, unknown>, 'age', f.age);
      put(p as Record<string, unknown>, 'insurance_reviewed_at', f.reviewed_at);
      put(p as Record<string, unknown>, 'insurance_reviewed_by', f.reviewed_by);
    }
  }

  /**
   * Rate types, held as the same rows PostgreSQL holds (`RateTypeRows`) so both stores hand
   * `rate-types.ts` identical input. Route and owner checks need the catalogue and the salespeople;
   * unseeded, there is nothing to check against and they are skipped, as bookings' routes are.
   */
  private rateTypes = new Map<string, RateTypeRows>();
  private routeCatalogue(): Map<string, CatalogueRoute> | undefined {
    return this.catalogue.routes.length === 0 ? undefined : new Map(this.catalogue.routes.map((route) => [route.id, { id: route.id, pier: route.pier }]));
  }
  private salesIds(): Set<string> | undefined {
    return this.directory.sales.length === 0 ? undefined : new Set(this.directory.sales.map((person) => person.id));
  }
  /** Agents' contracts (migration 029). Empty unless seeded: PostgreSQL gets them from `import:contracts`. */
  private contracts: Contract[] = [];
  seedContracts(contracts: readonly Contract[]): void { this.contracts = contracts.map(contractView); }
  listContracts(query: ContractListQuery): Contract[] { return selectContracts(this.contracts, query).map(contractView); }
  contract(id: string): Contract | undefined { const found = this.contracts.find((c) => c.id === id); return found && contractView(found); }

  /** Staff logins (migration 027), held as the rows PostgreSQL holds. Usernames are unique ignoring case. */
  private users: StoredUser[] = [];
  listUsers(): StoredUser[] { return this.users.map((user) => ({ ...user })).sort((a, b) => a.id - b.id); }
  user(id: number): StoredUser | undefined { const found = this.users.find((user) => user.id === id); return found && { ...found }; }
  userByUsername(username: string): StoredUser | undefined {
    const found = this.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
    return found && { ...found };
  }
  createUser(input: NewUser): StoredUser {
    if (this.userByUsername(input.username)) usernameTaken(input.username);
    const now = this.now();
    const user: StoredUser = { ...input, id: this.users.reduce((max, u) => Math.max(max, u.id), 0) + 1, created_at: now, updated_at: now };
    this.users.push(user);
    return { ...user };
  }
  updateUser(id: number, patch: UserPatch): StoredUser | undefined {
    const index = this.users.findIndex((user) => user.id === id);
    if (index < 0) return undefined;
    this.users[index] = { ...this.users[index], ...patch, updated_at: this.now() };
    return { ...this.users[index] };
  }

  listRateTypes(query: RateTypeListQuery): RateTypeSummary[] { return selectRateTypes([...this.rateTypes.values()], query); }
  rateType(id: string): RateType | undefined { const rows = this.rateTypes.get(id); return rows && rateTypeView(rows); }

  createRateType(input: RateTypeCreate): RateType {
    const catalogue = this.routeCatalogue();
    input.routes.forEach(({ route_id, block }, index) => assertRouteBlock(block, route_id, catalogue, `routes[${index}]`));
    assertOwner(input.header.owner, this.salesIds());
    const codes = new Set([...this.rateTypes.values()].map(({ rate }) => rate.code));
    if (input.header.id !== undefined && this.rateTypes.has(input.header.id)) rateTypeExists('id', input.header.id);
    if (input.header.code !== undefined && codes.has(input.header.code)) rateTypeExists('code', input.header.code);
    const id = input.header.id ?? this.id('rt');
    const rows: RateTypeRows = { rate: newRateTypeRow(input.header, id, input.header.code ?? generateRateTypeCode(input.header.name, codes), this.now()), routes: [], seat: [], charter: [], longtail: [], transfer: [] };
    input.routes.forEach(({ route_id, block }, seq) => addRouteRows(rows, routeRows(id, route_id, seq, block)));
    this.rateTypes.set(id, rows);
    return rateTypeView(rows);
  }

  patchRateType(id: string, patch: RateTypePatch): RateType | undefined {
    const rows = this.rateTypes.get(id);
    if (!rows) return undefined;
    assertOwner(patch.owner, this.salesIds());
    rows.rate = patchedRateTypeRow(rows.rate, patch, this.now());
    return rateTypeView(rows);
  }

  /** Replaces one route's block; a route new to the rate goes after the ones it has. */
  putRateTypeRoute(id: string, routeId: string, block: RouteBlock): RateType | undefined {
    const rows = this.rateTypes.get(id);
    if (!rows) return undefined;
    assertRouteBlock(block, routeId, this.routeCatalogue(), '');
    const seq = rows.routes.find((route) => route.route_id === routeId)?.seq ?? nextRouteSeq(rows.routes);
    removeRouteRows(rows, routeId);
    addRouteRows(rows, routeRows(id, routeId, seq, block));
    rows.rate = { ...rows.rate, updated_at: this.now() };
    return rateTypeView(rows);
  }

  /** Undefined for an unknown rate type, false for a route the rate does not cover. */
  deleteRateTypeRoute(id: string, routeId: string): boolean | undefined {
    const rows = this.rateTypes.get(id);
    if (!rows) return undefined;
    if (!rows.routes.some((route) => route.route_id === routeId)) return false;
    removeRouteRows(rows, routeId);
    rows.rate = { ...rows.rate, updated_at: this.now() };
    return true;
  }

  deleteRateType(id: string): boolean {
    if (!this.rateTypes.has(id)) return false;
    assertRateTypeUnused(id, {
      agents: this.directory.agents.filter((agent) => agent.rate_type_id === id || (this.seasons.get(agent.id) ?? []).some((season) => season.rate_type_id === id)).length,
      bookings: [...this.bookings.values()].filter((booking) => booking.rate_type_ref === id).length,
    });
    this.rateTypes.delete(id);
    return true;
  }

  /** Loads reference data that a PostgreSQL deployment gets from migrations instead. */
  seedCatalogue(catalogue: Partial<{ routes: Route[]; seasons: RouteSeason[]; overrides: RouteDayOverride[]; boats: Boat[]; boatOverrides: BoatCapacityOverride[] }>): void {
    // `kind` defaults the way the column does, so both stores list the same route the same way.
    if (catalogue.routes) this.catalogue.routes = catalogue.routes.map((route) => ({ ...route, kind: route.kind ?? 'marine' }));
    if (catalogue.seasons) this.catalogue.seasons = catalogue.seasons.map((season) => ({ ...season }));
    if (catalogue.overrides) this.catalogue.overrides = catalogue.overrides.map((override) => ({ ...override }));
    if (catalogue.boats) this.catalogue.boats = catalogue.boats.map((boat) => blankBoat(boat));
    if (catalogue.boatOverrides) this.catalogue.boatOverrides = catalogue.boatOverrides.map((override) => ({ ...override }));
  }
  private boatOverride(boatId: string, serviceDate: string): number | undefined {
    return this.catalogue.boatOverrides.find((o) => o.boat_id === boatId && o.service_date === serviceDate)?.capacity;
  }
  /** By `sort`, unsorted last, as PostgreSQL lists them; otherwise in the order they came (a sort is stable). */
  listRoutes(): Route[] {
    return [...this.catalogue.routes].sort((a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity) || 0)
      .map((route) => ({ ...route, ...(route.times ? { times: [...route.times] } : {}) }));
  }
  /** Empty unless seeded, like the rest of the catalogue: with no database there is nothing to read. */
  listBoats(): Boat[] { return this.boatRecords().map(boatOf); }

  // ── Editing the catalogue (todo/catalogue-editing-model.md; the rules are `catalogue.ts`'s) ──
  listRouteFamilies(): RouteFamily[] { return sortFamilies(this.catalogue.families); }
  insertRouteFamily(family: RouteFamily): void { this.catalogue.families.push({ ...family }); }
  updateRouteFamily(id: string, patch: Partial<Omit<RouteFamily, 'id'>>): RouteFamily | undefined {
    const found = this.catalogue.families.find((f) => f.id === id);
    if (!found) return undefined;
    Object.assign(found, patch);
    return { ...found };
  }
  familyUsage(id: string): number { return this.catalogue.routes.filter((r) => r.family_id === id).length; }
  deleteRouteFamily(id: string): boolean {
    const before = this.catalogue.families.length;
    this.catalogue.families = this.catalogue.families.filter((f) => f.id !== id);
    return this.catalogue.families.length < before;
  }
  route(id: string): Route | undefined { return this.listRoutes().find((r) => r.id === id); }
  routeByExtId(extId: string): Route | undefined { return this.listRoutes().find((r) => r.ext_id === extId); }
  /** A new route and the seasons it starts with. The `sort` and colour are `newRoute`'s. */
  insertRoute(route: Route, seasons: readonly RouteSeason[]): void {
    this.catalogue.routes.push({ ...route, times: [...(route.times ?? [])] });
    this.catalogue.seasons.push(...seasons.map((s) => ({ ...s })));
  }
  updateRoute(id: string, fields: RouteFields): void {
    const index = this.catalogue.routes.findIndex((r) => r.id === id);
    if (index < 0) return;
    const venue = this.catalogue.routes[index].meal_venue_id;
    this.catalogue.routes[index] = { ...compactRoute({ ...fields, id, sort: this.catalogue.routes[index].sort }), ...(venue ? { meal_venue_id: venue } : {}) };
  }
  /** The route's restaurant for costing (migration 160); null clears it. */
  setRouteMealVenue(id: string, venueId: string | null): void {
    const route = this.catalogue.routes.find((r) => r.id === id);
    if (!route) return;
    if (venueId) route.meal_venue_id = venueId; else delete route.meal_venue_id;
  }
  setRouteSorts(sorts: ReadonlyMap<string, number>): void {
    this.catalogue.routes = this.catalogue.routes.map((r) => (sorts.has(r.id) ? { ...r, sort: sorts.get(r.id) } : r));
  }
  /** Its times, seasons and day overrides go with it, as PostgreSQL's ON DELETE CASCADE takes them. */
  deleteRoute(id: string): boolean {
    const before = this.catalogue.routes.length;
    this.catalogue.routes = this.catalogue.routes.filter((r) => r.id !== id);
    this.catalogue.seasons = this.catalogue.seasons.filter((s) => s.route_id !== id);
    this.catalogue.overrides = this.catalogue.overrides.filter((o) => o.route_id !== id);
    return this.catalogue.routes.length < before;
  }
  routeUsage(id: string): RouteUsage {
    const bookings = [...this.bookings.values()];
    const rateRows = [...this.rateTypes.values()];
    return {
      bookings: bookings.filter((b) => b.trips.some((t) => t.route_id === id)).length,
      deployments: this.deployments.filter((d) => d.route_id === id).length,
      seat_locks: [...this.locks.values()].filter((l) => l.route_id === id).length,
      rate_types: rateRows.filter((r) => r.routes.some((x) => x.route_id === id)).length,
      agents: this.directory.agents.filter((a) => a.programs.some((p) => p.route_id === id)).length,
      contracts: this.contracts.filter((c) => c.program_periods.some((p) => p.route_id === id) || c.seat_prices.some((p) => p.route_id === id)).length,
      van_days: [...this.vanDayRows.values()].filter((d) => d.route_ids.includes(id)).length,
      van_groups: [...this.vanGroups.values()].filter((g) => g.route_id === id).length,
      van_stops: [...this.vanStops.values()].filter((s) => s.route_id === id).length,
      upgrades: this.tripUpgrades.filter((u) => u.from_route_id === id || u.to_route_id === id).length,
      pickup_times: this.pickupCells.filter((c) => c.route_id === id).length,
    };
  }

  /** Every field of every boat, by name then id as PostgreSQL lists them. */
  boatRecords(): BoatRecord[] {
    return [...this.catalogue.boats].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(copyBoat);
  }
  boatRecord(id: string): BoatRecord | undefined { const b = this.catalogue.boats.find((x) => x.id === id); return b && copyBoat(b); }
  /** Creates or replaces the boat with its documents and status log, stamped as edited here. */
  writeBoat(boat: BoatRecord, now: string): BoatRecord {
    const saved = { ...copyBoat(boat), updated_at: now };
    const index = this.catalogue.boats.findIndex((b) => b.id === boat.id);
    if (index >= 0) this.catalogue.boats[index] = saved; else this.catalogue.boats.push(saved);
    return copyBoat(saved);
  }
  /** The boat's numbers onto each of its deployments from `from` on; answers the days changed. */
  updateBoatDeployments(boatId: string, from: string, numbers: Pick<Deployment, 'capacity' | 'license_pax' | 'registered_persons'>): Deployment[] {
    const changed: Deployment[] = [];
    this.deployments = this.deployments.map((d) => {
      if (d.boat_id !== boatId || d.service_date < from) return d;
      const next = { ...d, ...numbers };
      changed.push({ ...next });
      return next;
    });
    return changed;
  }
  boatDeploymentsFrom(boatId: string, from: string): Deployment[] {
    return this.deployments.filter((d) => d.boat_id === boatId && d.service_date >= from)
      .sort((a, b) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : 0)).map((d) => ({ ...d }));
  }
  boatCapacityOverrides(boatId: string, from?: string, to?: string): StoredOverride[] {
    return this.catalogue.boatOverrides.filter((o) => o.boat_id === boatId && (!from || o.service_date >= from) && (!to || o.service_date <= to))
      .sort((a, b) => (a.service_date < b.service_date ? -1 : 1))
      .map((o) => ({ boat_id: o.boat_id, service_date: o.service_date, capacity: o.capacity, reason: o.reason ?? null, set_by: o.set_by ?? null, set_at: o.set_at ?? null }));
  }
  deleteBoatCapacityOverride(boatId: string, date: string): boolean {
    const before = this.catalogue.boatOverrides.length;
    this.catalogue.boatOverrides = this.catalogue.boatOverrides.filter((o) => !(o.boat_id === boatId && o.service_date === date));
    return this.catalogue.boatOverrides.length < before;
  }
  listSeasons(): RouteSeason[] { return this.catalogue.seasons.map((season) => ({ ...season })); }
  listDayOverrides(from?: string, to?: string): RouteDayOverride[] {
    return this.catalogue.overrides.filter((o) => (!from || o.service_date >= from) && (!to || o.service_date <= to)).map((o) => ({ ...o }));
  }

  /**
   * One edit to a route's calendar (`applyCalendarChange`), refused when it would close a day that
   * holds bookings or a boat from `today` on, unless `closeAnyway` (`assertCloseAllowed`). Unseeded,
   * any route id is accepted, as bookings accept any.
   */
  changeCalendar(routeId: string, change: CalendarChange, closeAnyway: boolean, today: string): void {
    if (this.catalogue.routes.length > 0 && !this.catalogue.routes.some((route) => route.id === routeId)) refuse('Route not found', 404);
    const seasons = this.catalogue.seasons.filter((s) => s.route_id === routeId);
    const overrides = this.catalogue.overrides.filter((o) => o.route_id === routeId);
    const next = applyCalendarChange(seasons, overrides, change);
    const holds: CalendarHold[] = [];
    for (const booking of this.bookings.values()) {
      if (!holdsSeats(booking.status)) continue;
      for (const trip of booking.trips) if (trip.route_id === routeId && trip.service_date >= today) holds.push({ service_date: trip.service_date, booking_ref: booking.voucher_ref ?? booking.id });
    }
    for (const d of this.deployments) if (d.route_id === routeId && d.service_date >= today) holds.push({ service_date: d.service_date, boat_id: d.boat_id });
    assertCloseAllowed(routeId, routeCalendar(seasons, overrides), routeCalendar(next.seasons, next.overrides), holds, closeAnyway);
    this.catalogue.seasons = [...this.catalogue.seasons.filter((s) => s.route_id !== routeId), ...next.seasons];
    this.catalogue.overrides = [...this.catalogue.overrides.filter((o) => o.route_id !== routeId), ...next.overrides];
  }
  newSeasonId(): string { return this.id('season'); }

  // ── Fleet, part A (todo/fleet-maintenance-model.md; migration 130): the rules are `fleet-*.ts`'s ──
  private fleet = {
    engine: new Map<string, Engine>(), gearbox: new Map<string, Gearbox>(), propeller: new Map<string, Propeller>(),
    incidents: new Map<string, Incident>(), jobs: new Map<string, Job>(),
  };
  private fleetMap<K extends AssetKind>(kind: K): Map<string, AssetOf[K]> { return this.fleet[kind] as unknown as Map<string, AssetOf[K]>; }
  fleetAssets<K extends AssetKind>(kind: K, q: AssetQuery = {}): AssetOf[K][] {
    return sortAssets([...this.fleetMap(kind).values()].filter((a) => matchesAsset(a, q))).map((a) => copyAsset(a));
  }
  fleetAsset<K extends AssetKind>(kind: K, id: string): AssetOf[K] | undefined { const a = this.fleetMap(kind).get(id); return a && copyAsset(a); }
  putFleetAsset<K extends AssetKind>(kind: K, asset: AssetOf[K]): void { this.fleetMap(kind).set(asset.id, copyAsset(asset)); }
  fleetIncidents(q: IncidentQuery = {}): Incident[] { return sortIncidents([...this.fleet.incidents.values()].filter((i) => matchesIncident(i, q))).map(copyIncident); }
  fleetIncident(id: string): Incident | undefined { const i = this.fleet.incidents.get(id); return i && copyIncident(i); }
  putFleetIncident(incident: Incident): void { this.fleet.incidents.set(incident.id, copyIncident(incident)); }
  deleteFleetIncident(id: string): boolean { return this.fleet.incidents.delete(id); }
  fleetJobs(q: JobQuery = {}): Job[] { return sortJobs([...this.fleet.jobs.values()].filter((j) => matchesJob(j, q))).map(copyJob); }
  fleetJob(id: string): Job | undefined { const j = this.fleet.jobs.get(id); return j && copyJob(j); }
  putFleetJob(job: Job): void { this.fleet.jobs.set(job.id, copyJob(job)); }
  deleteFleetJob(id: string): boolean { return this.fleet.jobs.delete(id); }
  /** Every number in use, to refuse a duplicate and to answer the next one. */
  fleetNumbers(table: 'incidents' | 'jobs'): { id: string; no: string }[] { return [...this.fleet[table].values()].map((x) => ({ id: x.id, no: x.no })); }

  async transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }

  private now(): string { return new Date().toISOString(); }
  private id(prefix: string): string { return `${prefix}_${crypto.randomUUID()}`; }

  private view(stored: StoredBooking): Booking {
    return bookingView(stored, (trip) => dispatchView(this.dispatch.get(trip.id), this.deployedBoats(trip.route_id, trip.service_date),
      vanPartsView(this.vanParts.get(trip.id) ?? [], trip.pax, this.vanGroups), checkinsView(this.checkins.get(trip.id) ?? []),
      activeUpgrade(this.tripUpgrades.filter((u) => u.booking_trip_id === trip.id))), this.reconfirms.get(stored.id) ?? null, this.fileRefs(), this.docChecks.get(stored.id) ?? null,
      this.invoiceBriefs(stored.id));
  }
  private deployedBoats(routeId: string, date: string): Set<string> {
    return new Set(this.deployments.filter((d) => d.route_id === routeId && d.service_date === date).map((d) => d.boat_id));
  }

  /** Each trip's check-in records (migration 036), by trip id. */
  private checkins = new Map<string, StoredCheckin[]>();
  /** Replaces one record. */
  setCheckin(tripId: string, record: StoredCheckin): void {
    const others = (this.checkins.get(tripId) ?? []).filter((r) => !(r.kind === record.kind && r.slot === record.slot));
    this.checkins.set(tripId, [...others, copyCheckin(record)]);
  }
  deleteCheckin(tripId: string, kind: CheckinKind, slot: number): boolean {
    const before = this.checkins.get(tripId) ?? [];
    const after = before.filter((r) => !(r.kind === kind && r.slot === slot));
    this.checkins.set(tripId, after);
    return after.length < before.length;
  }

  // ── The change feed (migration 044) ──
  private changeLog: Change[] = [];
  private changeListeners = new Set<() => void>();
  /** Transactions run one at a time here, so numbering on write is commit order. */
  recordChanges(rows: readonly ChangeInput[]): void {
    for (const c of rows) this.changeLog.push({ ...c, version: this.changeLog.length + 1, changed_at: this.now() });
    if (rows.length) for (const fn of this.changeListeners) fn();
  }
  changesSince(since: number, limit: number): Change[] { return this.changeLog.filter((c) => c.version > since).slice(0, limit).map((c) => ({ ...c })); }
  latestChangeVersion(): number { return this.changeLog.length; }
  subscribeChanges(onChange: () => void): () => void { this.changeListeners.add(onChange); return () => { this.changeListeners.delete(onChange); }; }
  /** No database, so nothing to migrate. */
  migrationsPending(): number { return 0; }

  // ── Love Kingdom's held orders (migration 100, `b2c.ts`) ──
  private heldOrders = new Map<string, HeldOrder>();
  /** Newest first (`sortHeld`). `status` absent lists every one. */
  listHeldOrders(query: { status?: HeldStatus; externalId?: string } = {}): HeldOrder[] {
    return sortHeld([...this.heldOrders.values()].filter((h) => (!query.status || h.status === query.status) && (query.externalId === undefined || h.external_id === query.externalId)))
      .map((h) => structuredClone(h));
  }
  heldOrder(id: string): HeldOrder | undefined { const found = this.heldOrders.get(id); return found && structuredClone(found); }
  /** Inserts or replaces one, whole: what to write is `holdOrder`'s and `decideHeld`'s decision. */
  putHeldOrder(order: HeldOrder): void { this.heldOrders.set(order.id, structuredClone(order)); }

  // ── Pickup areas and pickup times (migration 043) ──
  private pickupAreas = new Map<string, PickupArea>();
  private timeProfiles = new Map<string, TimeProfile>();
  private pickupCells: PickupCell[] = [];
  listPickupAreas(): PickupArea[] { return [...this.pickupAreas.values()].map((a) => ({ ...a })); }
  putPickupArea(area: PickupArea): void { this.pickupAreas.set(area.id, { ...area }); }
  listTimeProfiles(): TimeProfile[] { return [...this.timeProfiles.values()].map((p) => ({ ...p })); }
  putTimeProfile(profile: TimeProfile): void { this.timeProfiles.set(profile.id, { ...profile }); }
  deleteTimeProfile(id: string): boolean {
    this.pickupCells = this.pickupCells.filter((c) => c.profile_id !== id);
    return this.timeProfiles.delete(id);
  }
  listPickupTimes(profileId?: string): PickupCell[] { return this.pickupCells.filter((c) => profileId === undefined || c.profile_id === profileId).map((c) => ({ ...c })); }
  putPickupTime(cell: PickupCell): void {
    this.pickupCells = [...this.pickupCells.filter((c) => !(c.profile_id === cell.profile_id && c.route_id === cell.route_id && c.target === cell.target)), { ...cell }];
  }
  deletePickupTime(profileId: string, routeId: string, target: string): boolean {
    const before = this.pickupCells.length;
    this.pickupCells = this.pickupCells.filter((c) => !(c.profile_id === profileId && c.route_id === routeId && c.target === target));
    return this.pickupCells.length < before;
  }

  /** Each booking's document check (migration 042). */
  private docChecks = new Map<string, DocCheck>();
  setDocCheck(bookingId: string, d: DocCheck): void { this.docChecks.set(bookingId, copyDocCheck(d)); }

  /** The pier's meal editor: who changed the meals there, and when (migration 041). */
  stampPierMeals(id: string, at: string, by: string | null): void {
    const booking = this.bookings.get(id);
    if (booking) { booking.special_meals_pier_at = at; booking.special_meals_pier_by = by ?? undefined; }
  }

  // ── Attachments (migration 040) ──
  private files = new Map<string, StoredFile>();
  private fileRefs(): Map<string, AttachmentRef> {
    return new Map([...this.files.values()].map((f) => [f.id, { id: f.id, name: f.name, mime: f.mime, size: f.size }]));
  }
  putAttachment(file: StoredFile): void { this.files.set(file.id, { ...file }); }
  attachmentFile(id: string): StoredFile | undefined { const f = this.files.get(id); return f && { ...f }; }
  /** The files that exist among `ids`. */
  attachmentRefs(ids: readonly string[]): Map<string, AttachmentRef> { const all = this.fileRefs(); return new Map(ids.filter((id) => all.has(id)).map((id) => [id, all.get(id)!])); }
  /** The bookings that point at a file, by their documents or their upgrade slips. */
  attachmentBookings(id: string): Booking[] {
    const slipped = new Set([...this.payments.values()].filter((p) => p.slips.includes(id)).flatMap((p) => bookingIdsOf(this.invoices.get(p.invoice_id) ?? { lines: [] })));
    for (const p of this.pierRows.values()) if (p.slips.includes(id)) slipped.add(p.booking_id);
    for (const s of this.saleRows.values()) if (s.slips.includes(id)) slipped.add(s.booking_id);
    for (const d of this.cotRows) if (d.slips.includes(id)) slipped.add(d.booking_id);
    return [...this.bookings.values()].filter((b) => b.attachments.some((d) => d.attachment_id === id) || b.upgrades.some((u) => u.slips.includes(id)) || slipped.has(b.id)).map((b) => this.view(b));
  }

  // ── Invoices and payments (migration 045) ──
  private invoices = new Map<string, StoredInvoice>();
  private payments = new Map<string, StoredPayment>();
  private invoiceCounters = new Map<string, number>();
  /** As PostgreSQL's: the invoices naming the booking on a line not taken off. */
  private invoiceBriefs(bookingId: string): InvoiceBrief[] {
    return [...this.invoices.values()].filter((i) => i.lines.some((l) => l.booking_id === bookingId && !l.removed_at)).map((i) => ({
      id: i.id, number: i.number, kind: i.kind, fee_type: i.fee_type, total: i.total, issued_at: i.issued_at, voided: i.voided,
      paid: [...this.payments.values()].filter((p) => p.invoice_id === i.id && !p.deleted_at).map((p) => p.amount),
      returned: returnedOf([...this.refundRows.values()].filter((r) => r.invoice_id === i.id)),
    }));
  }
  /** The next number of the month: one past the counter, or past the highest number already issued (an import). */
  nextInvoiceNumber(month: string): number {
    const issued = [...this.invoices.values()].map((i) => new RegExp(`^INV-${month}-(\\d+)`).exec(i.number)).map((m) => (m ? Number(m[1]) : 0));
    const next = Math.max(this.invoiceCounters.get(month) ?? 0, ...issued) + 1;
    this.invoiceCounters.set(month, next);
    return next;
  }
  putInvoice(invoice: StoredInvoice): void { this.invoices.set(invoice.id, copyInvoice(invoice)); }
  invoice(id: string): StoredInvoice | undefined { const i = this.invoices.get(id); return i && copyInvoice(i); }
  /** Oldest first. */
  listInvoices(q: { agentId?: string; bookingId?: string } = {}): StoredInvoice[] {
    return [...this.invoices.values()].filter((i) => (!q.agentId || i.agent_id === q.agentId) && (!q.bookingId || i.lines.some((l) => l.booking_id === q.bookingId)))
      .sort((a, b) => (a.issued_at === b.issued_at ? (a.id < b.id ? -1 : 1) : a.issued_at < b.issued_at ? -1 : 1)).map(copyInvoice);
  }
  invoicesOfBookings(ids: readonly string[]): StoredInvoice[] { return this.listInvoices().filter((i) => i.lines.some((l) => l.booking_id && ids.includes(l.booking_id))); }
  putPayment(payment: StoredPayment): void { this.payments.set(payment.id, { ...payment, slips: [...payment.slips] }); }
  /** Deleted ones too, oldest first. */
  paymentsOf(invoiceIds: readonly string[]): StoredPayment[] {
    return [...this.payments.values()].filter((p) => invoiceIds.includes(p.invoice_id))
      .sort((a, b) => (a.recorded_at === b.recorded_at ? (a.id < b.id ? -1 : 1) : a.recorded_at < b.recorded_at ? -1 : 1)).map((p) => ({ ...p, slips: [...p.slips] }));
  }
  deleteAttachment(id: string): boolean { return this.files.delete(id); }

  // ── Refunds and credits (migration 061) ──
  private refundRows = new Map<string, StoredRefund>();
  putRefund(refund: StoredRefund): void { this.refundRows.set(refund.id, { ...refund }); }
  /** Oldest first. */
  listRefunds(q: { invoiceIds?: readonly string[]; agentId?: string; bookingId?: string } = {}): StoredRefund[] {
    return [...this.refundRows.values()].filter((r) => (!q.invoiceIds || q.invoiceIds.includes(r.invoice_id)) && (!q.agentId || r.agent_id === q.agentId) && (!q.bookingId || r.booking_id === q.bookingId))
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1)).map((r) => ({ ...r }));
  }

  // ── Weather closures (migration 060) ──
  private weatherClosures = new Map<string, WeatherClosure>();
  private weatherCaseRows: WeatherCase[] = [];
  listWeatherClosures(q: Partial<ClosureListQuery> = {}): WeatherClosure[] {
    return sortClosures([...this.weatherClosures.values()].filter((c) => matchesClosureQuery(c, q))).map((c) => ({ ...c }));
  }
  weatherClosure(id: string): WeatherClosure | undefined { const c = this.weatherClosures.get(id); return c && { ...c }; }
  /** As PostgreSQL's unique index: one open closure per trip. */
  putWeatherClosure(closure: WeatherClosure): void {
    const clash = [...this.weatherClosures.values()].find((c) => c.id !== closure.id && c.reopened_at === null && closure.reopened_at === null
      && c.route_id === closure.route_id && c.service_date === closure.service_date);
    if (clash) planClose(closure, clash, closure.id, closure.closed_at, closure.closed_by);
    this.weatherClosures.set(closure.id, { ...closure });
  }
  /** By booking id. */
  weatherCases(closureId: string): WeatherCase[] {
    return this.weatherCaseRows.filter((r) => r.closure_id === closureId).sort((a, b) => (a.booking_id < b.booking_id ? -1 : 1)).map((r) => ({ ...r }));
  }
  weatherCasesOfBooking(bookingId: string): WeatherCase[] {
    return this.weatherCaseRows.filter((r) => r.booking_id === bookingId).sort((a, b) => (a.closure_id < b.closure_id ? -1 : 1)).map((r) => ({ ...r }));
  }
  putWeatherCase(row: WeatherCase): void {
    this.weatherCaseRows = [...this.weatherCaseRows.filter((r) => !(r.closure_id === row.closure_id && r.booking_id === row.booking_id)), { ...row }];
  }
  deleteWeatherCase(closureId: string, bookingId: string): void {
    this.weatherCaseRows = this.weatherCaseRows.filter((r) => !(r.closure_id === closureId && r.booking_id === bookingId));
  }

  // ── Money: proforma, pier money, after the trip (migrations 110–112) ──
  private pfmRows: PfmEvent[] = [];
  private pierRows = new Map<string, StoredPierPayment>();
  private saleRows = new Map<string, StoredTourSale>();
  private cotRows: StoredCotDecision[] = [];
  private noshowRows: StoredNoshowCharge[] = [];
  private handoverRows = new Map<string, StoredHandover>();
  private payoutRows = new Map<string, StoredPayout>();
  /** A command that writes beside the booking (a pier payment, a decision): the booking's version moves on. */
  bumpBooking(id: string, actor?: string): void { const b = this.bookings.get(id); if (b) this.touch(b, actor); }
  pfmEvents(bookingIds: readonly string[]): PfmEvent[] {
    return this.pfmRows.filter((e) => bookingIds.includes(e.booking_id)).sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1)).map((e) => ({ ...e }));
  }
  addPfmEvent(e: Omit<PfmEvent, 'id'>): void { this.pfmRows.push({ ...e, id: this.pfmRows.length + 1 }); }
  /** Deleted ones too, oldest first. */
  pierPayments(bookingIds: readonly string[]): StoredPierPayment[] {
    return [...this.pierRows.values()].filter((p) => bookingIds.includes(p.booking_id)).sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
      .map((p) => ({ ...p, slips: [...p.slips] }));
  }
  putPierPayment(p: StoredPierPayment): void { this.pierRows.set(p.id, { ...p, slips: [...p.slips] }); }
  /** Oldest first. */
  tourSales(bookingIds: readonly string[]): StoredTourSale[] {
    return [...this.saleRows.values()].filter((s) => bookingIds.includes(s.booking_id)).sort((a, b) => (a.sold_at === b.sold_at ? (a.id < b.id ? -1 : 1) : a.sold_at < b.sold_at ? -1 : 1))
      .map((s) => ({ ...s, slips: [...s.slips] }));
  }
  putTourSale(s: StoredTourSale): void { this.saleRows.set(s.id, { ...s, slips: [...s.slips] }); }
  deleteTourSale(id: string): void { this.saleRows.delete(id); }
  cotDecisions(bookingIds: readonly string[]): StoredCotDecision[] {
    return this.cotRows.filter((d) => bookingIds.includes(d.booking_id)).sort((a, b) => (a.booking_id === b.booking_id ? (a.service_date < b.service_date ? -1 : 1) : a.booking_id < b.booking_id ? -1 : 1))
      .map((d) => ({ ...d, slips: [...d.slips] }));
  }
  putCotDecision(d: StoredCotDecision): void {
    this.cotRows = [...this.cotRows.filter((x) => !(x.booking_id === d.booking_id && x.service_date === d.service_date)), { ...d, slips: [...d.slips] }];
  }
  deleteCotDecision(bookingId: string, date: string): boolean {
    const before = this.cotRows.length;
    this.cotRows = this.cotRows.filter((x) => !(x.booking_id === bookingId && x.service_date === date));
    return this.cotRows.length < before;
  }
  noshowCharges(bookingIds: readonly string[]): StoredNoshowCharge[] {
    return this.noshowRows.filter((c) => bookingIds.includes(c.booking_id)).sort((a, b) => (a.booking_id === b.booking_id ? (a.service_date < b.service_date ? -1 : 1) : a.booking_id < b.booking_id ? -1 : 1))
      .map((c) => ({ ...c }));
  }
  putNoshowCharge(c: StoredNoshowCharge): void {
    this.noshowRows = [...this.noshowRows.filter((x) => !(x.booking_id === c.booking_id && x.service_date === c.service_date)), { ...c }];
  }
  deleteNoshowCharge(bookingId: string, date: string): boolean {
    const before = this.noshowRows.length;
    this.noshowRows = this.noshowRows.filter((x) => !(x.booking_id === bookingId && x.service_date === date));
    return this.noshowRows.length < before;
  }
  /** By day, then pier, then when handed over. */
  handovers(q: { from?: string; to?: string; pier?: string; ids?: readonly string[] } = {}): StoredHandover[] {
    return [...this.handoverRows.values()].filter((h) => (!q.from || h.service_date >= q.from) && (!q.to || h.service_date <= q.to) && (!q.pier || h.pier === q.pier) && (!q.ids || q.ids.includes(h.id)))
      .sort((a, b) => (a.service_date !== b.service_date ? (a.service_date < b.service_date ? -1 : 1) : a.pier !== b.pier ? (a.pier < b.pier ? -1 : 1) : a.handed_at === b.handed_at ? (a.id < b.id ? -1 : 1) : a.handed_at < b.handed_at ? -1 : 1))
      .map((h) => ({ ...h, expected: { ...h.expected } }));
  }
  /** As PostgreSQL's unique index: one live hand-over per day and pier. */
  putHandover(h: StoredHandover): void {
    const clash = [...this.handoverRows.values()].find((x) => x.id !== h.id && !x.voided_at && !h.voided_at && x.service_date === h.service_date && x.pier === h.pier);
    if (clash) refuse(`${h.pier} was already handed over for ${h.service_date}`, 409, 'already_handed_over');
    this.handoverRows.set(h.id, { ...h, expected: { ...h.expected } });
  }
  /** Newest last. */
  payouts(q: { seller?: string; from?: string; to?: string; ids?: readonly string[] } = {}): StoredPayout[] {
    return [...this.payoutRows.values()].filter((p) => (!q.seller || p.seller === q.seller) && (!q.from || p.paid_on >= q.from) && (!q.to || p.paid_on <= q.to) && (!q.ids || q.ids.includes(p.id)))
      .sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
      .map((p) => ({ ...p, items: [...p.items].sort((x, y) => (x.kind !== y.kind ? (x.kind < y.kind ? -1 : 1) : x.booking_id !== y.booking_id ? (x.booking_id < y.booking_id ? -1 : 1) : x.item_id < y.item_id ? -1 : 1)).map((i) => ({ ...i })) }));
  }
  putPayout(p: StoredPayout): void { this.payoutRows.set(p.id, { ...p, items: p.items.map((i) => ({ ...i })) }); }

  /** Route upgrades (migration 038), kept after an undo. */
  private tripUpgrades: TripUpgrade[] = [];
  private tripUpgradeSeq = 0;
  /** Moves one trip to another route through the ordinary edit, which checks the route's calendar and seats. */
  upgradeRoute(id: string, tripId: string, routeId: string, actor: string | undefined, entry: HistoryLine): Booking | undefined {
    const booking = this.bookings.get(id);
    return booking && this.amendBooking(id, { trips: retargetTrip(booking.trips, tripId, routeId) }, actor, entry);
  }
  /** Replaces the upgrades list as given, writing no history (a route upgrade's charge). */
  setUpgrades(bookingId: string, upgrades: readonly StoredUpgrade[]): void {
    const booking = this.bookings.get(bookingId);
    if (booking) booking.upgrades = upgrades.map((u) => ({ ...u }));
  }
  tripUpgradesOf(tripId: string): TripUpgrade[] { return this.tripUpgrades.filter((u) => u.booking_trip_id === tripId).map((u) => ({ ...u })); }
  addTripUpgrade(row: Omit<TripUpgrade, 'id'>): TripUpgrade {
    const saved = { ...row, id: ++this.tripUpgradeSeq };
    this.tripUpgrades.push(saved);
    return { ...saved };
  }
  undoTripUpgrade(id: number, at: string, by: string | null): void {
    this.tripUpgrades = this.tripUpgrades.map((u) => (u.id === id ? { ...u, undone_at: at, undone_by: by } : u));
  }

  /** Each booking's reconfirmation (migration 035), by booking id. */
  private reconfirms = new Map<string, StoredReconfirm>();
  /** `null` removes it. */
  setReconfirm(bookingId: string, record: StoredReconfirm | null): void {
    if (record) this.reconfirms.set(bookingId, { ...record }); else this.reconfirms.delete(bookingId);
  }
  /** Appends a line to a booking's history, inside the write it describes. */
  addHistory(bookingId: string, line: HistoryLine): void { this.log(bookingId, line); }

  /** Each trip's dispatch (migration 033), by trip id. */
  private dispatch = new Map<string, StoredDispatch>();
  /**
   * Replaces a booking's trips. As PostgreSQL's `writeTrips`: a removed trip's dispatch goes, a trip
   * moved to another route or day keeps only its pier note (legacy `bkOpsClear`), and a trip whose
   * passengers changed loses its boat split, which no longer adds up.
   */
  private retrip(booking: StoredBooking, planned: StoredTrip[]): void {
    const keep = new Set(planned.map((trip) => trip.id));
    for (const trip of booking.trips) if (!keep.has(trip.id)) { this.dispatch.delete(trip.id); this.vanParts.delete(trip.id); this.checkins.delete(trip.id); }
    for (const id of movedTripIds(booking.trips, planned)) { const d = this.dispatch.get(id); if (d) this.dispatch.set(id, clearedOnMove(d)); this.vanParts.delete(id); this.checkins.delete(id); }
    for (const id of paxChangedTripIds(booking.trips, planned)) {
      const d = this.dispatch.get(id);
      if (d) d.boat_splits = [];
      const parts = this.vanParts.get(id);
      if (parts) this.setVanParts(id, rebalanceParts(parts, planned.find((t) => t.id === id)!.pax));
    }
    booking.trips = planned;
  }
  /** The trip, its booking and its dispatch as stored, for a dispatch write; undefined for an unknown trip. */
  tripForDispatch(tripId: string): { booking: Booking; trip: BookingTrip; dispatch: StoredDispatch | undefined; deployedBoats: Set<string> } | undefined {
    for (const stored of this.bookings.values()) {
      const trip = stored.trips.find((t) => t.id === tripId);
      if (trip) {
        const booking = this.view(stored);
        return { booking, trip: booking.trips.find((t) => t.id === tripId)!, dispatch: this.dispatch.get(tripId), deployedBoats: this.deployedBoats(trip.route_id, trip.service_date) };
      }
    }
    return undefined;
  }
  /** A boat's capacity for one day (migration 046 records who and when): the trip-ops raise. */
  putBoatCapacityOverride(o: Required<Pick<BoatCapacityOverride, 'boat_id' | 'service_date' | 'capacity' | 'reason'>> & { set_by: string | null; set_at: string }): void {
    this.catalogue.boatOverrides = [...this.catalogue.boatOverrides.filter((x) => !(x.boat_id === o.boat_id && x.service_date === o.service_date)), { ...o }];
  }
  setDispatch(tripId: string, dispatch: StoredDispatch): void { this.dispatch.set(tripId, { ...dispatch, boat_splits: dispatch.boat_splits.map((s) => ({ ...s })) }); }

  // ── Van parts and groups (migration 016, slice A2) ──
  private vanParts = new Map<string, StoredVanPart[]>();
  private vanGroups = new Map<string, VanGroup>();
  /** Nothing to lock: the in-process store runs one transaction at a time. */
  lockVanDay(_date: string, _routeId: string): void {}
  bookingsOn(date: string, routeId: string): Booking[] {
    return [...this.bookings.values()].filter((b) => b.trips.some((t) => t.service_date === date && t.route_id === routeId)).map((b) => this.view(b));
  }
  vanGroupsOn(date: string, routeId: string): VanGroup[] { return [...this.vanGroups.values()].filter((g) => g.service_date === date && g.route_id === routeId).map((g) => ({ ...g })); }
  vanGroup(id: string): VanGroup | undefined { const g = this.vanGroups.get(id); return g && { ...g }; }
  storedVanParts(tripId: string): StoredVanPart[] { return (this.vanParts.get(tripId) ?? []).map((p) => ({ ...p, alt: p.alt && { ...p.alt } })); }
  writeVanGroup(group: VanGroup): void { this.vanGroups.set(group.id, { ...group }); }
  /** Its stops stay on the day with no group, as PostgreSQL's ON DELETE SET NULL leaves them; its sent mark goes (ON DELETE CASCADE). */
  deleteVanGroup(id: string): void {
    this.vanGroups.delete(id);
    for (const stop of this.vanStops.values()) if (stop.group_id === id) stop.group_id = null;
    this.vanJobSendRows = this.vanJobSendRows.filter((s) => s.group_id !== id);
  }

  // ── Van job orders (migration 080) ──
  private vanJobSendRows: VanJobSend[] = [];
  private pickupNameRows = new Map<string, PickupNameTh>();
  bookingsOnDate(date: string): Booking[] {
    return [...this.bookings.values()].filter((b) => b.trips.some((t) => t.service_date === date)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((b) => this.view(b));
  }
  vanGroupsOnDate(date: string): VanGroup[] { return [...this.vanGroups.values()].filter((g) => g.service_date === date).map((g) => ({ ...g })); }
  /** The day's marks: those on its groups, and the return-only ones dated that day. */
  vanJobSends(date: string): VanJobSend[] {
    return this.vanJobSendRows.filter((s) => (s.group_id ? this.vanGroups.get(s.group_id)?.service_date === date : s.service_date === date)).map((s) => ({ ...s }));
  }
  putVanJobSend(send: VanJobSend): void { this.deleteVanJobSend(send); this.vanJobSendRows.push({ ...send }); }
  deleteVanJobSend(s: Pick<VanJobSend, 'group_id' | 'service_date' | 'route_id' | 'van_id'>): void {
    this.vanJobSendRows = this.vanJobSendRows.filter((x) => (s.group_id ? x.group_id !== s.group_id
      : !(x.group_id === null && x.service_date === s.service_date && x.route_id === s.route_id && x.van_id === s.van_id)));
  }
  pickupNamesTh(): PickupNameTh[] { return [...this.pickupNameRows.values()].sort((a, b) => (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0)).map((n) => ({ ...n })); }
  putPickupNameTh(n: PickupNameTh): void { this.pickupNameRows.set(n.name_key, { ...n }); }
  deletePickupNameTh(nameKey: string): boolean { return this.pickupNameRows.delete(nameKey); }

  // ── Partner van bills, van rates, the daily report's settings (migration 120) ──
  private vanBillRows = new Map<string, StoredVanBill>();
  private vanRateRows: VanRate[] = [];
  private dailySettings: DailySettings | undefined;
  vanBill(partner: string, month: string, period: number): StoredVanBill | undefined {
    const b = [...this.vanBillRows.values()].find((x) => x.partner === partner && x.month === month && x.period === period);
    return b && copyBill(b);
  }
  vanBillsOf(month: string, period: number): StoredVanBill[] {
    return [...this.vanBillRows.values()].filter((x) => x.month === month && x.period === period).sort((a, b) => (a.partner < b.partner ? -1 : 1)).map(copyBill);
  }
  putVanBill(bill: StoredVanBill): void { this.vanBillRows.set(bill.id, copyBill(bill)); }
  /** By group, then route (a group's base first), then field: as PostgreSQL orders them (`COLLATE "C"`). */
  vanRates(): VanRate[] {
    const key = (r: VanRate) => `${r.group_key}\u0000${r.route_id ?? ''}\u0000${r.field}`;
    return [...this.vanRateRows].sort((a, b) => (key(a) < key(b) ? -1 : 1)).map((r) => ({ ...r }));
  }
  putVanRate(rate: VanRate): void { this.deleteVanRate(rate.group_key, rate.route_id, rate.field); this.vanRateRows.push({ ...rate }); }
  deleteVanRate(groupKey: string, routeId: string | null, field: VanRateField): boolean {
    const before = this.vanRateRows.length;
    this.vanRateRows = this.vanRateRows.filter((r) => !(r.group_key === groupKey && r.route_id === routeId && r.field === field));
    return this.vanRateRows.length < before;
  }
  dailyReportSettings(): DailySettings | undefined { return this.dailySettings && { ...this.dailySettings }; }
  putDailyReportSettings(s: DailySettings): void { this.dailySettings = { ...s }; }

  // ── Van stops (migration 034) ──
  private vanStops = new Map<string, VanStop>();
  vanStopsOn(date: string, routeId?: string): VanStop[] {
    return [...this.vanStops.values()].filter((x) => x.service_date === date && (routeId === undefined || x.route_id === routeId)).map(copyStop);
  }
  vanStop(id: string): VanStop | undefined { const x = this.vanStops.get(id); return x && copyStop(x); }
  writeVanStop(stop: VanStop): void { this.vanStops.set(stop.id, copyStop(stop)); }
  deleteVanStop(id: string): boolean { return this.vanStops.delete(id); }
  /** `[]` is no rows: one whole, ungrouped part. */
  setVanParts(tripId: string, parts: readonly StoredVanPart[]): void {
    if (parts.length) this.vanParts.set(tripId, parts.map((p) => ({ ...p, alt: p.alt && { ...p.alt } }))); else this.vanParts.delete(tripId);
  }
  /** Sets some of a trip's dispatch fields; a new final pickup is a plain time, with no window. */
  patchDispatch(tripId: string, fields: { pickup_time_final?: string | null; return_same_van?: boolean }): void {
    const d = { ...(this.dispatch.get(tripId) ?? EMPTY_DISPATCH) };
    if (fields.pickup_time_final !== undefined) Object.assign(d, { pickup_time_final: fields.pickup_time_final, pickup_time_final_end: null, pickup_final_at_pier: false });
    if (fields.return_same_van !== undefined) d.return_same_van = fields.return_same_van;
    this.setDispatch(tripId, d);
  }

  // ── Vans and the month matrix (migration 016, slice A3; 034) ──
  private vans = new Map<string, Van>();
  private vanZones: VanZoneRange[] = [];
  private vanZoneSeq = 0;
  private vanLogs = new Map<string, VanLogEntry[]>();

  /** A van no group uses (outbound, return, or a part's return van) and with no day in the matrix. */
  vanInUse(id: string): boolean {
    return [...this.vanGroups.values()].some((g) => g.van_id === id || g.return_van_id === id)
      || [...this.vanParts.values()].some((parts) => parts.some((p) => p.return_van_id === id))
      || [...this.vanDayRows.values()].some((d) => d.van_id === id);
  }
  /** Its log, status ranges and zone ranges go with it. */
  deleteVan(id: string): boolean {
    if (!this.vans.delete(id)) return false;
    this.vanLogs.delete(id);
    this.vanRanges = this.vanRanges.filter((r) => r.van_id !== id);
    this.vanZones = this.vanZones.filter((r) => r.van_id !== id);
    this.vanJobSendRows = this.vanJobSendRows.filter((s) => s.van_id !== id);
    return true;
  }
  vanZoneRanges(vanId?: string): VanZoneRange[] {
    return this.vanZones.filter((r) => vanId === undefined || r.van_id === vanId).sort((a, b) => (a.van_id < b.van_id ? -1 : a.van_id > b.van_id ? 1 : a.id - b.id)).map((r) => ({ ...r }));
  }
  addZoneRange(vanId: string, input: VanZoneRangeInput): VanZoneRange {
    const range = { id: ++this.vanZoneSeq, van_id: vanId, ...input };
    this.vanZones.push(range);
    return { ...range };
  }
  putZoneRange(range: VanZoneRange): void { this.vanZones = this.vanZones.map((r) => (r.id === range.id ? { ...range } : r)); }
  deleteZoneRange(vanId: string, id: number): boolean {
    const before = this.vanZones.length;
    this.vanZones = this.vanZones.filter((r) => !(r.van_id === vanId && r.id === id));
    return this.vanZones.length < before;
  }
  addVanLog(vanId: string, entries: readonly VanLogEntry[]): void { this.vanLogs.set(vanId, [...(this.vanLogs.get(vanId) ?? []), ...entries.map((e) => ({ ...e }))]); }
  /** Newest first. */
  vanLog(vanId: string, limit: number): VanLogEntry[] { return [...(this.vanLogs.get(vanId) ?? [])].reverse().slice(0, limit).map((e) => ({ ...e })); }
  private vanRanges: VanStatusRange[] = [];
  private vanRangeSeq = 0;
  private vanDayRows = new Map<string, StoredVanDay>();
  private copyDay = (d: StoredVanDay): StoredVanDay => ({ ...d, route_ids: [...d.route_ids] });

  listVans(): Van[] { return sortVans([...this.vans.values()]).map((v) => ({ ...v })); }
  van(id: string): Van | undefined { const v = this.vans.get(id); return v && { ...v }; }
  createVan(input: VanInput): Van {
    const van = { id: nextVanId([...this.vans.keys()]), ...input };
    this.vans.set(van.id, van);
    return { ...van };
  }
  updateVan(id: string, patch: VanPatch): Van | undefined {
    const van = this.vans.get(id);
    if (!van) return undefined;
    const next = applyVanPatch(van, patch);
    this.vans.set(id, next);
    return { ...next };
  }
  vanStatusRanges(vanId?: string): VanStatusRange[] { return sortRanges(this.vanRanges.filter((r) => vanId === undefined || r.van_id === vanId)).map((r) => ({ ...r })); }
  addStatusRange(vanId: string, input: VanStatusRangeInput): VanStatusRange {
    const range = { id: ++this.vanRangeSeq, van_id: vanId, ...input };
    this.vanRanges.push(range);
    return { ...range };
  }
  /** Rewrites a range in place, keeping its id and so its place in the order. */
  putStatusRange(range: VanStatusRange): void { this.vanRanges = this.vanRanges.map((r) => (r.id === range.id ? { ...range } : r)); }
  deleteStatusRange(vanId: string, id: number): boolean {
    const before = this.vanRanges.length;
    this.vanRanges = this.vanRanges.filter((r) => !(r.van_id === vanId && r.id === id));
    return this.vanRanges.length < before;
  }
  /** Stored cells between two dates, inclusive. */
  vanDays(from: string, to: string): StoredVanDay[] { return [...this.vanDayRows.values()].filter((d) => d.service_date >= from && d.service_date <= to).map(this.copyDay); }
  vanDay(vanId: string, date: string): StoredVanDay | undefined { const d = this.vanDayRows.get(`${vanId}|${date}`); return d && this.copyDay(d); }
  /** A cell with nothing set is no row at all. */
  setVanDay(day: StoredVanDay): void {
    const key = `${day.van_id}|${day.service_date}`;
    if (isEmptyVanDay(day)) this.vanDayRows.delete(key); else this.vanDayRows.set(key, this.copyDay(day));
  }

  /** One route's day, with per-boat and per-lock detail. The rules are `dayCapacity`'s; this only gathers rows. */
  day(routeId: string, serviceDate: string, exclude: Exclusion = {}): DayState {
    const deployments = this.deployments
      .filter((d) => d.route_id === routeId && d.service_date === serviceDate)
      .map((d) => ({ boat_id: d.boat_id, capacity: d.capacity, license_pax: d.license_pax, override_capacity: this.boatOverride(d.boat_id, serviceDate) }));
    const trips: HeldTrip[] = [];
    for (const booking of this.bookings.values()) {
      if (booking.id === exclude.bookingId || !bookingHoldsSeats(booking)) continue;
      for (const trip of booking.trips) {
        if (trip.route_id !== routeId || trip.service_date !== serviceDate) continue;
        trips.push({ booking_mode: trip.booking_mode, pax: paxTotal(trip.pax), charter_boat_id: trip.charter_boat_id });
      }
    }
    const drawn = drawnByLock(this.bookings.values(), exclude);
    const rows = [...this.locks.values()].filter((l) => l.route_id === routeId && l.service_date === serviceDate);
    const locks = poolLocks(rows, drawn, todayInThailand(), exclude.lockId);
    return dayCapacity(deployments, trips, locks, this.catalogue.routes.find((route) => route.id === routeId)?.kind);
  }

  /** `assertRoutesOpen` against the seeded calendar. Unseeded, every route runs every day. */
  private assertOpen(trips: readonly RouteDate[]): void {
    if (trips.length === 0) return;
    const names = new Map(this.catalogue.routes.map((route) => [route.id, route.name]));
    assertRoutesOpen(routeCalendar(this.catalogue.seasons, this.catalogue.overrides), trips, names);
  }

  capacity(routeId: string, serviceDate: string, exclude: Exclusion = {}): Capacity {
    return capacityNumbers(this.day(routeId, serviceDate, exclude));
  }

  /** `day` for every route in `routeIds` on every date in `from..to`: date first, then routes in the order given. */
  dayRange(routeIds: readonly string[], from: string, to: string, exclude: Exclusion = {}): RouteDay[] {
    const days: RouteDay[] = [];
    for (const date of eachDate(from, to)) for (const routeId of routeIds) days.push({ route_id: routeId, service_date: date, ...this.day(routeId, date, exclude) });
    return days;
  }

  /** Weighs every day a booking touches, so a multi-day booking is refused as a whole or not at all. */
  private assertTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, agentId?: string | null): void {
    for (const demand of demandByDay(trips, agentId)) assertDayFits(this.day(demand.route_id, demand.service_date, exclude), demand);
  }

  // ── Seat locks: the I/O `SeatLockService` needs (seat-lock-service.ts). The rules are not here. ──
  /** Nothing to lock: the in-process store runs one transaction at a time. */
  holdPool(_routeId: string, _date: string): void {}
  lockRows(q: LockQuery): LockRow[] { return [...this.locks.values()].filter((row) => matchesLock(row, q)).sort(byCreated).map((row) => ({ ...row })); }
  lockDrawn(ids: readonly string[]): Map<string, number> {
    const drawn = drawnByLock(this.bookings.values());
    return new Map(ids.map((id) => [id, drawn.get(id) ?? 0]));
  }
  putLock(row: LockRow): void { this.locks.set(row.id, { ...row }); }
  lockGroupRows(q: { ids?: readonly string[]; routeId?: string; agentId?: string }): GroupRow[] {
    return [...this.lockGroups.values()].filter((g) => (!q.ids || q.ids.includes(g.id)) && (!q.routeId || g.route_id === q.routeId) && (!q.agentId || g.agent_id === q.agentId))
      .sort(byCreated).map((g) => ({ ...g, weekdays: [...g.weekdays] }));
  }
  putLockGroup(row: GroupRow): void { this.lockGroups.set(row.id, { ...row, weekdays: [...row.weekdays] }); }
  addLockEvents(rows: readonly NewLockEvent[]): void {
    for (const row of rows) this.lockLog.push({ ...row, id: this.lockLog.length + 1, imported: false });
  }
  lockEvents(q: { lockId?: string; groupId?: string }): LockEvent[] {
    return this.lockLog.filter((e) => (!q.lockId || e.lock_id === q.lockId) && (!q.groupId || e.group_id === q.groupId)).map((e) => ({ ...e }));
  }

  /**
   * The licence is resolved once, here, from the boat catalogue when the caller does not supply it.
   * Reading it at capacity time instead would mean the seat pool answered differently depending on
   * whether a catalogue happened to be loaded; resolved on write, a deployment carries its own
   * ceiling and both stores compute from the same row.
   */
  createDeployment(input: Deployment): Deployment {
    const boat = this.catalogue.boats.find((b) => b.id === input.boat_id);
    const deployment: Deployment = { ...input, license_pax: input.license_pax ?? boat?.license_pax ?? undefined };
    const existing = this.deployments.findIndex((d) => d.boat_id === input.boat_id && d.service_date === input.service_date);
    if (existing >= 0) this.deployments[existing] = deployment;
    else this.deployments.push(deployment);
    return { ...deployment };
  }

  deleteDeployment(serviceDate: string, boatId: string): boolean {
    const index = this.deployments.findIndex((d) => d.service_date === serviceDate && d.boat_id === boatId);
    if (index < 0) return false;
    this.deployments.splice(index, 1);
    return true;
  }

  /** By date, as PostgreSQL lists them. */
  listDeployments(from?: string, to?: string, routeId?: string): Deployment[] {
    return this.deployments.filter((d) => (!from || d.service_date >= from) && (!to || d.service_date <= to) && (!routeId || d.route_id === routeId))
      .sort((a, b) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : 0));
  }

  /**
   * With no catalogue seeded there is nothing to validate against, so an unseeded in-process store
   * accepts any route. A PostgreSQL deployment always has a catalogue and always enforces this.
   */
  private assertRoutes(trips: readonly BookingTripInput[]): void {
    if (this.catalogue.routes.length > 0) assertKnownRoutes(new Set(this.catalogue.routes.map((route) => route.id)), trips);
    assertKnownLocks(new Set(this.locks.keys()), trips);
  }

  createBooking(input: BookingInput, actor?: string): Booking {
    if (input.external_id !== undefined) {
      const taken = [...this.bookings.values()].find((booking) => booking.external_id === input.external_id);
      if (taken) externalIdTaken(input.external_id, taken.id);
    }
    const planned = planTrips([], input.trips, () => this.id('trip'));
    this.assertRoutes(input.trips);
    this.assertOpen(tripsToCheckOpen(input.external_id, [], planned));
    // Weighed first, then decided: the days over the allotment are a fact the status depends on.
    const decision = decideStatus(input.intent ?? 'confirm', {
      focCount: focCountOf(input.trips), focReason: input.header?.foc_reason, discount: discountOf(input.header ?? {}),
      overDays: this.weighTrips(input.trips, {}, input.agent_id),
    }, actor);
    const status = decision.status;
    const now = this.now();
    const id = this.id('booking');
    // The header is flattened onto the booking, not nested under a `header` key: these are columns
    // in PostgreSQL, and a store that held them one level down would answer a different shape.
    const { trips, header, passengers, add_ons, adjustments, alt_pickups, upgrades, attachments, allergy_list, intent: _intent, ...rest } = input;
    // `booking_data` is what PostgreSQL's create writes: the input's blob if it carries one, otherwise
    // the column's `{}`. Nothing sends one since the blob stopped being written (2026-09-22), so both
    // stores answer `{}` for a new booking rather than one answering `{}` and the other nothing.
    const booking: StoredBooking = {
      ...rest, ...header, ...(status === 'confirmed' ? confirmationStamp(actor, now) : {}),
      booking_data: rest.booking_data ?? {}, id, status, version: 1, created_at: now, updated_at: now, trips: planned,
      passengers: withSeq(passengers ?? []), add_ons: withSeq(add_ons ?? []), adjustments: withSeq(adjustments ?? []), alt_pickups: (alt_pickups ?? []).map((a) => ({ ...a })),
      upgrades: storedUpgrades(upgrades ?? [], [], now, actor ?? null).upgrades, attachments: (attachments ?? []).map((d) => ({ ...d })), allergy_list: (allergy_list ?? []).map((a) => ({ ...a })), reschedules: [], partial_cancels: [], fee_items: [], approvals: [],
    };
    this.bookings.set(id, booking);
    this.requestApprovals(booking, decision.approvals);
    this.log(id, createdLine(actor));
    for (const line of decision.history) this.log(id, line);
    for (const line of storedUpgrades(upgrades ?? [], [], now, actor ?? null).history) this.log(id, line);
    return this.view(booking);
  }

  /** The days the trips put over the allotment (`weighDay`), after refusing what legacy refuses. */
  private weighTrips(trips: readonly BookingTripInput[], exclude: Exclusion = {}, agentId?: string | null): ApprovalDay[] {
    const over: ApprovalDay[] = [];
    for (const demand of demandByDay(trips, agentId)) {
      const weight = weighDay(this.day(demand.route_id, demand.service_date, exclude), demand);
      if (weight) over.push({ route_id: demand.route_id, service_date: demand.service_date, ...weight });
    }
    return over;
  }

  /** One approval waits per kind: a new request replaces a pending one of its kind. */
  private requestApprovals(booking: StoredBooking, requests: readonly NewApproval[]): void {
    for (const request of requests) {
      this.replacePending(booking, request.kind);
      booking.approvals.push({
        ...request, days: sortApprovalDays(request.days), status: 'pending', requested_at: this.now(), decided_by: null, decided_at: null, note: null,
      });
    }
  }
  private replacePending(booking: StoredBooking, kind: ApprovalKind): void {
    for (const approval of booking.approvals) if (approval.kind === kind && approval.status === 'pending') approval.status = 'replaced';
  }

  /** Appends one history line. Called after the write it describes, so a refused write leaves none. */
  private log(bookingId: string, entry: HistoryLine): void {
    const lines = this.histories.get(bookingId) ?? [];
    lines.push({ at: this.now(), ...entry });
    this.histories.set(bookingId, lines);
  }
  /** Oldest first. Undefined for an unknown booking, so the route can answer 404 rather than `[]`. */
  bookingHistory(id: string): HistoryEntry[] | undefined {
    if (!this.bookings.has(id)) return undefined;
    return (this.histories.get(id) ?? []).map((entry) => ({ ...entry }));
  }
  /**
   * What `priceBooking` priced each trip and add-on at, written beside them by position, in the
   * create's or amendment's own transaction. The trips themselves are left alone: re-writing them
   * would weigh the seats again.
   */
  setPrices(id: string, prices: BookingPrices): void {
    const booking = this.bookings.get(id);
    if (!booking) return;
    booking.trips.forEach((trip, i) => {
      const p = prices.trips[i];
      if (!p) return;
      trip.subtotal = p.subtotal;
      if (p.rate_type_id) trip.rate_type_id = p.rate_type_id; else delete trip.rate_type_id;
      if (p.promo_id) trip.promo_id = p.promo_id; else delete trip.promo_id;
    });
    booking.add_ons.forEach((addOn, i) => { if (prices.add_ons[i] !== undefined) addOn.amount = prices.add_ons[i]; });
  }

  /** The actor signs every action's write, the way the route stamps it on create and amend. */
  private touch(booking: StoredBooking, actor: string | undefined): void {
    booking.updated_at = this.now();
    booking.version += 1;
    if (actor !== undefined) booking.updated_by = actor;
  }

  listBookings(query: BookingListQuery): BookingPage {
    const cursor = query.cursor ? decodeBookingCursor(query.cursor) : undefined;
    // The page order, and "comes after the cursor" read in that same order, whichever direction.
    const direction = query.order === 'desc' ? -1 : 1;
    const compare = (a: { created_at: string; id: string }, b: { created_at: string; id: string }): number =>
      direction * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const lower = (value: unknown): string => (typeof value === 'string' ? value : '').toLowerCase();
    const filtered = [...this.bookings.values()]
      .filter((b) => !query.agentId || b.agent_id === query.agentId)
      .filter((b) => !query.statuses || query.statuses.includes(b.status))
      .filter((b) => query.voucherRef === undefined || lower(b.voucher_ref) === query.voucherRef)
      .filter((b) => query.updatedSince === undefined || b.updated_at >= query.updatedSince)
      .filter((b) => query.q === undefined || [b.id, b.voucher_ref, b.lead_pax].some((field) => lower(field).includes(query.q!)))
      .filter((b) => b.trips.some((t) => (!query.routeId || t.route_id === query.routeId)
        && (!query.serviceDate || t.service_date === query.serviceDate)
        && (!query.from || t.service_date >= query.from)
        && (!query.to || t.service_date <= query.to)));
    const matches = filtered.sort(compare).filter((b) => !cursor || compare(b, cursor) > 0);
    const page = matches.slice(0, query.limit);
    const hasMore = matches.length > query.limit;
    return { bookings: page.map((booking) => this.view(booking)), ...(hasMore ? { next_cursor: encodeBookingCursor(page[page.length - 1]) } : {}), total: filtered.length };
  }
  booking(id: string): Booking | undefined { const value = this.bookings.get(id); return value && this.view(value); }

  /** `entry` replaces the default `Edited · …` line, for the older reschedule body that comes through here. */
  amendBooking(id: string, requested: BookingChanges, actor?: string, entry?: HistoryLine): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    assertEditable(booking.status);
    const changes = stripServerOwned(requested, booking as unknown as Record<string, unknown> & { status: BookingStatus });
    const replacement = nextTrips(booking.trips, changes);
    const planned = planTrips(booking.trips, replacement, () => this.id('trip'));
    this.assertRoutes(replacement);
    this.assertOpen(tripsToCheckOpen(booking.external_id, booking.trips, planned));
    const reweighed = reweighs(booking, changes, claimsMoreSeats(booking.trips, planned))
      ? reweigh(booking, this.weighTrips(replacement, { bookingId: id }, booking.agent_id), actor) : undefined;
    const line = entry ?? editedLine(actor, changes, booking.status);
    this.retrip(booking, planned);
    if (reweighed) {
      if (reweighed.request) this.requestApprovals(booking, [reweighed.request]);
      else this.replacePending(booking, 'approval');
      if (reweighed.status === 'confirmed' && !booking.confirmed_at) Object.assign(booking, confirmationStamp(actor, this.now()));
      booking.status = reweighed.status;
    }
    // Applied after the capacity check, so a refused amendment leaves the header as it was too.
    if (changes.header) applyBookingHeader(booking as Record<string, unknown>, changes.header);
    if (changes.passengers) booking.passengers = withSeq(carryInsurance(booking.passengers, changes.passengers));
    if (changes.add_ons) booking.add_ons = withSeq(changes.add_ons);
    if (changes.adjustments) booking.adjustments = withSeq(changes.adjustments);
    if (changes.alt_pickups) booking.alt_pickups = changes.alt_pickups.map((a) => ({ ...a }));
    if (changes.attachments) booking.attachments = changes.attachments.map((d) => ({ ...d }));
    if (changes.allergy_list) booking.allergy_list = changes.allergy_list.map((a) => ({ ...a }));
    // As PostgreSQL logs them: the edit, the sales, then what the reweigh decided.
    const sold = changes.upgrades && storedUpgrades(changes.upgrades, booking.upgrades, this.now(), actor ?? null);
    if (sold) booking.upgrades = sold.upgrades;
    booking.updated_at = this.now();
    booking.version += 1;
    this.log(id, line);
    for (const extra of sold ? sold.history : []) this.log(id, extra);
    for (const extra of reweighed?.history ?? []) this.log(id, extra);
    return this.view(booking);
  }

  cancelBooking(id: string, request: CancelRequest, actor?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const plan = planCancel(booking, request, actor);
    booking.status = 'cancelled';
    booking.cancellation_reason = plan.cancellation_reason ?? undefined;
    if (plan.record) booking.cancellation = { ...plan.record, at: this.now() };
    else delete booking.cancellation;
    this.touch(booking, actor);
    this.log(id, plan.history);
    return this.view(booking);
  }

  /**
   * `/confirm`, `/approve`, `/reject`, `/cancel-weather`: the rules are `planStatusCommand`'s. Only
   * approving a booking that waited over the allotment gives it seats (`plan.claims`), and legacy
   * grants those even past the boats' registered seats, with a warning to add a boat: so does this.
   */
  changeBookingStatus(
    id: string, command: StatusCommand, request: StatusCommandRequest, actor?: string,
  ): { booking: Booking; warnings: ApprovalWarning[] } | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    const plan = planStatusCommand(command, booking, request, actor);
    const warnings = plan.claims ? licenceWarnings(booking.trips, (routeId, date) => this.day(routeId, date, { bookingId: id })) : [];
    const now = this.now();
    if (plan.decide) {
      const pending = pendingApproval(booking.approvals, plan.decide.kind);
      if (pending) Object.assign(pending, { status: plan.decide.status, decided_by: actor ?? null, decided_at: now, note: plan.decide.note });
      else booking.approvals.push(decidedRecord(plan.decide.kind, plan.decide.status, plan.status, focCountOf(booking.trips), actor, now, plan.decide.note));
    }
    this.requestApprovals(booking, plan.request);
    booking.status = plan.status;
    if (plan.confirms) {
      booking.confirmed_at = now;
      if (actor === undefined) delete booking.confirmed_by; else booking.confirmed_by = actor;
    }
    if (plan.cancellation_reason !== undefined) booking.cancellation_reason = plan.cancellation_reason;
    this.touch(booking, actor);
    for (const line of plan.history) this.log(id, line);
    return { booking: this.view(booking), warnings };
  }

  /** Back to `confirmed`, lock seats redrawn as far as the locks allow. See `restoreTrips`. */
  restoreBooking(id: string, actor?: string): { booking: Booking; warnings: LockShortWarning[] } | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    assertRestorable(booking.status);
    const days = new Map(booking.trips.map((trip) => [dayKey(trip.route_id, trip.service_date), this.day(trip.route_id, trip.service_date, { bookingId: id })]));
    const { trips, warnings } = restoreTrips(booking.trips, days);
    this.assertOpen(booking.trips);
    this.assertTrips(trips, { bookingId: id }, booking.agent_id);
    this.retrip(booking, planTrips(booking.trips, trips, () => this.id('trip')));
    booking.status = 'confirmed';
    delete booking.cancellation;
    delete booking.cancellation_reason;
    this.touch(booking, actor);
    this.log(id, restoredLine(actor, warnings));
    return { booking: this.view(booking), warnings };
  }

  partialCancel(id: string, request: PartialCancelRequest, actor?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (request.kind === 'count') {
      this.retrip(booking, planTrips(booking.trips, partialCancelTrips(booking.trips, booking.status, request.count), () => this.id('trip')));
      this.touch(booking, actor);
      this.log(id, partialCountLine(actor, request.count));
      return this.view(booking);
    }
    assertOpen(booking.status, 'partial cancel');
    // Seats only go down here, so there is no capacity check — see `claimsMoreSeats`.
    const { trips, trip, count } = partialCancelByKey(booking.trips, request);
    const record = { ...partialCancelRecord(trip, request, count, actor), at: this.now() };
    this.retrip(booking, planTrips(booking.trips, trips, () => this.id('trip')));
    booking.total = totalAfterRefund(booking.total, request.waived);
    booking.partial_cancels.push(record);
    this.touch(booking, actor);
    this.log(id, partialCancelLine(actor, record));
    return this.view(booking);
  }

  rescheduleBooking(id: string, request: RescheduleRequest, actor?: string): Booking | undefined {
    const booking = this.bookings.get(id);
    if (!booking) return undefined;
    if (request.kind === 'move') {
      const from = booking.trips[0]?.service_date ?? '';
      return this.amendBooking(id, { route_id: request.route_id, service_date: request.service_date, ...(request.pax === undefined ? {} : { pax: request.pax }) }, actor, movedLine(actor, from, request.service_date));
    }
    assertOpen(booking.status, 'reschedule');
    const { trips, locksReturned } = rescheduleTrips(booking.trips, request.from_date, request.to_date);
    const planned = planTrips(booking.trips, trips, () => this.id('trip'));
    this.assertRoutes(trips);
    this.assertOpen(tripsToCheckOpen(undefined, booking.trips, planned));
    if (claimsMoreSeats(booking.trips, planned)) this.assertTrips(trips, { bookingId: id }, booking.agent_id);
    const plan = planRescheduleRecord(booking, request, actor, locksReturned);
    const now = this.now();
    this.retrip(booking, planned);
    booking.reschedules.push({ ...plan.record, at: now });
    if (plan.fee_item) booking.fee_items.push({ ...plan.fee_item, at: now });
    this.touch(booking, actor);
    this.log(id, plan.history);
    return this.view(booking);
  }

  allotment(routeId: string, serviceDate: string, exclude: Exclusion = {}): Capacity & { route_id: string; service_date: string; deployments: Deployment[] } {
    return { route_id: routeId, service_date: serviceDate, ...this.capacity(routeId, serviceDate, exclude), deployments: this.listDeployments(serviceDate, serviceDate, routeId) };
  }
}

/**
 * The trips an amendment leaves behind.
 *
 * `trips` replaces the itinerary outright. The older single-departure fields still work, but only on
 * a booking that has one departure — on a multi-trip booking "the route" is ambiguous, and guessing
 * would move seats the caller never mentioned.
 */
export function nextTrips(current: readonly StoredTrip[], changes: BookingChanges): BookingTripInput[] {
  if (changes.trips) return changes.trips.map((trip) => ({ ...trip, pax: trip.pax.map((row) => ({ ...row })) }));
  if (changes.route_id === undefined && changes.service_date === undefined && changes.pax === undefined) return current.map((trip) => asInput(trip, current));
  const trip = onlyTrip(current, 'confirmed', 'Amend a multi-trip booking by sending trips');
  const route_id = changes.route_id ?? trip.route_id;
  const service_date = changes.service_date ?? trip.service_date;
  const pax = changes.pax === undefined ? trip.pax.map((row) => ({ ...row })) : retargetPax(trip.pax, changes.pax);
  // A lock belongs to one departure, so moving the trip leaves its draws behind and the moved trip
  // takes general seats. A caller drawing on a lock on the new day sends `trips`.
  const moved = route_id !== trip.route_id || service_date !== trip.service_date;
  const next = [{ ...asInput(trip, current), route_id, service_date, pax, lock_draws: moved ? [] : clampDraws(trip.lock_draws, paxTotal(pax)) }];
  // Moving an overnight outbound past its return date is refused here rather than by the database.
  if (moved) assertItinerary(next);
  return next;
}

/** The input a stored trip would have come from, id included, so an edit derived from it stays that trip. */
/** The itinerary with one trip on another route, everything else as it is: a route upgrade. */
export const retargetTrip = (current: readonly StoredTrip[], tripId: string, routeId: string): BookingTripInput[] =>
  current.map((trip) => ({ ...asInput(trip, current), ...(trip.id === tripId ? { route_id: routeId } : {}) }));

const asInput = (trip: StoredTrip, all: readonly StoredTrip[]): BookingTripInput => {
  const { id, route_id, service_date, booking_mode, charter_boat_id, lock_draws: _draws, pax: _pax, seq: _seq, ovn_of, ...details } = trip;
  return {
    id, route_id, service_date, booking_mode, pax: trip.pax.map((row) => ({ ...row })),
    ...(charter_boat_id ? { charter_boat_id } : {}),
    lock_draws: trip.lock_draws.map((draw) => ({ ...draw })),
    ...tripDetails(details),
    ...ovnOfIndex(all, ovn_of),
  };
};

/** The pickup and overnight fields with the unset ones left out, so both stores return the same keys. */
const tripDetails = (trip: TripDetails): TripDetails => ({
  ...(trip.zone ? { zone: trip.zone } : {}),
  ...pickupFields(trip),
  ...(trip.ovn ?{ ovn: trip.ovn } : {}),
  ...(trip.ovn_return_date ? { ovn_return_date: trip.ovn_return_date } : {}),
  ...(trip.ovn_leg ? { ovn_leg: true } : {}),
  ...(trip.ovn_charge === undefined ? {} : { ovn_charge: trip.ovn_charge }),
  ...(trip.charter_price_mode ? { charter_price_mode: trip.charter_price_mode } : {}),
  ...(trip.charter_price_manual === undefined ? {} : { charter_price_manual: trip.charter_price_manual }),
  ...(trip.charter_price_note ? { charter_price_note: trip.charter_price_note } : {}),
  ...(trip.subtotal === undefined ? {} : { subtotal: trip.subtotal }),
  ...(trip.rate_type_id ? { rate_type_id: trip.rate_type_id } : {}),
  ...(trip.promo_id ? { promo_id: trip.promo_id } : {}),
});

/**
 * The itinerary as it will be stored: each trip with its id and its position.
 *
 * A trip naming an `id` is that stored trip, edited in place; one without is new and gets
 * `newId()`. A stored trip the list does not mention is removed. Ids are what day-of-operations
 * rows hang off, so they must survive every edit that keeps the trip — a position-derived id would
 * renumber the second trip when the first is removed. New ids are never positional for the same
 * reason: a fresh trip must not inherit an id a removed one had.
 *
 * An id this booking does not hold, or one named twice, is refused rather than treated as new:
 * either is a client working from a stale or mangled copy, and guessing would move the wrong trip.
 *
 * A trip without an id is matched on route and day to a stored trip no other trip claimed by id,
 * so a client that never echoes ids still keeps them on every edit that does not move a trip. That
 * match is unambiguous only because `assertItinerary` allows one trip per route per day. With an id
 * the id wins, which is how a trip is moved to another day and stays the same trip.
 */
export function planTrips(current: readonly StoredTrip[], next: readonly BookingTripInput[], newId: () => string): StoredTrip[] {
  const held = new Set(current.map((trip) => trip.id));
  const claimed = new Set<string>();
  next.forEach((trip, index) => {
    if (trip.id === undefined) return;
    if (!held.has(trip.id)) fail(`trips[${index}].id ${trip.id} is not a trip of this booking`, 400);
    if (claimed.has(trip.id)) fail(`trips[${index}].id ${trip.id} appears more than once`, 400);
    claimed.add(trip.id);
  });
  const byDay = (trip: BookingTripInput): string | undefined => {
    const match = current.find((stored) => !claimed.has(stored.id) && stored.route_id === trip.route_id && stored.service_date === trip.service_date);
    if (match) claimed.add(match.id);
    return match?.id;
  };
  // Ids first, so a leg's `ovn_of` index can become its outbound's id whichever comes first.
  const ids = next.map((trip) => trip.id ?? byDay(trip) ?? newId());
  return next.map((trip, seq) => {
    const charter = trip.booking_mode === 'charter';
    return {
      id: ids[seq], seq, route_id: trip.route_id, service_date: trip.service_date, booking_mode: charter ? 'charter' : 'seat', pax: trip.pax.map((row) => ({ ...row })),
      ...(charter && trip.charter_boat_id ? { charter_boat_id: trip.charter_boat_id } : {}),
      lock_draws: charter ? [] : sortedDraws(trip.lock_draws ?? []),
      ...tripDetails(trip), ovn_leg: trip.ovn_leg === true,
      ...(trip.ovn_of === undefined || ids[trip.ovn_of] === undefined ? {} : { ovn_of: ids[trip.ovn_of] }),
    };
  });
}

/**
 * Kept trips whose route or day changed. Their day-of-operations data belonged to the old
 * departure — the van that was booked to collect them then — so it is cleared, as legacy's
 * `bkOpsClear` does when a trip's date moves. The trip itself, and its id, stay.
 */
/** Kept trips whose passengers changed: a boat split no longer adds up, so it is cleared (decided 2026-10-06). */
export function paxChangedTripIds(current: readonly StoredTrip[], planned: readonly StoredTrip[]): string[] {
  const key = (pax: readonly PaxRow[]) => [...pax].map((r) => `${r.category}${r.residency}${r.count}`).sort().join(',');
  const before = new Map(current.map((trip) => [trip.id, key(trip.pax)]));
  return planned.filter((trip) => before.has(trip.id) && before.get(trip.id) !== key(trip.pax)).map((trip) => trip.id);
}

export function movedTripIds(current: readonly StoredTrip[], planned: readonly StoredTrip[]): string[] {
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.filter((trip) => {
    const old = before.get(trip.id);
    return old !== undefined && (old.route_id !== trip.route_id || old.service_date !== trip.service_date);
  }).map((trip) => trip.id);
}

/**
 * The trips a write must find running on their day (`assertRoutesOpen`): those it adds or moves to
 * another route or day. A trip the write leaves where it is was sold already, and a day that closed
 * after the sale must not stop a notes edit — legacy's save blocks it, which is the hole this
 * closes. A booking from legacy's B2C sync (`isLegacyB2C`) is saved anyway, as legacy saves it.
 * Pass no `externalId` where legacy has no such exception (reschedule).
 */
export function tripsToCheckOpen(externalId: string | null | undefined, current: readonly StoredTrip[], planned: readonly StoredTrip[]): StoredTrip[] {
  if (isLegacyB2C(externalId)) return [];
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.filter((trip) => {
    const old = before.get(trip.id);
    return old === undefined || old.route_id !== trip.route_id || old.service_date !== trip.service_date;
  });
}

const sortedDraws = (draws: readonly LockDraw[]): LockDraw[] => draws.map((draw) => ({ ...draw })).sort((a, b) => a.lock_id.localeCompare(b.lock_id));

/**
 * Draws cut down to fit a smaller head count. General seats go first, lock seats only once those
 * are gone: which passengers were dropped is not recorded, and keeping the lock seats used is the
 * reading that never hands an agent back seats they had already sold.
 */
export function clampDraws(draws: readonly LockDraw[], pax: number): LockDraw[] {
  let left = pax;
  const kept: LockDraw[] = [];
  for (const draw of sortedDraws(draws)) {
    const qty = Math.min(draw.qty, left);
    if (qty > 0) kept.push({ lock_id: draw.lock_id, qty });
    left -= qty;
  }
  return kept;
}

/**
 * Cancelling a count rather than named passengers. Only a single-departure booking can do this: on a
 * multi-trip booking a bare number does not say which day loses the seats, and `reducePax` decides
 * which cells shrink. A caller that knows both should amend the trips instead.
 */
export function partialCancelTrips(trips: readonly StoredTrip[], status: BookingStatus, count: number): BookingTripInput[] {
  const trip = onlyTrip(trips, status, 'Partial-cancel a multi-trip booking by sending trips');
  const total = paxTotal(trip.pax);
  if (count > total) fail('Cannot cancel more passengers than the active booking', 400);
  return [{ ...asInput(trip, trips), pax: retargetPax(trip.pax, total - count), lock_draws: clampDraws(trip.lock_draws, total - count) }];
}

function onlyTrip(trips: readonly StoredTrip[], status: BookingStatus, message: string): StoredTrip {
  if (!holdsSeats(status)) fail('Cannot cancel more passengers than the active booking', 400);
  if (trips.length !== 1) fail(message, 400);
  return trips[0];
}

const drawnTotal = (draws: readonly LockDraw[]): number => draws.reduce((sum, draw) => sum + draw.qty, 0);

/**
 * Whether an amendment asks the pool for anything it is not already holding.
 *
 * Trips are matched by id (after `planTrips`), so a reorder is not a change. Only growth counts: a
 * new trip, a trip moved to another route, day, mode or charter boat, more passengers, more general
 * seats, or more seats from any one lock. General seats are checked on their own because a trip that
 * keeps its pax but gives up lock seats takes the same number from the general pool instead.
 *
 * Shrinking never needs room. The import brings oversold days over as they are, and checking an
 * amendment that only frees seats would refuse taking a passenger off a day that is already over.
 */
/**
 * Whether an amendment is weighed against the allotment again: a booking holding its seats that asks
 * for more, or one waiting over the allotment (holding nothing) whose itinerary changes at all.
 */
export function reweighs(
  booking: { status: BookingStatus; approvals?: readonly BookingApproval[] }, changes: BookingChanges, moreSeats: boolean,
): boolean {
  if (bookingHoldsSeats(booking)) return moreSeats;
  const itinerary = changes.trips !== undefined || changes.route_id !== undefined || changes.service_date !== undefined || changes.pax !== undefined;
  return booking.status === 'pending_approval' && itinerary;
}

/** The days an approval puts past the boats' registered seats. `dayOf` reads the day without this booking. */
export function licenceWarnings(trips: readonly StoredTrip[], dayOf: (routeId: string, date: string) => DayState): ApprovalWarning[] {
  const warnings: ApprovalWarning[] = [];
  for (const demand of demandByDay(trips.map((trip) => asInput(trip, trips)))) {
    const over = licenceShortfall(dayOf(demand.route_id, demand.service_date), demand);
    if (over > 0) warnings.push({ code: 'over_licence', route_id: demand.route_id, service_date: demand.service_date, over_by: over });
  }
  return warnings;
}

export function claimsMoreSeats(current: readonly StoredTrip[], planned: readonly StoredTrip[]): boolean {
  const before = new Map(current.map((trip) => [trip.id, trip]));
  return planned.some((trip) => {
    const old = before.get(trip.id);
    if (!old) return true;
    if (old.route_id !== trip.route_id || old.service_date !== trip.service_date || old.booking_mode !== trip.booking_mode
      || (old.charter_boat_id ?? '') !== (trip.charter_boat_id ?? '')) return true;
    const pax = paxTotal(trip.pax), oldPax = paxTotal(old.pax);
    if (pax > oldPax || pax - drawnTotal(trip.lock_draws) > oldPax - drawnTotal(old.lock_draws)) return true;
    const oldDraws = new Map(old.lock_draws.map((draw) => [draw.lock_id, draw.qty]));
    return trip.lock_draws.some((draw) => draw.qty > (oldDraws.get(draw.lock_id) ?? 0));
  });
}

/**
 * Draws cut by `count`, lock seats first, lowest lock id first — the opposite of `clampDraws`.
 *
 * A partial cancel names who is leaving, and legacy gives their reserved seats back to the agent's
 * lock (`booking.js:13904-13919`): the customer dropped out, so the agent may resell the seat. Only
 * what is left over comes off the general seats.
 */
export function returnDrawsFirst(draws: readonly LockDraw[], count: number): LockDraw[] {
  let left = count;
  const kept: LockDraw[] = [];
  for (const draw of sortedDraws(draws)) {
    const back = Math.min(draw.qty, left);
    left -= back;
    if (draw.qty - back > 0) kept.push({ lock_id: draw.lock_id, qty: draw.qty - back });
  }
  return kept;
}

/**
 * The full partial cancel: named passengers off one trip, their lock seats back first.
 *
 * A trip is never emptied this way (decided 2026-10-05). Removing a whole departure is a different
 * act — cancel the booking, or edit its trips — and one that legacy let happen here by accident.
 */
export function partialCancelByKey(trips: readonly StoredTrip[], request: Extract<PartialCancelRequest, { kind: 'record' }>): { trips: BookingTripInput[]; trip: StoredTrip; count: number } {
  const index = trips.findIndex((trip) => trip.id === request.trip_id);
  if (index < 0) refuse(`Trip ${request.trip_id} is not on this booking`, 404);
  const trip = trips[index];
  const label = `trips[${index}]`;
  const remaining = trip.pax.map((row) => ({ ...row }));
  for (const cut of request.pax) {
    const key = paxKey(cut.category, cut.residency);
    const cell = remaining.find((row) => row.category === cut.category && row.residency === cut.residency) ?? refuse(`${label} has no ${key} passengers`, 400);
    if (cut.count > cell.count) refuse(`${label} has ${cell.count} ${key}; cannot remove ${cut.count}`, 400);
    cell.count -= cut.count;
  }
  const left = remaining.filter((row) => row.count > 0);
  if (left.length === 0) refuse(`${label} would have no passengers; cancel the booking instead`, 400);
  const count = paxTotal(request.pax);
  return {
    trip, count,
    trips: trips.map((stored) => stored === trip ? { ...asInput(stored, trips), pax: left, lock_draws: returnDrawsFirst(stored.lock_draws, count) } : asInput(stored, trips)),
  };
}

/**
 * Every trip on `from` moved to `to`, on the same route (legacy `bkV2RescheduleBooking`). Their lock
 * draws are returned: a lock belongs to one departure, so the moved trip takes general seats on the
 * new day, as the single-trip move in `nextTrips` already does. A charter keeps its boat and must get
 * it whole on the new day, which the ordinary capacity check decides.
 */
export function rescheduleTrips(trips: readonly StoredTrip[], from: string, to: string): { trips: BookingTripInput[]; locksReturned: number } {
  if (!trips.some((trip) => trip.service_date === from)) refuse(`No trip on ${from} to reschedule`, 400);
  let locksReturned = 0;
  const next = trips.map((trip) => {
    const input = asInput(trip, trips);
    if (trip.service_date !== from) return input;
    locksReturned += drawnTotal(trip.lock_draws);
    return { ...input, service_date: to, lock_draws: [] };
  });
  // An overnight outbound cannot move past its return leg, and a route keeps one trip per day.
  assertItinerary(next);
  return { trips: next, locksReturned };
}

export const dayKey = (routeId: string, serviceDate: string): string => `${routeId} ${serviceDate}`;

/**
 * The trips a restored booking asks for, from each day's state read with the booking excluded.
 *
 * Lock seats are redrawn best-effort, as legacy does (`booking.js:12376-12385`): a lock that has
 * since been used by others gives back what it still has, and the rest of the trip falls to general
 * seats — the caller's capacity check then decides whether those exist. A charter wants its boat
 * whole again; if another charter took it meanwhile, the restore is refused rather than leaving two
 * charters on one boat, which legacy allowed and asked staff to sort out by hand.
 */
export function restoreTrips(trips: readonly StoredTrip[], days: ReadonlyMap<string, DayState>): { trips: BookingTripInput[]; warnings: LockShortWarning[] } {
  const warnings: LockShortWarning[] = [];
  const left = new Map<string, number>();
  const next = trips.map((trip) => {
    const day = days.get(dayKey(trip.route_id, trip.service_date));
    if (trip.booking_mode === 'charter' && trip.charter_boat_id && day?.boats.find((boat) => boat.boat_id === trip.charter_boat_id)?.chartered) {
      refuse(`Boat ${trip.charter_boat_id} is chartered by another booking on ${trip.service_date}`, 409, 'charter_boat_taken');
    }
    const draws = trip.lock_draws.map((draw) => {
      const remaining = left.get(draw.lock_id) ?? day?.locks.find((lock) => lock.id === draw.lock_id)?.remaining ?? 0;
      const got = Math.min(draw.qty, remaining);
      left.set(draw.lock_id, remaining - got);
      if (got < draw.qty) warnings.push({ code: 'lock_short', trip_id: trip.id, lock_id: draw.lock_id, wanted: draw.qty, got });
      return { lock_id: draw.lock_id, qty: got };
    }).filter((draw) => draw.qty > 0);
    return { ...asInput(trip, trips), lock_draws: draws };
  });
  return { trips: next, warnings };
}

/**
 * Trip routes that are not in the catalogue.
 *
 * The database has a foreign key for this, but a constraint violation reaches the caller as a 500
 * naming a constraint. Checking up front is what turns it into a 400 naming the route, and putting
 * the check here is what stops the two stores from wording it differently.
 */
export function unknownRoutes(known: ReadonlySet<string>, trips: readonly BookingTripInput[]): string[] {
  return [...new Set(trips.map((trip) => trip.route_id).filter((id) => !known.has(id)))];
}

export function assertKnownRoutes(known: ReadonlySet<string>, trips: readonly BookingTripInput[]): void {
  const missing = unknownRoutes(known, trips);
  if (missing.length > 0) fail(`Unknown route: ${missing.join(', ')}`, 400);
}

/** Every lock a draw names. Checked even when no seats are claimed, so a quote cannot name a lock that does not exist. */
export const drawnLockIds = (trips: readonly BookingTripInput[]): string[] => [...new Set(trips.flatMap((trip) => (trip.lock_draws ?? []).map((draw) => draw.lock_id)))];

export function assertKnownLocks(known: ReadonlySet<string>, trips: readonly BookingTripInput[]): void {
  const missing = drawnLockIds(trips).filter((id) => !known.has(id));
  if (missing.length > 0) fail(`Unknown seat lock: ${missing.join(', ')}`, 400);
}

