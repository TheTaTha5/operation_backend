import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertItinerary, OperationsStore, type Booking, type OvnMode, type BookingChanges, type BookingInput, type BookingListQuery, type BookingTripInput, type Deployment, type Exclusion, type LockDraw } from '../domain/operations.js';
import { SeatLockService } from '../domain/seat-lock-service.js';
import {
  assertGroupOwnedEcho, assertOwnedEcho, isoDay, parseAdd, parseConfirm, parseGroupChanges, parseLockChanges, parseNewGroup, parseNewLock, parseRelease, parseSubGroup,
} from '../domain/seat-lock-input.js';
import { STATUS_CODES } from 'node:http';
import { docs } from './openapi.js';
import { PostgresOperationsStore } from '../domain/postgres-operations.js';
import { Authenticator } from '../auth.js';
import { assertMayDecide, assertMayWrite, hashPassword, parseNewUser, parseUserPatch, password, userView, verifyPassword, type StoredUser } from '../domain/users.js';
import { eachDate, isIsoDate, isIsoTime, isRouteKind, routeCalendar, todayInThailand, type CalendarKind, type Route, type RouteDayOverride, type RouteSeason } from '../domain/calendar.js';
import { parsePaxGrid, paxRowsFromTotal, paxTotal, type PaxRow } from '../domain/pax.js';
import { BOOKING_STATUSES, SEAT_RELEASING_STATUSES, holdsSeats, isBookingStatus, type BookingStatus } from '../domain/booking-status.js';
import { capacityNumbers } from '../domain/capacity.js';
import { bookingHeader, bookingHeaderPatch, type BookingHeader, type BookingHeaderPatch } from '../domain/booking-header.js';
import { parseBookingPassengers } from '../domain/booking-passengers.js';
import { parseBookingAddOns, type BookingAddOnInput } from '../domain/booking-addons.js';
import { parseBookingAdjustments, type BookingAdjustmentInput } from '../domain/booking-adjustments.js';
import {
  actorOf, assertOpen, createHeader, parseCancelRequest, parsePartialCancelRequest, parseRescheduleRequest, parseStatusCommandRequest, stampActor, STATUS_COMMANDS,
} from '../domain/booking-actions.js';
import { parseIntent, pendingApproval } from '../domain/booking-approvals.js';
import { pickupFields, pickupProblem } from '../domain/pickup.js';
import { assertFresh, expectedVersion } from '../domain/versions.js';
import { applyDispatch, charterSynced, checkBoatAssignment, parseDispatchPatch, parseRaise, paxByBoat } from '../domain/dispatch.js';
import { changeContext, noteWeatherClosure, trackChanges } from './change-tracking.js';
import { parseSince } from '../domain/changes.js';
import { allergyListOf, parseAllergyList } from '../domain/allergies.js';
import { areaId, inheritedCells, lookupPickupTime, parseAreaPatch, parseCell, parseNewArea, parseProfile, sortAreas, type PickupArea } from '../domain/pickup-areas.js';
import { assertDocCheckEcho, parseDocItem, withItem, withNote, withPre, withStatus as withDocStatus, type DocCheck } from '../domain/doc-check.js';
import type { HistoryLine } from '../domain/booking-actions.js';
import { altPartsPlan, parseAltPickups } from '../domain/alt-pickups.js';
import { parseRouteUpgrade, parseUpgrades, routeUpgradeLine, routeUpgradeSale, upgradeStored, upgradeUndoneLine } from '../domain/upgrades.js';
import { assertKnownFiles, documentRows, MAX_ATTACHMENT_BYTES, newAttachmentId, parseAttachmentIds, parseUpload } from '../domain/attachments.js';
import { applyCheckin, parseCheckin, parseCheckinTarget } from '../domain/checkin.js';
import { checkDeploymentChange, placedOn } from '../domain/deployment-guards.js';
import { assertReconfirmEcho, parseReconfirmStatus, parseSentRequest, withSent, withStatus, withoutStatus } from '../domain/reconfirm.js';
import {
  addMembers, assertCapacity, clearRouteVans, createGroup, disbandGroup, groupView, orderGroup, orderZoneGroups, parseVanParts, partsFromView, partsToStore, rezonedParts, setGroup, setTripParts,
  vanDayState, visibleGroups, type VanGroup, type VanPlan,
} from '../domain/van-groups.js';
import {
  applyVanDayPatch, createdLine, emptyVanDay, parseLogLimit, parseNewVan, parseStatusRange, parseVanDayPatch, parseVanDayRange, parseVanPatch, parseZoneRange,
  patchStatusRange, patchZoneRange, statusRangeLines, vanDayLines, vanEditLines, vanMatrix, zoneRangeDeletedLine, zoneRangeLines, type VanLogLine,
} from '../domain/vans.js';
import { outboundSeats, parseStopFields, sortStops, type VanStop } from '../domain/van-stops.js';
import { parseJobDate, parsePickupNameTh, sendFor, vanJobsDay } from '../domain/van-jobs.js';
import { registerSalesRoutes } from './sales-editing.js';
import { registerFleetStockRoutes } from './fleet-stock.js';
import { registerMoneyReportRoutes } from './money-reports.js';
import { boatsAvailableToday, openWork, registerFleetRoutes } from './fleet.js';
import { availability, checkBoatReady, planAhead, type ReadinessWarning } from '../domain/fleet-availability.js';
import { registerMoneyRoutes } from './money.js';
import { cotDeductions } from '../domain/after-trip.js';
import { assertAgentBookable } from '../domain/agent-writes.js';
import { assertInsuranceEcho } from '../domain/insurance.js';
import { refuse as refuseWith, rescheduleFeeLabel } from '../domain/booking-actions.js';
import {
  assertPaymentEcho, bangkokDay, bookingIdsOf, correctPayments, creditOf, feeInvoice, invoiceLines, invoiceMonth, invoiceNumber, invoiceView, issuedLine, issueInvoice,
  liveBookingInvoiceOf, parseInvoiceListQuery, parseInvoicePatch, parseNewInvoice, parsePayment, parseVoid, PAYMENT_METHODS, recordPayment, returnedOf, voided, voidedLine,
  withDiscounts, withFeeLine,
  type PaymentMethod, type StoredInvoice,
} from '../domain/invoices.js';
import {
  assertCreditCovers, creditBalance, matchesRefundQuery, parseRefundListQuery, refundableFor, weatherMoney, type CreditBalance,
} from '../domain/refunds.js';
import {
  assertOpenClosure, closedLine, closureView, followUps, notifiedLine, parseClosureListQuery, parseClosurePatch, parseNewClosure, parseUndo, parseWeatherCancel,
  planClose, planNotify, planUndo, reopenedLine, resolvedRows, type CaseOutcome, type FollowUp, type WeatherClosure,
} from '../domain/weather.js';
import { enforcedPriceMode, priceBooking, type Quote, type QuoteTrip } from '../domain/pricing.js';
import type { RateType } from '../domain/rate-types.js';
import { parseRateTypeCreate, parseRateTypePatch, parseRouteBlock, rateTypeNotFound, type RateTypeListQuery } from '../domain/rate-types.js';
import {
  B2C_AGENT, bookingIssues, decideHeld, heldResponse, holdOrder, isB2CPush, issuesSignature, parseHeldDecision, parseHeldStatus, parseUpdatedSince, sameHeldCreate,
  type HeldAction, type HeldInput, type PanelIssue,
} from '../domain/b2c.js';
import {
  addStatusEntry, assertFamily, assertFamilyUnused, assertNotPast, assertRouteUnused, blankBoat, boatView, boatWarnings, capacityChange, copyBoat, deploymentNumbers,
  duplicateNameWarnings, editStatusEntry, extIdTaken, guessFamily, newRoute, nextCatalogueId, overrideDay, parseBoatInput, parseFamilyPatch, parseNewFamily,
  parseNewRoute, parseOverrideRequest, parseRoutePatch, parseStatusEntry, patchedRoute, planOverride, realDate, restoredBoat, retiredBoat, routeOrder, seatsDrop,
  withFormStatus, type BoatRecord, type DeploymentDay, type OversoldWarning,
} from '../domain/catalogue.js';

/** A little over a year, so a client may sweep a full season but not walk the calendar forever. */
const MAX_CALENDAR_DAYS = 400;
/** Every route over a range grows with routes × days, so the sweep across all of them is kept to about two months. */
const MAX_ALL_ROUTES_DAYS = 62;

const badRequest = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 400; throw error; };
const notFound = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 404; throw error; };
const unauthorized = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number }).statusCode = 401; throw error; };
const forbidden = (message: string): never => { const error = new Error(message); (error as Error & { statusCode: number; code: string }).statusCode = 403; (error as Error & { code: string }).code = 'forbidden'; throw error; };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A command's body without `version`, which is the write's precondition, not part of the command. */
const withoutVersion = (body: unknown, required = false): Record<string, unknown> => {
  const { version: _version, ...rest } = record(body ?? (required ? body : {}));
  return rest;
};
const lockId = (request: { params: unknown }): string => (request.params as { id: string }).id;
const paramId = (request: { params: unknown }): string => (request.params as { id: string }).id;
/** A trip's price inputs a booking does not store yet (todo/pricing-model.md, step 5). Legacy's spellings too. */
function quoteTripPrices(raw: unknown, index: number): Pick<QuoteTrip, 'ovn_charge' | 'charter_price_mode' | 'charter_price_manual' | 'charter_price_note'> {
  const trip = isRecord(raw) ? raw : {};
  const amount = (value: unknown, name: string): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : badRequest(`trips[${index}].${name} must be a number, 0 or more`);
  };
  const mode = trip.charter_price_mode ?? trip.charterPriceMode;
  if (mode !== undefined && mode !== null && mode !== '' && mode !== 'rate' && mode !== 'manual') badRequest(`trips[${index}].charter_price_mode must be rate or manual`);
  const ovnCharge = amount(trip.ovn_charge ?? trip.ovnCharge, 'ovn_charge');
  const manual = amount(trip.charter_price_manual ?? trip.charterPriceManual, 'charter_price_manual');
  const note = trip.charter_price_note ?? trip.charterPriceNote;
  if (note !== undefined && note !== null && typeof note !== 'string') badRequest(`trips[${index}].charter_price_note must be a string`);
  return {
    ...(ovnCharge === undefined ? {} : { ovn_charge: ovnCharge }),
    ...(mode === 'manual' ? { charter_price_mode: 'manual' as const } : {}),
    ...(manual === undefined ? {} : { charter_price_manual: manual }),
    ...(typeof note === 'string' && note.trim() !== '' ? { charter_price_note: note.trim() } : {}),
  };
}
/**
 * A booking whose price stays as its client sent it: legacy's B2C sync (`b2c_…`) and Love Kingdom's
 * service user (agent `a_b2c`, ids `LOV-…`). Legacy never re-prices them (decided 2026-10-09).
 */
const isB2C = (b: { external_id?: string; agent_id?: string }): boolean => !!b.external_id?.startsWith('b2c_') || b.agent_id === 'a_b2c';
/** `kept` (an edit's default: each trip keeps the rate it was sold at) or `agent` (today's rate). */
const rateOf = (rate: unknown, stored: unknown): 'kept' | 'agent' =>
  rate === undefined ? (stored ? 'kept' : 'agent') : rate === 'kept' || rate === 'agent' ? rate : badRequest('rate must be kept or agent');
/** The price fields the server computes (README "Prices"). */
const PRICE_FIELDS = ['total', 'price_seat', 'price_addon', 'price_foc_discount', 'price_discount', 'price_extra'] as const;
type PriceWarning = { code: string; message: string; field?: string; sent?: number; used?: number };
/** A price the client sent that the server's replaced: said, never silently dropped (decided 2026-10-09). */
const replacedPrices = (sent: Record<string, unknown> | undefined, used: Record<string, unknown>): PriceWarning[] =>
  PRICE_FIELDS.filter((field) => sent?.[field] !== undefined && sent[field] !== null && Number(sent[field]) !== Number(used[field] ?? 0))
    .map((field) => ({ code: 'price_replaced', field, sent: Number(sent![field]), used: Number(used[field] ?? 0),
      message: `${field} ${Number(sent![field])} was replaced by the server's ${Number(used[field] ?? 0)} (POST /v1/quote shows how)` }));
/** A stored trip as `priceBooking` reads it. */
const pricedTripOf = (t: Booking['trips'][number]): BookingTripInput => ({
  id: t.id, route_id: t.route_id, service_date: t.service_date, booking_mode: t.booking_mode, pax: parsePaxGrid(t.pax),
  ...(t.charter_boat_id ? { charter_boat_id: t.charter_boat_id } : {}), ...(t.zone ? { zone: t.zone } : {}), ...(t.ovn ? { ovn: t.ovn } : {}),
  ...(t.ovn_leg ? { ovn_leg: true } : {}), ...(t.ovn_charge === undefined ? {} : { ovn_charge: t.ovn_charge }),
  ...(t.charter_price_mode ? { charter_price_mode: t.charter_price_mode } : {}), ...(t.charter_price_manual === undefined ? {} : { charter_price_manual: t.charter_price_manual }),
});
/** A B2C booking was priced by Love Kingdom; legacy never re-prices it, so its stored price is the answer. */
const storedQuote = (b: Booking): Quote & { stored: true } => ({
  stored: true, price_mode: b.price_mode === 'manual' ? 'manual' : 'rate',
  seat: b.price_seat ?? 0, add_on: b.price_addon ?? 0, foc_discount: b.price_foc_discount ?? 0, discount: b.price_discount ?? 0,
  extra: b.price_extra ?? 0, total: b.total ?? 0, trips: [], add_ons: [], warnings: [],
});
const userId = (request: { params: unknown }): number => {
  const id = Number((request.params as { id: string }).id);
  return Number.isInteger(id) && id > 0 ? id : notFound('User not found');
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest('Request body must be an object');
const string = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0 ? value : badRequest(`${name} is required`);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const pax = (value: unknown, name = 'pax'): number => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : badRequest(`${name} must be a positive integer`);
/** Seats held by the reservation currently being edited, so an availability read does not count them against it. */
const bookingId = (request: { params: unknown }): string => (request.params as { id: string }).id;
const exclusion = (query: Record<string, unknown>): Exclusion => ({ bookingId: optionalString(query.exclude_booking_id), lockId: optionalString(query.exclude_lock_id) });

function deployment(body: unknown): Deployment {
  const input = record(body);
  const capacity = pax(input.capacity ?? input.cap, 'capacity');
  // `total_capacity`/`totalcap` are still accepted because that is what legacy sends, but they are
  // the registration figure (passengers + crew) and are stored as such. Nothing sells against them.
  const registered = input.registered_persons ?? input.total_capacity ?? input.totalcap;
  return { boat_id: string(input.boat_id, 'boat_id'), route_id: string(input.route_id, 'route_id'), service_date: string(input.service_date, 'service_date'), capacity, license_pax: input.license_pax === undefined && input.licensePax === undefined ? undefined : pax(input.license_pax ?? input.licensePax, 'license_pax'), registered_persons: registered === undefined ? undefined : pax(registered, 'registered_persons') };
}
/** An unrecognised status is refused by name; the CHECK behind it would only say "constraint". */
const bookingStatus = (value: unknown): BookingStatus | undefined =>
  value === undefined || value === null ? undefined : (isBookingStatus(value) ? value : badRequest(`status must be one of ${BOOKING_STATUSES.join(', ')}`));

/** A bare count is one untiered cell; the frontend's `{ ad: 2, chd_fr: 1 }` grid is parsed as written. */
const paxOf = (value: unknown, label: string): PaxRow[] => typeof value === 'number' ? paxRowsFromTotal(pax(value, label)) : parsePaxGrid(value, label);

/** `{ lock_id: qty }`, the shape the frontend writes as `lockDraws`. An empty map draws nothing. */
function lockDraws(value: unknown, label: string): LockDraw[] {
  if (value === undefined || value === null) return [];
  const draws = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : badRequest(`${label} must be an object of lock id to seats`);
  return Object.entries(draws).map(([lock_id, qty]) => ({ lock_id, qty: pax(qty, `${label}.${lock_id}`) }));
}

function tripInput(value: unknown, index: number): BookingTripInput {
  const trip = record(value);
  const label = `trips[${index}]`;
  const rows = trip.pax === undefined ? badRequest(`${label}.pax is required`) : paxOf(trip.pax, `${label}.pax`);
  if (paxTotal(rows) === 0) badRequest(`${label}.pax must carry at least one passenger`);
  const booking_mode = optionalString(trip.booking_mode ?? trip.bookingMode);
  const charter_boat_id = optionalString(trip.charter_boat_id ?? trip.charterBoatId);
  const draws = lockDraws(trip.lock_draws ?? trip.lockDraws, `${label}.lock_draws`);
  // A charter takes a whole boat, so it must say which; the seat pool cannot give one up otherwise.
  if (booking_mode === 'charter') {
    if (charter_boat_id === undefined) badRequest(`${label}.charter_boat_id is required for a charter`);
    if (draws.length > 0) badRequest(`${label}.lock_draws does not apply to a charter`);
  } else if (charter_boat_id !== undefined) badRequest(`${label}.charter_boat_id applies only to a charter`);
  if (draws.reduce((sum, draw) => sum + draw.qty, 0) > paxTotal(rows)) badRequest(`${label}.lock_draws cannot exceed the trip's pax`);
  // Absent means a new trip. Present but malformed is refused: dropping it would silently turn an
  // edit of an existing trip into a new one, and remove the trip it was meant to keep.
  if (trip.id !== undefined && optionalString(trip.id) === undefined) badRequest(`${label}.id must be a trip id`);
  return {
    ...(trip.id === undefined ? {} : { id: trip.id as string }),
    route_id: string(trip.route_id ?? trip.routeId, `${label}.route_id`),
    service_date: string(trip.service_date ?? trip.date, `${label}.service_date`),
    booking_mode, pax: rows, charter_boat_id, lock_draws: draws,
    ...tripDetails(trip, label),
    ...quoteTripPrices(trip, index),
  };
}

/**
 * The pickup and overnight fields of one trip. An empty string or null is "not set", which is how
 * legacy writes an unset field; a value that is present and malformed is refused. The rules that
 * span trips — a leg matching its outbound — are `assertItinerary`'s.
 */
function tripDetails(trip: Record<string, unknown>, label: string): Pick<BookingTripInput, 'zone' | 'pickup_time' | 'pickup_time_end' | 'pickup_at_pier' | 'ovn' | 'ovn_return_date' | 'ovn_leg' | 'ovn_of'> {
  const unset = (value: unknown) => value === undefined || value === null || value === '';
  const text = (value: unknown, name: string): string | undefined => unset(value) ? undefined : typeof value === 'string' ? value : badRequest(`${label}.${name} must be a string`);
  const atPier = trip.pickup_at_pier ?? trip.pickupAtPier;
  if (!unset(atPier) && typeof atPier !== 'boolean') badRequest(`${label}.pickup_at_pier must be true or false`);
  const pickup = pickupFields({
    pickup_time: text(trip.pickup_time ?? trip.pickupTime, 'pickup_time'),
    pickup_time_end: text(trip.pickup_time_end ?? trip.pickupTimeEnd, 'pickup_time_end'),
    pickup_at_pier: atPier === true,
  });
  const pickupError = pickupProblem(pickup);
  if (pickupError) badRequest(`${label}.${pickupError}`);
  const ovn = text(trip.ovn, 'ovn');
  if (ovn !== undefined && ovn !== 'return' && ovn !== 'self') badRequest(`${label}.ovn must be return or self`);
  const ovn_return_date = text(trip.ovn_return_date ?? trip.ovnReturnDate, 'ovn_return_date');
  if (ovn_return_date !== undefined && !isIsoDate(ovn_return_date)) badRequest(`${label}.ovn_return_date must be YYYY-MM-DD`);
  const leg = trip.ovn_leg ?? trip.ovnLeg;
  if (!unset(leg) && typeof leg !== 'boolean') badRequest(`${label}.ovn_leg must be true or false`);
  const of = trip.ovn_of ?? trip.ovnOf;
  if (!unset(of) && !(typeof of === 'number' && Number.isInteger(of) && of >= 0)) badRequest(`${label}.ovn_of must be the index of a trip in this list`);
  const zone = text(trip.zone, 'zone');
  return {
    ...(zone === undefined ? {} : { zone }),
    ...pickup,
    ...(ovn === undefined ? {} : { ovn: ovn as OvnMode }),
    ...(ovn_return_date === undefined ? {} : { ovn_return_date }),
    ...(leg === true ? { ovn_leg: true } : {}),
    ...(unset(of) ? {} : { ovn_of: of as number }),
  };
}

/** Parses an itinerary, accepting either the frontend's `trips` array or a single flat departure. */
function tripsInput(input: Record<string, unknown>): BookingTripInput[] {
  if (input.trips !== undefined) {
    if (!Array.isArray(input.trips) || input.trips.length === 0) badRequest('trips must be a non-empty array');
    const trips = (input.trips as unknown[]).map(tripInput);
    assertItinerary(trips);
    return trips;
  }
  return [tripInput({
    route_id: input.route_id, service_date: input.service_date ?? input.date, pax: input.pax, booking_mode: input.booking_mode,
    charter_boat_id: input.charter_boat_id, lock_draws: input.lock_draws,
  }, 0)];
}

/**
 * The add-on list under the frontend's `addOns` or the snake_case `add_ons`. On an amendment,
 * absent leaves the stored list alone and `null` is read as `[]` — cleared, not ignored.
 */
const addOnsOf = (input: Record<string, unknown>): unknown => {
  const value = input.addOns !== undefined ? input.addOns : input.add_ons;
  return value === null ? [] : value;
};
const addOnsLabel = (input: Record<string, unknown>): string => (input.addOns !== undefined ? 'addOns' : 'add_ons');

/**
 * The create body. Which save button it was (`intent`) is read here too, with the deprecated
 * `status` it replaces (`parseIntent`); `viaStatus` lets the route log a client still sending it.
 */
function bookingInput(body: unknown): BookingInput & { viaStatus: boolean } {
  const input = record(body);
  const { intent, viaStatus } = parseIntent(input);
  const trips = tripsInput(input);
  // A supplied top-level `pax` is a claim about the whole itinerary; disagreeing with the trips it
  // describes is a client bug worth reporting rather than silently resolving in favour of one side.
  if (input.trips !== undefined && input.pax !== undefined && pax(input.pax) !== trips.reduce((sum, trip) => sum + paxTotal(trip.pax), 0)) badRequest('pax must equal the sum of trip.pax');
  return {
    trips,
    intent,
    viaStatus,
    external_id: optionalString(input.external_id ?? input.id),
    agent_id: optionalString(input.agent_id ?? input.agentId),
    voucher_ref: optionalString(input.voucher_ref ?? input.voucherRef),
    rate_type_ref: optionalString(input.rate_type_ref ?? input.rateTypeRef),
    header: bookingHeader(input),
    passengers: parseBookingPassengers(input.passengers),
    add_ons: parseBookingAddOns(addOnsOf(input), addOnsLabel(input)),
    adjustments: parseBookingAdjustments(input.adjustments),
    alt_pickups: parseAltPickups(input.alt_pickups ?? input.altPickups ?? []),
    upgrades: parseUpgrades(input.upgrades ?? []),
    allergy_list: parseAllergyList(allergyListOf(input) ?? []),
    // booking_data: input,
  };
}

/**
 * An amendment either replaces the itinerary outright or moves the single departure it has, and
 * either way carries whichever header fields the caller mentioned.
 *
 * The header is read from the same body by the same table the create path uses, so a field
 * `POST /v1/bookings` accepts is a field `PATCH` accepts. It is read on both branches: an
 * amendment that rewrites the trips may correct the lead passenger in the same call.
 */
function bookingListQuery(query: Record<string, unknown>): BookingListQuery {
  const serviceDate = optionalString(query.service_date ?? query.date);
  const from = optionalString(query.from);
  const to = optionalString(query.to);
  if (serviceDate !== undefined && (from !== undefined || to !== undefined)) badRequest('service_date cannot be combined with from or to');
  if ((from === undefined) !== (to === undefined)) badRequest('from and to must be supplied together');
  if (from !== undefined && (!isIsoDate(from) || !isIsoDate(to!))) badRequest('from and to must be YYYY-MM-DD dates');
  if (from !== undefined && to! < from) badRequest('to must not precede from');
  const rawLimit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) badRequest('limit must be an integer between 1 and 100');
  const cursor = optionalString(query.cursor);
  const order = query.order === undefined ? undefined : query.order === 'asc' || query.order === 'desc' ? query.order : badRequest('order must be asc or desc');
  const statuses = bookingStatusList(query.status);
  // Lower-cased here, once, so the two stores compare the same text the same way.
  const q = optionalString(typeof query.q === 'string' ? query.q.trim() : undefined)?.toLowerCase();
  const voucherRef = optionalString(typeof query.voucher_ref === 'string' ? query.voucher_ref.trim() : undefined)?.toLowerCase();
  // Love Kingdom's reconciliation read (todo/b2c-sync-model.md): bookings changed at or after an instant.
  const updatedSince = parseUpdatedSince(query.updated_since);
  return {
    routeId: optionalString(query.route_id), agentId: optionalString(query.agent_id), serviceDate, from, to, limit: rawLimit, cursor,
    ...(order ? { order } : {}), ...(statuses ? { statuses } : {}), ...(q === undefined ? {} : { q }), ...(voucherRef === undefined ? {} : { voucherRef }),
    ...(updatedSince === undefined ? {} : { updatedSince }),
  };
}

/** `?status=a,b`, or the key repeated. Each value must be a known status, so a typo is a 400 rather than an empty list. */
function bookingStatusList(value: unknown): BookingStatus[] | undefined {
  if (value === undefined) return undefined;
  const parts = (Array.isArray(value) ? value : [value]).flatMap((part) => String(part).split(',')).map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  return [...new Set(parts.map((part) => bookingStatus(part)!))];
}

/** `?active=` on the rate type list, as on agents: active by default, `false` for inactive ones, `all` for both. */
function rateTypeListQuery(query: Record<string, unknown>): RateTypeListQuery {
  const active = query.active === undefined || query.active === 'true' ? true : query.active === 'false' ? false : query.active === 'all' ? undefined : badRequest('active must be true, false or all');
  return { active, q: optionalString(query.q) };
}

function bookingChanges(body: unknown): BookingChanges {
  const input = record(body);
  const status = bookingStatus(input.status);
  const header = bookingHeaderPatch(input);
  const common = {
    ...(status === undefined ? {} : { status }),
    ...(Object.keys(header).length === 0 ? {} : { header }),
    ...(input.passengers === undefined ? {} : { passengers: parseBookingPassengers(input.passengers) }),
    ...(addOnsOf(input) === undefined ? {} : { add_ons: parseBookingAddOns(addOnsOf(input), addOnsLabel(input)) }),
    // Present replaces the list, `null` or `[]` clears it, absent leaves it.
    ...(input.adjustments === undefined ? {} : { adjustments: parseBookingAdjustments(input.adjustments) }),
    ...((input.alt_pickups ?? input.altPickups) === undefined ? {} : { alt_pickups: parseAltPickups(input.alt_pickups ?? input.altPickups) }),
    ...(input.upgrades === undefined ? {} : { upgrades: parseUpgrades(input.upgrades) }),
    ...(allergyListOf(input) === undefined ? {} : { allergy_list: parseAllergyList(allergyListOf(input)) }),
  };
  if (input.trips !== undefined) return { trips: tripsInput(input), ...common };
  return {
    ...(input.route_id === undefined ? {} : { route_id: string(input.route_id, 'route_id') }),
    ...(input.service_date === undefined ? {} : { service_date: string(input.service_date, 'service_date') }),
    ...(input.pax === undefined ? {} : { pax: pax(input.pax) }),
    ...common,
  };
}
const calendarKind = (value: unknown): CalendarKind => (value === 'open' || value === 'closed' ? value : badRequest('kind must be open or closed'));
/** A real calendar day: `Date.parse` accepts `2048-02-30` and rolls it into March, so the day must survive a round trip. */
const calendarDate = (value: unknown, name: string): string => {
  const day = typeof value === 'string' && isIsoDate(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  return day && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value as string) ? value as string : badRequest(`${name} must be a YYYY-MM-DD date`);
};
/** A route with its calendar as stored, with ids, for the screen that edits it. */
const withCalendar = (route: Route, seasons: readonly RouteSeason[], overrides: readonly RouteDayOverride[]) => ({
  ...route,
  seasons: seasons.filter((s) => s.route_id === route.id)
    .sort((a, b) => a.from_date.localeCompare(b.from_date) || a.id.localeCompare(b.id))
    .map(({ id, kind: k, from_date, to_date }) => ({ id, kind: k, from_date, to_date })),
  overrides: overrides.filter((o) => o.route_id === route.id)
    .sort((a, b) => a.service_date.localeCompare(b.service_date))
    .map(({ service_date, kind: k }) => ({ service_date, kind: k })),
});
/** A `*_anyway` flag in a body (a boolean) or a query string (`true`/`false`). Absent is false. */
const anywayFlag = (value: unknown, name: string): boolean => {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return badRequest(`${name} must be true or false`);
};
/** `close_anyway` in a body (a boolean) or a query string (`true`/`false`). Absent is false. */
function closeAnyway(value: unknown): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  return badRequest('close_anyway must be true or false');
}

export type Store = OperationsStore | PostgresOperationsStore;
/** PostgreSQL when `DATABASE_URL` is set, else the in-process store. */
export const createStore = (): Store => process.env.DATABASE_URL ? new PostgresOperationsStore(process.env.DATABASE_URL) : new OperationsStore();

export function registerOperationsRoutes(app: FastifyInstance, options: { store?: Store }, done: () => void): void {
  // Every write records what it changed (`change-tracking.ts`, todo/change-feed-model.md).
  const store = trackChanges(options.store ?? createStore());
  app.addHook('onRequest', (request, _reply, next) => { changeContext.enterWith({ request, depth: 0 }); next(); });
  const authenticator = new Authenticator();
  if (store instanceof PostgresOperationsStore) app.addHook('onClose', async () => store.close());
  // Route schemas in this plugin are documentation only (see `openapi.ts`): the hand-written parsers
  // validate, and responses are sent exactly as the store returns them. An error reaches the
  // serializer with non-enumerable fields, which `JSON.stringify` would drop, so it gets the same four
  // fields Fastify's own error path writes.
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(({ httpStatus }) => String(httpStatus).startsWith('2')
    ? (data) => JSON.stringify(data)
    : (data) => { const e = data as { statusCode?: number; code?: string; error?: string; message?: string }; return JSON.stringify({ statusCode: e.statusCode, code: e.code, error: e.error, message: e.message }); });
  // A refusal that carries more than a message (`seats_short` lists the short days) sends it beside
  // the usual four fields. Every other error goes to Fastify's own handler, as before.
  app.setErrorHandler((error, _request, reply) => {
    const extra = (error as { extra?: object }).extra;
    if (!extra) throw error;
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    // Serialized here, so a route's documented error shape cannot drop the extra fields.
    return reply.code(statusCode).type('application/json').serializer(JSON.stringify)
      .send({ statusCode, code: (error as { code?: string }).code, error: STATUS_CODES[statusCode], message: (error as Error).message, ...extra });
  });
  /**
   * Every request but `/v1/login` is authenticated, and every write is checked against the caller's
   * rights (`assertMayWrite`): what legacy checked only in the browser. Any logged-in user may read.
   * With authentication off (no `AUTH_JWT_SECRET`) nothing is checked: local development.
   */
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    if (path === '/v1/login') return;
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const caller = authenticator.authenticateApiKey(request) ?? await authenticator.authenticate(request, store);
    if (!caller) return;
    if (caller.apiKey) {
      if (isWrite || path !== '/v1/availability') forbidden('The X-Api-Key opens GET /v1/availability only');
      return;
    }
    const user = caller.user!;
    if (isWrite) assertMayWrite(user, path);
    else if ((path === '/v1/users' || path.startsWith('/v1/users/')) && user.role !== 'admin') forbidden('Only an admin may do this');
    // A login tied to one agent sees that agent's bookings only; another booking is not found.
    const own = user.agent_id === null ? undefined : /^\/v1\/bookings\/([^/]+)/.exec(path);
    if (own && (await store.booking(decodeURIComponent(own[1])))?.agent_id !== user.agent_id) notFound('Booking not found');
  });

  /**
   * Before `approve` or `reject`: may the caller decide what this booking waits for? Read in the
   * command's own transaction, so the approval checked is the one decided. Off with authentication
   * off; a booking not waiting is left to the command, which refuses it with `409`.
   */
  const assertMayDecideOn = async (request: { user?: { user?: StoredUser } }, id: string): Promise<void> => {
    const user = request.user?.user;
    if (!user) return;
    const booking = await store.booking(id);
    if (!booking || (booking.status !== 'pending_approval' && booking.status !== 'pending_foc')) return;
    const approval = pendingApproval(booking.approvals, booking.status === 'pending_foc' ? 'foc' : 'approval');
    const salesId = booking.agent_id ? (await store.agent(booking.agent_id))?.sales_id ?? null : null;
    assertMayDecide(user, approval, salesId);
  };

  /**
   * Refuse a write made from a stale copy (`src/domain/versions.ts`): the version sent as `If-Match`
   * or `version` against the record's own. Called first inside the write's transaction, so the version
   * checked is the one the write replaces. A record not found is left to the write, which answers 404.
   */
  const sentVersion = (request: { headers: Record<string, unknown>; body?: unknown }): number | undefined =>
    expectedVersion(request.headers['if-match'], isRecord(request.body) ? request.body.version : undefined);
  /**
   * A logged-in caller must send the version it read (decided 2026-10-09): a save without it would
   * overwrite edits it has not seen. With authentication off nothing is checked, as for permissions.
   */
  const requireVersion = (request: { user?: { user?: StoredUser } }, what: string): never | undefined =>
    request.user?.user ? refuseWith(`Send the ${what}'s version you read, as If-Match: "7" or "version": 7 in the body, so this save cannot overwrite a change you have not seen`, 428, 'version_required') : undefined;
  const assertBookingFresh = async (request: { headers: Record<string, unknown>; body?: unknown; params: unknown; user?: { user?: StoredUser } }): Promise<void> => {
    const expected = sentVersion(request);
    if (expected === undefined) return requireVersion(request, 'booking');
    const current = await store.booking(bookingId(request));
    if (current) assertFresh(`Booking ${current.id}`, expected, current.version);
  };
  // The seat-lock commands, written once over the store (seat-lock-service.ts).
  const locks = new SeatLockService(store);
  const assertLockFresh = async (request: { headers: Record<string, unknown>; body?: unknown; params: unknown; user?: { user?: StoredUser } }): Promise<void> => {
    const expected = sentVersion(request);
    if (expected === undefined) return requireVersion(request, 'seat lock');
    const current = await locks.lock(lockId(request));
    if (current) assertFresh(`Seat lock ${current.id}`, expected, current.version);
  };
  const assertGroupFresh = async (request: { headers: Record<string, unknown>; body?: unknown; params: unknown; user?: { user?: StoredUser } }): Promise<void> => {
    const expected = sentVersion(request);
    if (expected === undefined) return requireVersion(request, 'bulk lock');
    const [current] = await store.lockGroupRows({ ids: [lockId(request)] });
    if (current) assertFresh(`Seat lock group ${current.id}`, expected, current.version);
  };
  // The version of the booking or lock a response carries, as its `ETag`, so a client can send it back.
  app.addHook('preSerialization', async (_request, reply, payload) => {
    if (isRecord(payload) && typeof payload.version === 'number') reply.header('etag', `"${payload.version}"`);
    return payload;
  });

  /** The caller's login; `401` when authentication is off, where there is none. */
  const me = (request: { user?: { user?: StoredUser } }): StoredUser => request.user?.user ?? unauthorized('Not logged in');
  /** A user's `sales_id` and `agent_id` must name a salesperson and an agent that exist. */
  const assertLinks = async (links: { sales_id?: string | null; agent_id?: string | null }): Promise<void> => {
    if (links.sales_id && !(await store.listSalesPeople()).some((person) => person.id === links.sales_id)) badRequest(`sales_id ${links.sales_id} is not a salesperson (GET /v1/sales)`);
    if (links.agent_id && !(await store.agent(links.agent_id))) badRequest(`agent_id ${links.agent_id} is not an agent (GET /v1/agents)`);
  };

  /**
   * Legacy's login, moved here (todo/login-permissions-model.md): its users are imported with their
   * usernames and password hashes, so everyone logs in as before. Answers a 12-hour Bearer token and
   * the user, as `GET /v1/me` shows it.
   */
  app.post('/v1/login', async (request) => {
    const body = record(request.body);
    const { token, expiresIn, user } = await authenticator.login(string(body.username, 'username'), string(body.password, 'password'), store);
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, user: userView(user) };
  });
  /** Ends every session of the caller's login, on every device (legacy `revokeSessions`). */
  app.post('/v1/logout', async (request, reply) => {
    await store.updateUser(me(request).id, { tokens_valid_after: new Date().toISOString() });
    return reply.code(204).send();
  });
  app.get('/v1/me', async (request) => userView(me(request)));
  /** The caller's own password; needs the old one. Ends the other sessions and answers a new token. */
  app.post('/v1/me/password', async (request) => {
    const body = record(request.body);
    const user = me(request);
    if (!verifyPassword(password(body.old_password, 'old_password'), user.pass_hash)) forbidden('The old password is wrong');
    const fresh = password(body.new_password, 'new_password');
    await store.updateUser(user.id, { pass_hash: hashPassword(fresh), tokens_valid_after: new Date().toISOString() });
    const { token, expiresIn } = await authenticator.login(user.username, fresh, store);
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn };
  });

  /** Admin only (the hook). Legacy's `/api/users*`; a user is disabled, never deleted. */
  app.get('/v1/users', async () => ({ users: (await store.listUsers()).map(userView) }));
  app.post('/v1/users', async (request, reply) => {
    const { password: plain, ...input } = parseNewUser(record(request.body));
    await assertLinks(input);
    const user = await store.transaction(async () => store.createUser({ ...input, pass_hash: hashPassword(plain) }));
    return reply.code(201).send(userView(user));
  });
  app.patch('/v1/users/:id', async (request) => {
    const id = userId(request);
    const patch = parseUserPatch(record(request.body), new Date().toISOString());
    if (id === me(request).id && (patch.disabled_at || patch.role === 'staff')) badRequest('An admin cannot disable or demote their own login');
    await assertLinks(patch);
    return userView((await store.transaction(async () => store.updateUser(id, patch))) ?? notFound('User not found'));
  });
  /** An admin sets a user's password (legacy `/api/users/password`); the user's sessions end. */
  app.post('/v1/users/:id/password', async (request) => {
    const body = record(request.body);
    const update = { pass_hash: hashPassword(password(body.password)), tokens_valid_after: new Date().toISOString() };
    return userView((await store.transaction(async () => store.updateUser(userId(request), update))) ?? notFound('User not found'));
  });

  /**
   * The route catalogue, optionally with each route's operating calendar resolved per date.
   *
   * Without `from`/`to` this is the catalogue alone, which is what a client needs to label a
   * booking row. With them, every date carries the open/closed decision and the rule that made it,
   * so a closed day can explain itself rather than just refusing.
   */
  app.get('/v1/routes', { schema: docs.routes }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const from = optionalString(query.from), to = optionalString(query.to);
    if ((from === undefined) !== (to === undefined)) badRequest('from and to must be supplied together');
    const kind = optionalString(query.kind);
    if (kind !== undefined && !isRouteKind(kind)) badRequest('kind must be marine or land');
    // Each route carries its calendar as stored, with ids, for the screen that edits it; `days` below
    // is the same calendar resolved.
    const seasons = await store.listSeasons(), overrides = await store.listDayOverrides();
    const routes = (await store.listRoutes()).filter((route) => kind === undefined || route.kind === kind).map((route) => withCalendar(route, seasons, overrides));
    if (from === undefined || to === undefined) return { routes };

    if (!isIsoDate(from) || !isIsoDate(to)) badRequest('from and to must be YYYY-MM-DD dates');
    if (to < from) badRequest('to must not precede from');
    // A sweep is one query per table regardless of width, but the response grows with routes × days.
    const days = [...eachDate(from, to)].length;
    if (days > MAX_CALENDAR_DAYS) badRequest(`Range covers ${days} days; the maximum is ${MAX_CALENDAR_DAYS}`);

    const calendar = routeCalendar(await store.listSeasons(), await store.listDayOverrides(from, to));
    return { from, to, routes: routes.map((route) => ({ ...route, days: calendar.range(route.id, from, to) })) };
  });

  /**
   * Settings → Programs: a route's calendar is edited here, and only here. `seed:routes` copies it
   * only for a route new here. A change that closes a day holding bookings or a boat is `409
   * bookings_on_closed_day` unless it carries `close_anyway` (`assertCloseAllowed`).
   */
  const calendarRoute = (request: { params: unknown }): string => (request.params as { id: string }).id;
  app.post('/v1/routes/:id/seasons', { schema: docs.addSeason }, async (request, reply) => {
    const body = record(request.body);
    const from_date = calendarDate(body.from_date, 'from_date'), to_date = calendarDate(body.to_date, 'to_date');
    if (to_date < from_date) badRequest('to_date must not precede from_date');
    const season = { id: store.newSeasonId(), route_id: calendarRoute(request), kind: calendarKind(body.kind), from_date, to_date };
    await store.transaction(() => store.changeCalendar(season.route_id, { op: 'add-season', season }, closeAnyway(body.close_anyway), todayInThailand()));
    return reply.code(201).send(season);
  });
  app.delete('/v1/routes/:id/seasons/:season_id', { schema: docs.deleteSeason }, async (request, reply) => {
    const { season_id } = request.params as { season_id: string };
    const query = request.query as Record<string, unknown>;
    await store.transaction(() => store.changeCalendar(calendarRoute(request), { op: 'delete-season', season_id }, closeAnyway(query.close_anyway), todayInThailand()));
    return reply.code(204).send();
  });
  app.put('/v1/routes/:id/days/:date', { schema: docs.setDay }, async (request) => {
    const body = record(request.body);
    const override = { route_id: calendarRoute(request), service_date: calendarDate((request.params as { date: string }).date, 'date'), kind: calendarKind(body.kind) };
    await store.transaction(() => store.changeCalendar(override.route_id, { op: 'set-day', override }, closeAnyway(body.close_anyway), todayInThailand()));
    return override;
  });
  app.delete('/v1/routes/:id/days/:date', { schema: docs.clearDay }, async (request, reply) => {
    const service_date = calendarDate((request.params as { date: string }).date, 'date');
    const query = request.query as Record<string, unknown>;
    await store.transaction(() => store.changeCalendar(calendarRoute(request), { op: 'clear-day', service_date }, closeAnyway(query.close_anyway), todayInThailand()));
    return reply.code(204).send();
  });

  /**
   * The boat catalogue, as a static reference list.
   *
   * Deliberately not date-aware: `boat_capacity_overrides` changes a boat's seats for one day, but
   * `/v1/availability` already resolves that against the day's deployment, and answering it twice
   * invites the two answers to disagree.
   *
   * `charter_ceiling` is the resolved answer to how many passengers a charter may fill this boat to,
   * computed here so no client re-implements the fallback. `license_pax` is null for a boat with no
   * licence on file: claiming a registration the vessel does not hold would be worse than saying
   * there is none, and a missing licence is not a licence of zero.
   */
  /** `status_effective` and `blocked_by`: today's status with open work (fleet's `boatEffStatus`) beside the log's own. */
  const withAvailability = async (boats: BoatRecord[]) => {
    const today = todayInThailand();
    const ready = await boatsAvailableToday(store, boats);
    return boats.map((boat) => ({ ...boatView(boat, today), status_effective: ready.get(boat.id)!.status, blocked_by: ready.get(boat.id)!.blocked_by }));
  };
  app.get('/v1/boats', async () => ({ boats: await withAvailability(await store.boatRecords()) }));
  app.get('/v1/boats/:id', async (request) => (await withAvailability([(await store.boatRecord(paramId(request))) ?? notFound('Boat not found')]))[0]);

  // ── Editing the catalogue (todo/catalogue-editing-model.md, decided 2026-10-09). The rules are
  //    `src/domain/catalogue.ts`'s; these gather rows and write what it answers. ──

  /** Programme families: an editable table (decision 8), `config`. */
  app.get('/v1/route-families', async () => ({ families: await store.listRouteFamilies() }));
  app.post('/v1/route-families', async (request, reply) => reply.code(201).send(await store.transaction(async () => {
    const family = parseNewFamily(record(request.body), new Set((await store.listRouteFamilies()).map((f) => f.id)));
    await store.insertRouteFamily(family);
    return family;
  })));
  app.patch('/v1/route-families/:id', async (request) => {
    const patch = parseFamilyPatch(record(request.body));
    return (await store.transaction(async () => store.updateRouteFamily(paramId(request), patch))) ?? notFound('Family not found');
  });
  app.delete('/v1/route-families/:id', async (request, reply) => {
    await store.transaction(async () => {
      const id = paramId(request);
      if (!(await store.listRouteFamilies()).some((f) => f.id === id)) notFound('Family not found');
      assertFamilyUnused(id, await store.familyUsage(id));
      await store.deleteRouteFamily(id);
    });
    return reply.code(204).send();
  });

  /** One route with its calendar as stored, as the list shows it. */
  const routeView = async (route: Route) => withCalendar(route, await store.listSeasons(), await store.listDayOverrides());
  const familyIds = async () => new Set((await store.listRouteFamilies()).map((f) => f.id));
  app.get('/v1/routes/:id', async (request) => routeView((await store.route(paramId(request))) ?? notFound('Route not found')));
  /**
   * Settings → Programs' "add" (`saveRoute`) and Love Kingdom's create (`POST /api/b2c/routes`):
   * a route whose `ext_id` is already here answers `200` with it, `created: false`, and changes nothing.
   */
  app.post('/v1/routes', async (request, reply) => {
    const { fields, seasons } = parseNewRoute(record(request.body));
    const result = await store.transaction(async () => {
      if (fields.ext_id) {
        const existing = await store.routeByExtId(fields.ext_id);
        if (existing) return { created: false, route: existing, warnings: [] as { code: string; message: string }[] };
      }
      const routes = await store.listRoutes();
      const family = fields.family_id !== undefined ? fields.family_id : guessFamily(fields.name, fields.kind)
        ?? badRequest('family_id is required: it could not be told from the name. GET /v1/route-families lists them; null means no family (not shown on the Booking calendar)');
      assertFamily(family, await familyIds());
      const route = newRoute(fields, family, routes, Date.now());
      await store.insertRoute(route, seasons.map((s) => ({ ...s, id: store.newSeasonId(), route_id: route.id })));
      return { created: true, route: (await store.route(route.id))!, warnings: duplicateNameWarnings(route.name, routes) };
    });
    return reply.code(result.created ? 201 : 200).send({ ...result, route: await routeView(result.route) });
  });
  /** Settings → Programs' "edit": client facts only (`sort` and the calendar have their own endpoints). */
  app.patch('/v1/routes/:id', async (request) => {
    const patch = parseRoutePatch(record(request.body));
    const id = paramId(request);
    const route = await store.transaction(async () => {
      const current = (await store.route(id)) ?? notFound('Route not found');
      const next = patchedRoute(current, patch);
      if (patch.family_id !== undefined) assertFamily(next.family_id, await familyIds());
      if (next.ext_id) {
        const owner = await store.routeByExtId(next.ext_id);
        if (owner && owner.id !== id) extIdTaken(next.ext_id, owner.id);
      }
      await store.updateRoute(id, next);
      return (await store.route(id))!;
    });
    return routeView(route);
  });
  /** Refused while anything refers to the route (decision 6); its calendar goes with it. */
  app.delete('/v1/routes/:id', async (request, reply) => {
    await store.transaction(async () => {
      const route = (await store.route(paramId(request))) ?? notFound('Route not found');
      assertRouteUnused(route, await store.routeUsage(route.id));
      await store.deleteRoute(route.id);
    });
    return reply.code(204).send();
  });
  /** Legacy's drag within one pier (`stApplyRouteOrder`): every route is renumbered. */
  app.post('/v1/routes/order', async (request) => store.transaction(async () => {
    const sorts = routeOrder(await store.listRoutes(), record(request.body));
    await store.setRouteSorts(sorts);
    return { routes: [...sorts].map(([id, sort]) => ({ id, sort })) };
  }));

  /** The boat form (`saveBoat`, decision 3), `config`. */
  app.post('/v1/boats', async (request, reply) => {
    const input = parseBoatInput(record(request.body), 'create');
    const saved = await store.transaction(async () => {
      const now = Date.now();
      const id = nextCatalogueId('b', new Set((await store.boatRecords()).map((b) => b.id)), now);
      const boat: BoatRecord = { ...blankBoat({ id, name: input.fields.name!, capacity: input.fields.capacity! }), ...input.fields, documents: input.documents ?? [] };
      boat.status_log = withFormStatus([], boat.ownership, boat.pier, input.status ?? 'available', todayInThailand(), now, true);
      return store.writeBoat(boat, new Date(now).toISOString());
    });
    return reply.code(201).send({ ...boatView(saved, todayInThailand()), warnings: boatWarnings(saved) });
  });
  /**
   * The boat form's edit. A change of seats, licence or persons aboard reaches every deployment of the
   * boat from today on (decision 5); a day that would carry more passengers than its new seats needs
   * `capacity_anyway` (`409 seats_sold`).
   */
  app.patch('/v1/boats/:id', async (request) => {
    const { capacity_anyway: anywayRaw, ...body } = record(request.body);
    const anyway = anywayFlag(anywayRaw, 'capacity_anyway');
    const input = parseBoatInput(body, 'patch');
    const id = paramId(request);
    return store.transaction(async () => {
      const current = (await store.boatRecord(id)) ?? notFound('Boat not found');
      const now = Date.now(), today = todayInThailand();
      const next: BoatRecord = { ...copyBoat(current), ...input.fields, ...(input.documents ? { documents: input.documents } : {}) };
      if (input.status) next.status_log = withFormStatus(current.status_log, next.ownership, next.pier, input.status, today, now);
      let oversold: OversoldWarning[] = [], updated = 0;
      if (next.capacity !== current.capacity || next.license_pax !== current.license_pax || next.registered_persons !== current.registered_persons) {
        const overrides = new Map((await store.boatCapacityOverrides(id, today)).map((o) => [o.service_date, o.capacity]));
        const days: DeploymentDay[] = [];
        for (const d of await store.boatDeploymentsFrom(id, today)) {
          const override = overrides.get(d.service_date);
          // Only a day that loses seats needs its passengers weighed.
          if (!seatsDrop(current, next, override)) continue;
          days.push({ deployment: d, override_capacity: override, placed: placedOn(await store.bookingsOn(d.service_date, d.route_id), id, d.route_id, d.service_date) });
        }
        oversold = capacityChange(next.name, current, next, days, anyway);
        updated = (await store.updateBoatDeployments(id, today, deploymentNumbers(next))).length;
      }
      const saved = await store.writeBoat(next, new Date(now).toISOString());
      return { ...boatView(saved, today), deployments_updated: updated, warnings: [...boatWarnings(saved), ...oversold] };
    });
  });
  /** Retire and restore (decision 13; legacy `flRetireBoat`, `flUnretireBoat`), `fleet`. */
  app.post('/v1/boats/:id/retire', async (request) => {
    const body = request.body === undefined || request.body === null ? {} : record(request.body);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : body.reason === undefined || body.reason === null || body.reason === '' ? null : badRequest('reason must be a string');
    return store.transaction(async () => {
      const current = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
      const today = todayInThailand();
      const next = retiredBoat(current, await store.boatDeploymentsFrom(current.id, today), reason, today, Date.now());
      return boatView(await store.writeBoat(next, new Date().toISOString()), today);
    });
  });
  app.post('/v1/boats/:id/restore', async (request) => store.transaction(async () => {
    const current = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
    const today = todayInThailand();
    return boatView(await store.writeBoat(restoredBoat(current, today, Date.now()), new Date().toISOString()), today);
  }));
  /** The status timeline (legacy `saveStatus`, `editStatus`, `delStatus`), `config`. */
  const entryId = (request: { params: unknown }): string => (request.params as { entry_id: string }).entry_id;
  /**
   * An `available` entry while open work still holds the boat on its first day is legacy's confirm
   * (`§boatPlanAhead`): `409 open_work`, or with `plan_ahead: true` the boat is planned ahead of it.
   */
  const plannedEntry = async (current: BoatRecord, saved: { log: BoatRecord['status_log']; entry: BoatRecord['status_log'][number] }, confirmed: boolean) => {
    const entry = planAhead(saved.entry, current.name, current.id, await openWork(store, current.id), confirmed);
    return { log: saved.log.map((e) => (e.id === entry.id ? entry : e)), entry };
  };
  app.post('/v1/boats/:id/status-log', async (request, reply) => {
    const { plan_ahead: planRaw, ...rest } = record(request.body);
    const confirmed = anywayFlag(planRaw, 'plan_ahead');
    const fields = parseStatusEntry(rest);
    return reply.code(201).send(await store.transaction(async () => {
      const current = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
      const { log, entry } = await plannedEntry(current, addStatusEntry(current.status_log, fields, Date.now()), confirmed);
      await store.writeBoat({ ...current, status_log: log }, new Date().toISOString());
      return entry;
    }));
  });
  app.patch('/v1/boats/:id/status-log/:entry_id', async (request) => {
    const { plan_ahead: planRaw, ...rest } = record(request.body);
    const confirmed = anywayFlag(planRaw, 'plan_ahead');
    const fields = parseStatusEntry(rest);
    return store.transaction(async () => {
      const current = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
      const { log, entry } = await plannedEntry(current, editStatusEntry(current.status_log, entryId(request), fields), confirmed);
      await store.writeBoat({ ...current, status_log: log }, new Date().toISOString());
      return entry;
    });
  });
  app.delete('/v1/boats/:id/status-log/:entry_id', async (request, reply) => {
    await store.transaction(async () => {
      const current = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
      if (!current.status_log.some((e) => e.id === entryId(request))) notFound('Status entry not found');
      await store.writeBoat({ ...current, status_log: current.status_log.filter((e) => e.id !== entryId(request)) }, new Date().toISOString());
    });
    return reply.code(204).send();
  });

  /** A boat's seats for one day (decision 10; legacy `boatCapSet`), `operations`. */
  const overrideDate = (request: { params: unknown }): string => realDate((request.params as { date: string }).date, 'date');
  app.get('/v1/boats/:id/capacity-overrides', async (request) => {
    const query = request.query as Record<string, unknown>;
    const from = query.from === undefined ? undefined : realDate(query.from, 'from'), to = query.to === undefined ? undefined : realDate(query.to, 'to');
    const boat = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
    const deployed = new Map((await store.listDeployments(from, to)).filter((d) => d.boat_id === boat.id).map((d) => [d.service_date, d]));
    return { overrides: (await store.boatCapacityOverrides(boat.id, from, to)).map((o) => overrideDay(boat, o.service_date, deployed.get(o.service_date), o)) };
  });
  app.put('/v1/boats/:id/capacity-overrides/:date', async (request) => {
    const date = overrideDate(request);
    const req = parseOverrideRequest(record(request.body));
    return store.transaction(async () => {
      const boat = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
      assertNotPast(boat.name, date, todayInThailand());
      const deployment = (await store.listDeployments(date, date)).find((d) => d.boat_id === boat.id);
      const day = overrideDay(boat, date, deployment, (await store.boatCapacityOverrides(boat.id, date, date))[0]);
      const user = request.user?.user;
      const plan = planOverride(req, day, { boatName: boat.name, mayRaise: !user || user.role === 'admin' || user.actions.includes('act-capunlock') });
      if (plan.remove) await store.deleteBoatCapacityOverride(boat.id, date);
      else await store.putBoatCapacityOverride({ boat_id: boat.id, service_date: date, capacity: plan.capacity, reason: plan.reason, set_by: actorOf(request.user) ?? null, set_at: new Date().toISOString() });
      return overrideDay(boat, date, deployment, (await store.boatCapacityOverrides(boat.id, date, date))[0]);
    });
  });
  app.delete('/v1/boats/:id/capacity-overrides/:date', async (request, reply) => {
    const date = overrideDate(request);
    await store.transaction(async () => {
      const boat = (await store.boatRecord(paramId(request))) ?? notFound('Boat not found');
      assertNotPast(boat.name, date, todayInThailand());
      if (!(await store.deleteBoatCapacityOverride(boat.id, date))) notFound(`${boat.name} has no seats set for ${date}`);
    });
    return reply.code(204).send();
  });

  /**
   * One route on one day (`route_id` + `date`), or a list of route-days over `from..to` for one route
   * or, without `route_id`, every route in the catalogue — so a month grid asks once, not per cell.
   *
   * Each range entry carries the calendar's `open` beside the seat numbers: a closed day with no
   * boat and an open day nobody has staffed yet both have zero seats, and only `open` tells them
   * apart. `deployments[].capacity` is the boat's sellable seats that day, after any override and
   * the licence clamp, so the entries sum to `deployed_capacity`.
   */
  app.get('/v1/availability', { schema: docs.availability }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const from = optionalString(query.from); const to = optionalString(query.to);
    const date = optionalString(query.service_date ?? query.date);
    if (from === undefined && to === undefined) {
      const route_id = string(query.route_id, 'route_id');
      const service_date = date ?? badRequest('date is required, or from and to for a range');
      return { route_id, service_date, ...(await store.capacity(route_id, service_date, exclusion(query))) };
    }

    if (date !== undefined) badRequest('Pass either date or from and to, not both');
    if (from === undefined || to === undefined) return badRequest('from and to must be supplied together');
    if (!isIsoDate(from) || !isIsoDate(to)) badRequest('from and to must be YYYY-MM-DD dates');
    if (to < from) badRequest('to must not precede from');
    const routeId = optionalString(query.route_id);
    const limit = routeId === undefined ? MAX_ALL_ROUTES_DAYS : MAX_CALENDAR_DAYS;
    const span = [...eachDate(from, to)].length;
    if (span > limit) badRequest(`Range covers ${span} days; the maximum is ${limit}${routeId === undefined ? ' without route_id' : ''}`);

    const routeIds = routeId === undefined ? (await store.listRoutes()).map((route) => route.id) : [routeId];
    const calendar = routeCalendar(await store.listSeasons(), await store.listDayOverrides(from, to));
    const days = await store.dayRange(routeIds, from, to, exclusion(query));
    return {
      days: days.map((day) => ({
        route_id: day.route_id, service_date: day.service_date, open: calendar.isOpen(day.route_id, day.service_date),
        ...capacityNumbers(day),
        deployments: day.boats.map((boat) => ({ boat_id: boat.boat_id, capacity: boat.sellable, license_pax: boat.license_pax ?? null, chartered: boat.chartered })),
      })),
    };
  });

  app.get('/v1/bookings', { schema: docs.listBookings }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const agent = request.user?.user?.agent_id;
    // A login tied to one agent lists that agent's bookings, whatever filter it asks for.
    return await store.listBookings({ ...bookingListQuery(query), ...(agent ? { agentId: agent } : {}) });
  });
  app.get('/v1/bookings/:id', { schema: docs.getBooking }, async (request) => (await store.booking((request.params as { id: string }).id)) ?? notFound('Booking not found'));
  /**
   * Every write is signed by the token's user (`actorOf`): `updated_by` comes from the token and a
   * body's `updated_by` is ignored, and each write appends one line to the booking's history in the
   * same transaction. Who created a booking and when, and who confirmed it and when, are the
   * server's (`createHeader`, `stripServerOwned`); the status moves only through the commands
   * below. See `booking-actions.ts`.
   */
  app.post('/v1/bookings', { schema: docs.createBooking }, async (request, reply) => {
    const outcome = await holdOnBadInput(request, 'create', () => createBooking(request));
    return 'held' in outcome ? reply.code(202).send(outcome.held) : reply.code(201).send(outcome.done);
  });
  async function createBooking(request: FastifyRequest) {
    const actor = actorOf(request.user);
    const { viaStatus, ...input } = bookingInput(request.body);
    const agent = request.user?.user?.agent_id;
    if (agent) {
      if (input.agent_id !== undefined && input.agent_id !== agent) forbidden(`This login books for agent ${agent} only`);
      input.agent_id = agent;
    }
    // `status` on create is deprecated for `intent` and goes when both clients send `intent`; the
    // log says who still sends it.
    if (viaStatus) request.log.warn({ status: (request.body as Record<string, unknown>).status, intent: input.intent }, 'deprecated: POST /v1/bookings with status; send intent');
    // A deactivated agent takes no new bookings (todo/sales-editing-model.md, decision 1).
    if (input.agent_id) assertAgentBookable(await store.agent(input.agent_id));
    // The server prices the booking (README "Prices"); a B2C booking keeps the price sent.
    await fillPickups(input.header?.pickup_area_id, input.header?.dropoff_area_id, input.trips);
    const priced = isB2C(input) ? undefined : await priceFor({ agentId: input.agent_id, header: input.header ?? {}, trips: input.trips,
      add_ons: input.add_ons ?? [], adjustments: input.adjustments ?? [], rateTypeRef: input.rate_type_ref, rate: 'agent' });
    // A manual total is kept only when the booking is priced by hand (legacy).
    const { manual_total: manualTotal, ...priceHeader } = priced?.header ?? {};
    const { manual_total: sentManual, ...sentHeader } = input.header ?? {};
    const manual = priced ? manualTotal ?? undefined : sentManual;
    const header = createHeader({ ...sentHeader, ...(priceHeader as BookingHeader), ...(manual === undefined ? {} : { manual_total: manual }) }, actor, new Date().toISOString());
    const q = priced?.quote;
    const created = await store.transaction(async () => {
      const attachments = await bookingFiles(record(request.body), [], actor, input.upgrades);
      const booking = await store.createBooking({
        ...input, header, ...(attachments ? { attachments } : {}),
        ...(priced ? { rate_type_ref: priced.rateTypeRef ?? undefined } : {}),
        ...(q ? { add_ons: (input.add_ons ?? []).map((a, i) => ({ ...a, amount: q.add_ons[i].amount })) } : {}),
      }, actor);
      await syncAltParts(booking);
      // Love Kingdom resent an order it had held, and now it books: the held one is settled.
      if (isB2CPush(request.user?.user) && booking.external_id) await resolveHeldCreates(booking.external_id, booking.id, actor);
      if (!q) return (await store.booking(booking.id))!;
      await store.setPrices(booking.id, { trips: q.trips, add_ons: q.add_ons.map((a) => a.amount) });
      return (await store.booking(booking.id))!;
    });
    const warnings = priced ? [...replacedPrices(input.header, priced.header), ...priced.quote.warnings] : [];
    return withIssues(request, warnings.length ? { ...created, price_warnings: warnings } : created);
  }

  /**
   * Love Kingdom's push (todo/b2c-sync-model.md, decided 2026-10-09). A write from its login that is
   * refused as bad input (`400`) is held for ops instead of lost: the raw body is kept with the
   * refusal's message and the answer is `202 held_for_review`. Nothing of the booking changes. Any
   * other refusal, and every other caller, gets the refusal as before: a person can fix the field.
   */
  async function holdOnBadInput<T>(request: FastifyRequest, action: HeldAction, work: () => Promise<T>): Promise<{ done: T } | { held: ReturnType<typeof heldResponse> }> {
    try {
      return { done: await work() };
    } catch (error) {
      if (!isB2CPush(request.user?.user) || (error as { statusCode?: number }).statusCode !== 400) throw error;
      const body = request.body ?? null;
      const target = action === 'create' ? undefined : await store.booking(bookingId(request));
      const input: HeldInput = {
        action, booking_id: target?.id ?? null, request: body, problem: (error as Error).message, received_by: actorOf(request.user) ?? null,
        external_id: action === 'create' ? optionalString(isRecord(body) ? body.external_id ?? body.id : undefined) ?? null : target?.external_id ?? null,
      };
      const held = await store.transaction(async () => {
        const open = input.action === 'create' && input.external_id ? await store.listHeldOrders({ status: 'open', externalId: input.external_id }) : [];
        const row = holdOrder(input, open.find((h) => sameHeldCreate(h, input)), `held_${randomUUID()}`, new Date().toISOString());
        await store.putHeldOrder(row);
        // `held_order` tells the change feed this write held an order and changed no booking.
        return { held_order: row };
      });
      request.log.warn({ held_order: held.held_order.id, action, problem: held.held_order.problem }, 'Love Kingdom write held for review');
      return { held: heldResponse(held.held_order) };
    }
  }
  /** Settles the open held create of an order Love Kingdom has now booked. */
  async function resolveHeldCreates(externalId: string, bookingIdNow: string, actor: string | undefined): Promise<void> {
    for (const held of await store.listHeldOrders({ status: 'open', externalId })) {
      if (held.action !== 'create') continue;
      await store.putHeldOrder(decideHeld(held, { status: 'resolved', note: `Booked as ${bookingIdNow}`, resolved_booking_id: bookingIdNow }, actor ?? null, new Date().toISOString()));
    }
  }
  /** Love Kingdom's login is told what is wrong in what it stored (`bookingIssues`); nobody else's response changes. */
  const withIssues = <B extends Booking>(request: FastifyRequest, booking: B): B | (B & { issues: ReturnType<typeof bookingIssues> }) =>
    isB2CPush(request.user?.user) ? { ...booking, issues: bookingIssues(booking) } : booking;
  /**
   * A booking's documents (`attachments`) and its upgrades' payment slips name uploaded files: each must
   * exist (`400`). Answers the documents to store, a kept one keeping who added it and when, or
   * undefined when the body doesn't send `attachments`.
   */
  async function bookingFiles(body: Record<string, unknown>, current: Booking['attachments'], actor: string | undefined, upgrades?: readonly { slips: string[] }[]) {
    const docs = body.attachments === undefined ? undefined : parseAttachmentIds(body.attachments, 'attachments');
    const ids = [...(docs ?? []).map((d) => d.id), ...(upgrades ?? []).flatMap((u) => u.slips)];
    if (ids.length) assertKnownFiles(ids, new Set((await store.attachmentRefs(ids)).keys()), 'attachments');
    return docs && documentRows(docs, current, new Date().toISOString(), actor ?? null);
  }
  app.patch('/v1/bookings/:id', { schema: docs.amendBooking }, async (request, reply) => {
    const outcome = await holdOnBadInput(request, 'amend', () => amendBooking(request));
    return 'held' in outcome ? reply.code(202).send(outcome.held) : withIssues(request, outcome.done);
  });
  async function amendBooking(request: FastifyRequest) {
    const actor = actorOf(request.user);
    const { version: _version, rate, ...body } = record(request.body);
    const changes = bookingChanges(body);
    // An edit re-prices only when it changes something the price reads (decided 2026-10-09).
    const repricing = rate === 'agent' || ['trips', 'route_id', 'service_date', 'pax', 'add_ons', 'addOns', 'adjustments'].some((key) => body[key] !== undefined)
      || (['price_mode', 'manual_total', 'staff_purpose', 'booking_date'] as const).some((key) => changes.header?.[key] !== undefined);
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const stored = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
      assertReconfirmEcho(body.reconfirm, stored.reconfirm);
      assertDocCheckEcho(body.doc_check, stored.doc_check);
      assertInsuranceEcho(body.passengers, stored.passengers);
      assertPaymentEcho(body, stored);
      await fillPickups(changes.header?.pickup_area_id === undefined ? stored.pickup_area_id : changes.header.pickup_area_id ?? undefined,
        changes.header?.dropoff_area_id ?? undefined, changes.trips, changes.header?.pickup_area_id !== undefined);
      let header = changes.header;
      let warnings: PriceWarning[] = [];
      let priced: Awaited<ReturnType<typeof priceFor>> | undefined;
      if (!isB2C(stored)) {
        const sent = header && Object.fromEntries(PRICE_FIELDS.filter((f) => header![f] !== undefined).map((f) => [f, header![f]]));
        header = header && Object.fromEntries(Object.entries(header).filter(([key]) => !(PRICE_FIELDS as readonly string[]).includes(key)));
        if (repricing) {
          priced = await priceFor({
            agentId: stored.agent_id, header: header ?? {}, trips: changes.trips ?? stored.trips.map(pricedTripOf),
            add_ons: changes.add_ons ?? stored.add_ons, adjustments: changes.adjustments ?? stored.adjustments, rate: rateOf(rate, stored), stored,
          });
          header = { ...(header ?? {}), ...priced.header };
          warnings = [...replacedPrices(sent, priced.header), ...priced.quote.warnings];
        } else {
          warnings = replacedPrices(sent, stored as unknown as Record<string, unknown>);
        }
      }
      const attachments = await bookingFiles(body, stored.attachments, actor, changes.upgrades);
      const signed = { ...changes, header: stampActor(header, actor), ...(attachments ? { attachments } : {}) };
      let amended = (await store.amendBooking(bookingId(request), signed, actor)) ?? notFound('Booking not found');
      // A trip whose pickup zone changed leaves its van group, which holds one zone.
      const rezoned = rezonedParts(stored, amended);
      for (const [tripId, parts] of rezoned) await store.setVanParts(tripId, parts);
      if (rezoned.size) amended = (await store.booking(amended.id))!;
      if (await syncAltParts(amended)) amended = (await store.booking(amended.id))!;
      if (!priced) return warnings.length ? { ...amended, price_warnings: warnings } : amended;
      await store.setPrices(amended.id, { trips: priced.quote.trips, add_ons: priced.quote.add_ons.map((a) => a.amount) });
      const booking = (await store.booking(amended.id))!;
      return warnings.length ? { ...booking, price_warnings: warnings } : booking;
    });
  }
  for (const command of STATUS_COMMANDS.filter((c) => c !== 'cancel-weather')) {
    app.post(`/v1/bookings/:id/${command}`, { schema: docs.statusCommand(command) }, async (request) => {
      const body = parseStatusCommandRequest(withoutVersion(request.body));
      const changed = await store.transaction(async () => {
        await assertBookingFresh(request);
        if (command === 'approve' || command === 'reject') await assertMayDecideOn(request, bookingId(request));
        return (await store.changeBookingStatus(bookingId(request), command, body, actorOf(request.user))) ?? notFound('Booking not found');
      });
      // `warnings` is the days an approval puts past the boats' registered seats; empty otherwise.
      return { ...changed.booking, warnings: changed.warnings };
    });
  }
  /**
   * A weather cancel (legacy `bkV2WeatherResolveOne`'s refund, credit and cancel). The money first, as
   * a plan: only this booking's share comes off its invoice, and what it had paid beyond what the
   * invoice still asks is refunded or kept as credit (`refunds.ts`). Then the status, then the writes,
   * and the booking's open weather follow-ups are resolved with the outcome (`weather.ts`).
   */
  app.post('/v1/bookings/:id/cancel-weather', { schema: docs.statusCommand('cancel-weather') }, async (request) => {
    const body = parseWeatherCancel(withoutVersion(request.body));
    const by = actorOf(request.user);
    const done = await store.transaction(async () => {
      await assertBookingFresh(request);
      const before = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
      assertOpen(before.status, 'cancel');
      const invoices = await store.invoicesOfBookings([before.id]);
      const payments = await store.paymentsOf(invoices.map((i) => i.id));
      const refunds = await store.listRefunds({ invoiceIds: invoices.map((i) => i.id) });
      const money = weatherMoney({ booking_id: before.id, outcome: body.outcome, invoices, payments, refunds, now: new Date().toISOString(), by: by ?? null, newId: () => `rf_${randomUUID()}` });
      const changed = (await store.changeBookingStatus(before.id, 'cancel-weather', { ...(body.note ? { note: body.note } : {}), weather: { outcome: body.outcome, amount: money.amount } }, by))
        ?? notFound('Booking not found');
      for (const invoice of money.invoices) await store.putInvoice(invoice);
      for (const refund of money.refunds) await store.putRefund(refund);
      await resolveWeather(before, changed.booking, body.outcome, null, true, by ?? null);
      return { booking: (await store.booking(before.id))!, refunds: money.refunds };
    });
    return { ...done.booking, warnings: [], refunds: done.refunds };
  });
  /**
   * The weather follow-ups a booking command resolved (decision 5): the open closures the booking left,
   * and for a weather cancel its other open rows too. Written in the command's own transaction.
   */
  async function resolveWeather(before: Booking, after: Booking, outcome: CaseOutcome, newDate: string | null, allOpenRows: boolean, by: string | null): Promise<void> {
    const dates = before.trips.map((t) => t.service_date).sort();
    const closures = (dates.length ? await store.listWeatherClosures({ from: dates[0], to: dates[dates.length - 1] }) : [])
      .filter((c) => before.trips.some((t) => t.route_id === c.route_id && t.service_date === c.service_date));
    // A reschedule off no closed trip resolves nothing: no more to read (each read can collide in a serializable transaction).
    if (!closures.length && !allOpenRows) return;
    const rows = await store.weatherCasesOfBooking(before.id);
    for (const row of rows) {
      if (closures.some((c) => c.id === row.closure_id)) continue;
      const closure = await store.weatherClosure(row.closure_id);
      if (closure) closures.push(closure);
    }
    const now = new Date().toISOString();
    for (const row of resolvedRows({ before, after, closures, rows, outcome, new_date: newDate, allOpenRows, now, by })) {
      await store.putWeatherCase(row);
      noteWeatherClosure(row.closure_id);
    }
  }
  app.post('/v1/bookings/:id/cancel', { schema: docs.cancelBooking }, async (request, reply) => {
    const outcome = await holdOnBadInput(request, 'cancel', async () => {
      const cancel = parseCancelRequest(withoutVersion(request.body));
      return store.transaction(async () => {
        await assertBookingFresh(request);
        const done = (await store.cancelBooking(bookingId(request), cancel, actorOf(request.user))) ?? notFound('Booking not found');
        return (await invoicesOnCancel(done, actorOf(request.user) ?? null)) ? (await store.booking(done.id))! : done;
      });
    });
    return 'held' in outcome ? reply.code(202).send(outcome.held) : outcome.done;
  });

  /**
   * Love Kingdom's issues panel (legacy's orange "ใบ B2C ที่ต้องเช็ค" panel, todo/b2c-sync-model.md):
   * every open held order, and what is wrong in the B2C bookings still to travel.
   */
  app.get('/v1/b2c/issues', async () => {
    const held = await store.listHeldOrders({ status: 'open' });
    const issues: PanelIssue[] = [];
    const statuses = BOOKING_STATUSES.filter(holdsSeats);
    let cursor: string | undefined;
    do {
      const page = await store.listBookings({ agentId: B2C_AGENT, from: todayInThailand(), to: '9999-12-31', statuses, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const b of page.bookings) {
        for (const issue of bookingIssues(b)) issues.push({ booking_id: b.id, external_id: b.external_id ?? null, service_date: b.service_date, lead_pax: b.lead_pax ?? null, ...issue });
      }
      cursor = page.next_cursor;
    } while (cursor);
    issues.sort((a, b) => a.service_date.localeCompare(b.service_date) || a.booking_id.localeCompare(b.booking_id));
    const count = (severity: string) => issues.filter((i) => i.severity === severity).length;
    return { held_orders: held, issues, counts: { held: held.length, warn: count('warn'), info: count('info') }, signature: issuesSignature(held, issues) };
  });
  app.get('/v1/b2c/held-orders', async (request) => ({ held_orders: await store.listHeldOrders({ status: parseHeldStatus((request.query as Record<string, unknown>).status) }) }));
  const heldId = (request: { params: unknown }): string => (request.params as { id: string }).id;
  app.get('/v1/b2c/held-orders/:id', async (request) => (await store.heldOrder(heldId(request))) ?? notFound(`Held order ${heldId(request)} not found`));
  /** Ops close a held order: `resolve` (handled; optionally the booking that settled it) or `dismiss` (nothing to do). */
  for (const command of ['resolve', 'dismiss'] as const) {
    app.post(`/v1/b2c/held-orders/:id/${command}`, async (request) => {
      const decision = parseHeldDecision(command, request.body);
      return store.transaction(async () => {
        const held = (await store.heldOrder(heldId(request))) ?? notFound(`Held order ${heldId(request)} not found`);
        const decided = decideHeld(held, decision, actorOf(request.user) ?? null, new Date().toISOString());
        if (decided.resolved_booking_id && !(await store.booking(decided.resolved_booking_id))) badRequest(`booking_id ${decided.resolved_booking_id} is not a booking`);
        await store.putHeldOrder(decided);
        return decided;
      });
    });
  }
  app.post('/v1/bookings/:id/restore', async (request) => {
    const restored = await store.transaction(async () => {
      await assertBookingFresh(request);
      const done = (await store.restoreBooking(bookingId(request), actorOf(request.user))) ?? notFound('Booking not found');
      return (await invoicesOnRestore(done.booking, actorOf(request.user) ?? null)) ? { ...done, booking: (await store.booking(done.booking.id))! } : done;
    });
    return { ...restored.booking, warnings: restored.warnings };
  });
  app.post('/v1/bookings/:id/partial-cancel', async (request) => {
    const partial = parsePartialCancelRequest(withoutVersion(request.body, true));
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const done = (await store.partialCancel(bookingId(request), partial, actorOf(request.user))) ?? notFound('Booking not found');
      return (await syncAltParts(done)) ? (await store.booking(done.id))! : done;
    });
  });
  /**
   * A booking's pickup and drop-off areas must be in the catalogue (`400`). A trip sent with no pickup
   * time gets the area's (`lookupPickupTime`), and one with no zone the area's zone (decision D1: filled
   * only when not sent, never overwritten). `checkPickup` false: the area is the stored one, not re-checked.
   */
  async function fillPickups(pickupId: string | undefined, dropoffId: string | undefined, trips: BookingTripInput[] | undefined, checkPickup = true): Promise<void> {
    if (!pickupId && !dropoffId) return;
    const areas = new Map((await store.listPickupAreas()).map((a) => [a.id, a]));
    for (const [field, id] of [['pickup_area_id', checkPickup ? pickupId : undefined], ['dropoff_area_id', dropoffId]] as const) {
      if (id && !areas.has(id)) badRequest(`${field} ${id} is not a pickup area (GET /v1/pickup-areas)`);
    }
    const area = pickupId ? areas.get(pickupId) : undefined;
    if (!area || !trips?.length) return;
    const [profiles, cells] = [await store.listTimeProfiles(), await store.listPickupTimes()];
    for (const trip of trips) {
      if (!trip.zone) trip.zone = area.zone;
      if (trip.pickup_time || trip.pickup_time_end || trip.pickup_at_pier) continue;
      const found = lookupPickupTime(profiles, cells, area, trip.route_id, trip.service_date);
      if (found) Object.assign(trip, { pickup_time: found.pickup_time, pickup_time_end: found.pickup_time_end, pickup_at_pier: found.pickup_at_pier });
    }
  }

  /**
   * Pickup areas and pickup times (todo/booking-extras-model.md §4; legacy's "Pickup time setup").
   */
  const areaNotFound = (id: string): never => notFound(`Pickup area ${id} not found`);
  /** Legacy `_psuInheritTimesForArea`: an area saved gets its time group's times where it has none. */
  const inherit = async (area: PickupArea) => {
    for (const cell of inheritedCells(area, await store.listPickupAreas(), await store.listPickupTimes())) await store.putPickupTime(cell);
  };
  app.get('/v1/pickup-areas', async (request) => {
    const active = (request.query as Record<string, unknown>).active;
    const areas = sortAreas(await store.listPickupAreas());
    return { areas: active === 'true' ? areas.filter((a) => a.active) : areas };
  });
  app.post('/v1/pickup-areas', async (request, reply) => {
    const input = parseNewArea(record(request.body));
    return reply.code(201).send(await store.transaction(async () => {
      const area = { id: areaId(input.name, input.zone, new Set((await store.listPickupAreas()).map((a) => a.id))), ...input };
      await store.putPickupArea(area);
      await inherit(area);
      return area;
    }));
  });
  app.patch('/v1/pickup-areas/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    const patch = parseAreaPatch(record(request.body));
    return store.transaction(async () => {
      const area = { ...((await store.listPickupAreas()).find((a) => a.id === id) ?? areaNotFound(id)), ...patch };
      await store.putPickupArea(area);
      await inherit(area);
      return area;
    });
  });
  /** Legacy deletes an area outright; here it becomes inactive, as bookings point at it (decision D2). */
  app.delete('/v1/pickup-areas/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    return store.transaction(async () => {
      const area = { ...((await store.listPickupAreas()).find((a) => a.id === id) ?? areaNotFound(id)), active: false };
      await store.putPickupArea(area);
      return area;
    });
  });
  const profileOf = async (id: string) => (await store.listTimeProfiles()).find((p) => p.id === id) ?? notFound(`Pickup time profile ${id} not found`);
  app.get('/v1/pickup-time-profiles', async () => ({ profiles: await store.listTimeProfiles() }));
  app.get('/v1/pickup-time-profiles/:id', async (request) => {
    const profile = await profileOf((request.params as { id: string }).id);
    return { ...profile, times: await store.listPickupTimes(profile!.id) };
  });
  app.post('/v1/pickup-time-profiles', async (request, reply) => {
    const body = record(request.body);
    const input = parseProfile(body);
    const cloneFrom = typeof body.clone_from === 'string' && body.clone_from ? body.clone_from : null;
    return reply.code(201).send(await store.transaction(async () => {
      const taken = new Set((await store.listTimeProfiles()).map((p) => p.id));
      const base = `prof-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'profile'}`;
      let id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
      if (cloneFrom) await profileOf(cloneFrom);
      const profile = { id, ...input, cloned_from: cloneFrom, created_at: new Date().toISOString() };
      await store.putTimeProfile(profile);
      if (cloneFrom) for (const cell of await store.listPickupTimes(cloneFrom)) await store.putPickupTime({ ...cell, profile_id: id });
      return { ...profile, times: await store.listPickupTimes(id) };
    }));
  });
  app.patch('/v1/pickup-time-profiles/:id', async (request) => {
    const body = record(request.body);
    return store.transaction(async () => {
      const current = await profileOf((request.params as { id: string }).id);
      const profile = { ...current!, ...parseProfile(body, current!) };
      await store.putTimeProfile(profile);
      return profile;
    });
  });
  app.delete('/v1/pickup-time-profiles/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!(await store.transaction(async () => store.deleteTimeProfile(id)))) notFound(`Pickup time profile ${id} not found`);
    return reply.code(204).send();
  });
  /** One cell: a route and an area id, or a time group (as legacy's older table keys them). */
  app.put('/v1/pickup-time-profiles/:id/times/:route_id/:target', async (request) => {
    const { id, route_id: routeId, target } = request.params as { id: string; route_id: string; target: string };
    const window = parseCell(record(request.body));
    return store.transaction(async () => {
      await profileOf(id);
      if (!(await store.listRoutes()).some((r) => r.id === routeId)) badRequest(`route ${routeId} does not exist`);
      const areas = await store.listPickupAreas();
      if (!areas.some((a) => a.id === target || a.time_group === target)) badRequest(`${target} is not a pickup area or time group`);
      const cell = { profile_id: id, route_id: routeId, target, ...window };
      await store.putPickupTime(cell);
      return cell;
    });
  });
  app.delete('/v1/pickup-time-profiles/:id/times/:route_id/:target', async (request, reply) => {
    const { id, route_id: routeId, target } = request.params as { id: string; route_id: string; target: string };
    if (!(await store.transaction(async () => store.deletePickupTime(id, routeId, target)))) notFound('No such pickup time');
    return reply.code(204).send();
  });
  /** Legacy `bkV2GetPickupTime`: what a trip on that route, from that area, on that date is told. */
  app.get('/v1/pickup-time', async (request) => {
    const q = request.query as Record<string, unknown>;
    const [routeId, id, date] = [q.route_id, q.area_id, q.date ?? q.service_date];
    if (typeof routeId !== 'string' || typeof id !== 'string' || typeof date !== 'string' || !isIsoDate(date)) badRequest('route_id, area_id and date (YYYY-MM-DD) are required');
    const area = (await store.listPickupAreas()).find((a) => a.id === id) ?? areaNotFound(id as string);
    return lookupPickupTime(await store.listTimeProfiles(), await store.listPickupTimes(), area!, routeId as string, date as string)
      ?? notFound(`No pickup time for ${id} on route ${routeId} on ${date}`);
  });

  /**
   * The document check (todo/booking-extras-model.md §3; legacy `docCheck*`): six ticks, a verdict, a
   * note, and the browser's OCR pre-check. Each answers the booking.
   */
  const docCheckWrite = (path: string, apply: (current: Booking['doc_check'], body: Record<string, unknown>, ctx: { by: string | null; params: Record<string, string> }) =>
    { record: DocCheck; history?: HistoryLine } | DocCheck) =>
    app.put(`/v1/bookings/:id/doc-check${path}`, async (request) => {
      const body = record(request.body);
      return store.transaction(async () => {
        const booking = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
        const out = apply(booking.doc_check, body, { by: actorOf(request.user) ?? null, params: request.params as Record<string, string> });
        const next = 'record' in out ? out : { record: out };
        await store.setDocCheck(booking.id, next.record);
        if (next.history) await store.addHistory(booking.id, next.history);
        return (await store.booking(booking.id))!;
      });
    });
  docCheckWrite('/items/:item', (current, body, ctx) => withItem(current, parseDocItem(ctx.params.item), body));
  docCheckWrite('/status', (current, body, ctx) => withDocStatus(current, body, new Date().toISOString(), ctx.by));
  docCheckWrite('/note', (current, body) => withNote(current, body));
  docCheckWrite('/pre', (current, body) => withPre(current, body));

  /**
   * The pier's meal editor (legacy `pckMealSave`; todo/booking-extras-model.md §2): changes the meal
   * counts and the allergy text, and the server stamps who changed them at the pier, and when.
   */
  app.put('/v1/bookings/:id/meals', async (request) => {
    const body = record(request.body);
    const meals: Record<string, unknown> = {};
    for (const [key, column] of [['veg', 'special_meals_veg'], ['vegan', 'special_meals_vegan'], ['halal', 'special_meals_halal'], ['allergies', 'special_meals_allergies']] as const) {
      const v = body[key] ?? body[column];
      if (v !== undefined) meals[column] = v;
    }
    if (Object.keys(meals).length === 0) badRequest('Send veg, vegan, halal or allergies');
    const header = bookingChanges(meals).header ?? {};
    const actor = actorOf(request.user);
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const done = (await store.amendBooking(bookingId(request), { header: stampActor(header, actor) }, actor)) ?? notFound('Booking not found');
      await store.stampPierMeals(done.id, new Date().toISOString(), actor ?? null);
      return (await store.booking(done.id))!;
    });
  });

  // ── Invoices and payments (todo/money-model.md slice 1; `invoices.ts`) ──
  const invoiceNotFound = (id: string): never => notFound(`Invoice ${id} not found`);
  /** An invoice with its payments and their slips, as every invoice endpoint answers it. */
  const fullInvoices = async (invoices: readonly StoredInvoice[]) => {
    const payments = await store.paymentsOf(invoices.map((i) => i.id));
    const refunds = await store.listRefunds({ invoiceIds: invoices.map((i) => i.id) });
    const slips = payments.flatMap((p) => p.slips);
    const files = slips.length ? await store.attachmentRefs(slips) : new Map();
    return invoices.map((i) => invoiceView(i, payments.filter((p) => p.invoice_id === i.id), files, refunds.filter((r) => r.invoice_id === i.id)));
  };
  /** What refunds and credits took back from an invoice: no longer counted as paid. */
  const returnedFrom = async (invoiceId: string): Promise<number> => returnedOf(await store.listRefunds({ invoiceIds: [invoiceId] }));
  /** An agent's credit balance (legacy `acctAgentDepositAvail`): its credits less its `credit` payments. */
  const agentCredit = async (agentId: string): Promise<CreditBalance> => {
    const invoices = await store.listInvoices({ agentId });
    return creditBalance(await store.listRefunds({ agentId }), await store.paymentsOf(invoices.map((i) => i.id)));
  };
  const fullInvoice = async (invoice: StoredInvoice) => (await fullInvoices([invoice]))[0];
  /** A login tied to one agent sees that agent's invoices only; another's is not found. */
  const ownInvoice = async (request: { params: unknown; user?: { user?: StoredUser } }): Promise<StoredInvoice> => {
    const id = (request.params as { id: string }).id;
    const invoice = (await store.invoice(id)) ?? invoiceNotFound(id);
    const agent = request.user?.user?.agent_id;
    return agent && invoice.agent_id !== agent ? invoiceNotFound(id) : invoice;
  };
  const nextNumber = async (now: Date): Promise<string> => { const month = invoiceMonth(now); return invoiceNumber(month, await store.nextInvoiceNumber(month)); };
  const newInvoiceId = (): string => `inv_${randomUUID()}`;
  const historyOn = async (invoice: StoredInvoice, line: HistoryLine): Promise<void> => { for (const id of bookingIdsOf(invoice)) await store.addHistory(id, line); };

  /**
   * Cancel's accounting step (legacy `bkV2CancelBooking`): the booking's live invoice is voided, and a
   * charge becomes a fee invoice of its own. True when it wrote anything.
   */
  async function invoicesOnCancel(booking: Booking, by: string | null): Promise<boolean> {
    const now = new Date();
    let wrote = false;
    for (const inv of await store.invoicesOfBookings([booking.id])) {
      if (inv.voided) continue;
      await store.putInvoice(voided(inv, 'cancelled', now.toISOString(), by));
      wrote = true;
    }
    // Legacy bills any agent the booking names; here the agent must be in the catalogue to be invoiced.
    const charge = booking.cancellation?.charge_amount ?? 0;
    if (charge > 0 && booking.agent_id && await store.agent(booking.agent_id)) {
      const label = `Cancellation fee${booking.cancellation_reason ? ` · ${booking.cancellation_reason}` : ''}`;
      const fee = feeInvoice({ id: newInvoiceId(), number: await nextNumber(now), agent_id: booking.agent_id, booking_id: booking.id, fee_type: 'cancellation', label, amount: charge, now: now.toISOString(), by });
      if (fee) { await store.putInvoice(fee); wrote = true; }
    }
    return wrote;
  }
  /**
   * A reschedule charged on the invoice of a booking already invoiced tops up that invoice (legacy
   * `bkV2RescheduleBooking`; decided 2026-10-10, with VAT worked out again). The record just written
   * says what was charged. True when it wrote.
   */
  async function topUpRescheduleFee(booking: Booking, invoice: StoredInvoice | undefined): Promise<boolean> {
    const record = booking.reschedules[booking.reschedules.length - 1];
    if (!invoice || !record || record.collect !== 'invoice' || !(record.charge_amount > 0)) return false;
    await store.putInvoice(withFeeLine(invoice, booking.id, rescheduleFeeLabel(record.from_date, record.to_date, record.reason), record.charge_amount));
    return true;
  }
  /** Restore voids the cancellation's fee invoice (legacy `bkV2RestoreBooking`). */
  async function invoicesOnRestore(booking: Booking, by: string | null): Promise<boolean> {
    let wrote = false;
    for (const inv of await store.invoicesOfBookings([booking.id])) {
      if (inv.voided || inv.fee_type !== 'cancellation') continue;
      await store.putInvoice(voided(inv, 'restored', new Date().toISOString(), by));
      wrote = true;
    }
    return wrote;
  }

  app.get('/v1/invoices', async (request) => {
    const q = parseInvoiceListQuery(request.query as Record<string, unknown>);
    const agent = request.user?.user?.agent_id;
    const views = await fullInvoices(await store.listInvoices({ agentId: agent ?? q.agent_id, bookingId: q.booking_id }));
    return { invoices: views.filter((v) => (!q.status || q.status.includes(v.status)) && (!q.from || bangkokDay(v.issued_at) >= q.from) && (!q.to || bangkokDay(v.issued_at) <= q.to)) };
  });
  app.get('/v1/invoices/:id', async (request) => fullInvoice(await ownInvoice(request)));
  /** Issue (legacy `acctCreateInvoice`): the server works out the lines, VAT, number and due date. */
  app.post('/v1/invoices', async (request, reply) => {
    const input = parseNewInvoice(record(request.body));
    const by = actorOf(request.user) ?? null;
    const issued = await store.transaction(async () => {
      const agent = (await store.agent(input.agent_id)) ?? badRequest(`agent_id ${input.agent_id} is not an agent (GET /v1/agents)`);
      const bookings: Booking[] = [];
      for (const id of input.booking_ids) bookings.push((await store.booking(id)) ?? badRequest(`Booking ${id} not found`));
      const routes = new Map((await store.listRoutes()).map((r) => [r.id, r.name]));
      const now = new Date();
      // Cash on tour already decided as taken off the agent's bill is a minus line (todo/money-model.md slice 4).
      const cot = await store.cotDecisions(bookings.map((b) => b.id));
      const issuable = bookings.map((b) => ({ ...b, cot_deductions: cotDeductions(cot.filter((d) => d.booking_id === b.id)) }));
      const invoice = issueInvoice({ id: newInvoiceId(), number: await nextNumber(now), request: input, agent, lines: invoiceLines(agent.id, issuable, (id) => routes.get(id)), now: now.toISOString(), by });
      await store.putInvoice(invoice);
      await historyOn(invoice, issuedLine(by, invoice));
      return invoice;
    });
    return reply.code(201).send(await fullInvoice(issued));
  });
  /** The document's header text and withholding tax; everything the server works out is refused. */
  app.patch('/v1/invoices/:id', async (request) => {
    const body = record(request.body);
    return store.transaction(async () => {
      const invoice = await ownInvoice(request);
      await store.putInvoice({ ...invoice, ...parseInvoicePatch(body, await fullInvoice(invoice)) });
      return fullInvoice((await store.invoice(invoice.id))!);
    });
  });
  app.put('/v1/invoices/:id/discounts', async (request) => {
    const body = record(request.body);
    return store.transaction(async () => {
      const invoice = await ownInvoice(request);
      await store.putInvoice(withDiscounts(invoice, await store.paymentsOf([invoice.id]), body));
      return fullInvoice((await store.invoice(invoice.id))!);
    });
  });
  app.post('/v1/invoices/:id/void', async (request) => {
    const { reason } = parseVoid(record(request.body ?? {}));
    const by = actorOf(request.user) ?? null;
    return store.transaction(async () => {
      const invoice = voided(await ownInvoice(request), reason, new Date().toISOString(), by);
      await store.putInvoice(invoice);
      await historyOn(invoice, voidedLine(by, invoice, reason));
      return fullInvoice(invoice);
    });
  });
  /** Record a payment (legacy `acctRecordPayment`). Answers the invoice. */
  app.post('/v1/invoices/:id/payments', async (request, reply) => {
    const body = record(request.body);
    const by = actorOf(request.user) ?? null;
    const invoice = await store.transaction(async () => {
      const current = await ownInvoice(request);
      const now = new Date();
      const input = parsePayment(body, now);
      if (input.slips.length) assertKnownFiles(input.slips, new Set((await store.attachmentRefs(input.slips)).keys()), 'slip_ids');
      // Spending credit (legacy "Use deposit"): never more than the agent holds.
      if (input.method === 'credit') assertCreditCovers(current, current.agent_id ? await agentCredit(current.agent_id) : creditBalance([], []), input.amount);
      const { payment, history } = recordPayment(current, await store.paymentsOf([current.id]), input, `pay_${randomUUID()}`, now.toISOString(), by, await returnedFrom(current.id));
      await store.putPayment(payment);
      await historyOn(current, history);
      return current;
    });
    return reply.code(201).send(await fullInvoice(invoice));
  });
  /** Change or delete payments, several at once with one reason (legacy `pfmEditSubmit`). Answers the invoice. */
  app.post('/v1/invoices/:id/payment-corrections', async (request) => {
    const body = record(request.body);
    const by = actorOf(request.user) ?? null;
    return store.transaction(async () => {
      const invoice = await ownInvoice(request);
      const { changed, history } = correctPayments(invoice, await store.paymentsOf([invoice.id]), body, new Date().toISOString(), by, await returnedFrom(invoice.id));
      for (const p of changed) await store.putPayment(p);
      if (history) await historyOn(invoice, history);
      return fullInvoice(invoice);
    });
  });
  /** Payments across invoices, newest last; deleted ones only with `deleted=true`. */
  app.get('/v1/payments', async (request) => {
    const query = request.query as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const day = (v: unknown, name: string) => { const s = str(v); return s === undefined ? undefined : calendarDate(s, name); };
    const from = day(query.from, 'from'), to = day(query.to, 'to');
    const method = str(query.method);
    if (method !== undefined && !(PAYMENT_METHODS as readonly string[]).includes(method)) badRequest(`method must be one of ${PAYMENT_METHODS.join(', ')}`);
    const deleted = query.deleted === 'true';
    const agent = request.user?.user?.agent_id;
    const invoices = new Map((await store.listInvoices({ agentId: agent ?? str(query.agent_id) })).map((i) => [i.id, i]));
    const payments = await store.paymentsOf([...invoices.keys()]);
    const slips = payments.flatMap((p) => p.slips);
    const files = slips.length ? await store.attachmentRefs(slips) : new Map();
    return {
      payments: payments.filter((p) => (deleted || !p.deleted_at) && (!from || p.paid_on >= from) && (!to || p.paid_on <= to) && (!method || p.method === method as PaymentMethod))
        .map((p) => {
          const inv = invoices.get(p.invoice_id)!;
          return { ...p, slips: p.slips.map((id) => files.get(id) ?? { id, name: id, mime: 'application/octet-stream', size: 0 }), invoice_number: inv.number, agent_id: inv.agent_id, booking_ids: bookingIdsOf(inv) };
        }),
    };
  });
  /** Refunds owed to agents and credits kept for them (`refunds.ts`), oldest first. */
  app.get('/v1/refunds', async (request) => {
    const agent = request.user?.user?.agent_id;
    const q = { ...parseRefundListQuery(request.query as Record<string, unknown>), ...(agent ? { agent_id: agent } : {}) };
    const refunds = (await store.listRefunds({ agentId: q.agent_id, bookingId: q.booking_id })).filter((r) => matchesRefundQuery(r, q));
    const numbers = new Map<string, string>();
    for (const id of new Set(refunds.map((r) => r.invoice_id))) numbers.set(id, (await store.invoice(id))?.number ?? id);
    return { refunds: refunds.map((r) => ({ ...r, invoice_number: numbers.get(r.invoice_id)! })) };
  });

  // ── Weather closures (todo/weather-closures-model.md; `weather.ts`) ──
  const closureId = (request: { params: unknown }): string => (request.params as { id: string }).id;
  const closureNotFound = (id: string): never => notFound(`Weather closure ${id} not found`);
  const routeNameOf = async (id: string): Promise<string> => (await store.listRoutes()).find((r) => r.id === id)?.name ?? id;
  /**
   * A closure's follow-up list: the bookings on the trip and every booking with a row. `refundable`
   * (what a weather cancel would give back now) only for a single closure's read.
   */
  const followUpsOf = async (closure: WeatherClosure, withRefundable = false): Promise<FollowUp[]> => {
    const rows = await store.weatherCases(closure.id);
    const bookings = new Map((await store.bookingsOn(closure.service_date, closure.route_id)).map((b) => [b.id, b]));
    for (const row of rows) {
      if (bookings.has(row.booking_id)) continue;
      const b = await store.booking(row.booking_id);
      if (b) bookings.set(b.id, b);
    }
    const list = [...bookings.values()];
    if (!withRefundable) return followUps(closure, list, rows);
    const ids = followUps(closure, list, rows).map((e) => e.booking_id);
    const invoices = await store.invoicesOfBookings(ids);
    const payments = await store.paymentsOf(invoices.map((i) => i.id));
    const refunds = await store.listRefunds({ invoiceIds: invoices.map((i) => i.id) });
    return followUps(closure, list, rows, new Map(ids.map((id) => [id, refundableFor(id, invoices, payments, refunds)])));
  };
  /** A login tied to one agent sees its own bookings on the list only. */
  const closureRead = async (closure: WeatherClosure, withBookings: boolean, agent?: string | null) => {
    const entries = await followUpsOf(closure, withBookings);
    return closureView(closure, agent ? entries.filter((e) => e.agent_id === agent) : entries, withBookings);
  };
  const storedClosure = async (request: { params: unknown }): Promise<WeatherClosure> => (await store.weatherClosure(closureId(request))) ?? closureNotFound(closureId(request));

  app.get('/v1/weather-closures', async (request) => {
    const closures = await store.listWeatherClosures(parseClosureListQuery(request.query as Record<string, unknown>));
    const agent = request.user?.user?.agent_id;
    const out = [];
    for (const closure of closures) out.push(await closureRead(closure, false, agent));
    return { weather_closures: out };
  });
  app.get('/v1/weather-closures/:id', async (request) => closureRead(await storedClosure(request), true, request.user?.user?.agent_id));
  /**
   * Close a trip for weather (legacy `bkV2WeatherMarkConfirm`). Refuses no sale (decision 1); writes
   * legacy's history line on every booking then on the trip. Past dates are allowed (decision 11).
   */
  app.post('/v1/weather-closures', async (request, reply) => {
    const input = parseNewClosure(record(request.body));
    const by = actorOf(request.user) ?? null;
    const created = await store.transaction(async () => {
      const routes = await store.listRoutes();
      // With no catalogue (the in-process store unseeded) there is nothing to check against, as for bookings.
      if (routes.length && !routes.some((r) => r.id === input.route_id)) badRequest(`route_id ${input.route_id} is not a route (GET /v1/routes)`);
      const open = (await store.listWeatherClosures({ route_id: input.route_id, from: input.service_date, to: input.service_date }))[0];
      const closure = planClose(input, open, `wx_${randomUUID()}`, new Date().toISOString(), by);
      await store.putWeatherClosure(closure);
      const name = routes.find((r) => r.id === closure.route_id)?.name ?? closure.route_id;
      for (const entry of await followUpsOf(closure)) await store.addHistory(entry.booking_id, closedLine(by, name, closure.service_date));
      return closure;
    });
    return reply.code(201).send(await closureRead(created, true));
  });
  /** The note (legacy's "Update note"). */
  app.patch('/v1/weather-closures/:id', async (request) => {
    const body = record(request.body);
    const by = actorOf(request.user) ?? null;
    return store.transaction(async () => {
      const closure = await storedClosure(request);
      assertOpenClosure(closure);
      const patch = parseClosurePatch(body, await closureRead(closure, true));
      if (patch.note !== undefined && patch.note !== closure.note) await store.putWeatherClosure({ ...closure, note: patch.note, updated_by: by, updated_at: new Date().toISOString() });
      return closureRead((await store.weatherClosure(closure.id))!, true);
    });
  });
  /** Legacy `bkV2WeatherNotify`: staff told the agent. Nothing is sent. */
  app.post('/v1/weather-closures/:id/bookings/:booking_id/notify', async (request) => {
    const by = actorOf(request.user) ?? null;
    return store.transaction(async () => {
      const closure = await storedClosure(request);
      const row = planNotify(closure, await followUpsOf(closure), (request.params as { booking_id: string }).booking_id, new Date().toISOString(), by);
      await store.putWeatherCase(row);
      await store.addHistory(row.booking_id, notifiedLine(by));
      return closureRead(closure, true);
    });
  });
  /** Legacy `bkV2WeatherUncancel`: re-open the trip; resolved bookings stay as they are (decision 8). */
  app.post('/v1/weather-closures/:id/undo', async (request) => {
    const { undo_anyway } = parseUndo(record(request.body ?? {}));
    const by = actorOf(request.user) ?? null;
    return store.transaction(async () => {
      const closure = await storedClosure(request);
      const plan = planUndo(closure, await followUpsOf(closure), undo_anyway, new Date().toISOString(), by);
      await store.putWeatherClosure(plan.closure);
      const rows = new Set((await store.weatherCases(closure.id)).map((r) => r.booking_id));
      const name = await routeNameOf(closure.route_id);
      for (const id of plan.back) {
        if (rows.has(id)) await store.deleteWeatherCase(closure.id, id);
        await store.addHistory(id, reopenedLine(by, name, closure.service_date));
      }
      return closureRead(plan.closure, true);
    });
  });

  /**
   * Attachments (todo/booking-extras-model.md §1): a file uploaded once, then named by a booking's
   * `attachments` or an upgrade's `slips`. Legacy's JSON upload, its 6 MB limit, JPEG, PNG or PDF.
   */
  app.post('/v1/attachments', { bodyLimit: Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 4096 }, async (request, reply) => {
    const upload = parseUpload(record(request.body));
    const file = { id: newAttachmentId(), name: upload.filename, mime: upload.mime, size: upload.data.length, data: upload.data,
      uploaded_by: actorOf(request.user) ?? null, uploaded_at: new Date().toISOString() };
    await store.transaction(async () => store.putAttachment(file));
    return reply.code(201).send({ id: file.id, name: file.name, mime: file.mime, size: file.size });
  });
  /** Any login may download (decided 2026-10-09); a login tied to an agent, only its own bookings' files. */
  app.get('/v1/attachments/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const file = (await store.attachmentFile(id)) ?? notFound(`Attachment ${id} not found`);
    const agent = request.user?.user?.agent_id;
    if (agent && !(await store.attachmentBookings(id)).some((b) => b.agent_id === agent)) notFound(`Attachment ${id} not found`);
    return reply.header('content-type', file!.mime).header('content-disposition', `inline; filename="${encodeURIComponent(file!.name)}"`).send(file!.data);
  });
  app.delete('/v1/attachments/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    await store.transaction(async () => {
      if (!(await store.attachmentFile(id))) notFound(`Attachment ${id} not found`);
      const users = await store.attachmentBookings(id);
      if (users.length) refuseWith(`Attachment ${id} is still on booking ${users.map((b) => b.id).join(', ')}: take it off first`, 409, 'attachment_in_use');
      const projects = await store.fleetRepo.attachmentProjects(id);
      if (projects.length) refuseWith(`Attachment ${id} is still a document of fleet project ${projects.join(', ')}: take it off first`, 409, 'attachment_in_use');
      await store.deleteAttachment(id);
    });
    return reply.code(204).send();
  });

  /**
   * The change feed (todo/change-feed-model.md): what changed since a version, by asking or by push. Any
   * login may read it. `health` carries what bumps no version (legacy's /api/version): pending migrations.
   */
  const feedHealth = async () => ({ migrations_pending: await store.migrationsPending() });
  app.get('/v1/changes', async (request) => {
    const { since, limit } = parseSince(request.query as Record<string, unknown>);
    const version = await store.latestChangeVersion();
    return since === undefined ? { version, health: await feedHealth() } : { version, changes: await store.changesSince(since, limit), health: await feedHealth() };
  });
  /**
   * Server-sent events: everything after `Last-Event-ID` (sent by a reconnecting client) or `?since=`,
   * else from now; then each change as it commits, and a heartbeat `hb` every 25 s. Clients send the
   * Bearer header with a fetch-based reader (decided 2026-10-09; the browser's EventSource can't).
   */
  app.get('/v1/changes/stream', async (request, reply) => {
    const { since } = parseSince(request.query as Record<string, unknown>);
    const lastId = request.headers['last-event-id'];
    let cursor = lastId !== undefined && /^\d+$/.test(String(lastId)) ? Number(lastId) : since ?? await store.latestChangeVersion();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { ...(reply.getHeaders() as Record<string, string>), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 5000\n\n');
    let sending = false, again = false, open = true;
    const flush = async (): Promise<void> => {
      if (sending) { again = true; return; }
      sending = true;
      try {
        do {
          again = false;
          for (;;) {
            const rows = await store.changesSince(cursor, 500);
            for (const c of rows) { if (open) res.write(`id: ${c.version}\nevent: change\ndata: ${JSON.stringify(c)}\n\n`); cursor = c.version; }
            if (rows.length < 500) break;
          }
        } while (again && open);
      } finally { sending = false; }
    };
    const unsubscribe = await store.subscribeChanges(() => { void flush().catch((error) => request.log.error(error)); });
    await flush();
    const heartbeat = setInterval(() => {
      void (async () => { if (open) res.write(`event: hb\ndata: ${JSON.stringify({ version: await store.latestChangeVersion(), health: await feedHealth() })}\n\n`); })().catch((error) => request.log.error(error));
    }, 25_000);
    request.raw.on('close', () => { open = false; clearInterval(heartbeat); unsubscribe(); });
  });

  /**
   * Reconfirmation (todo/trip-ops-and-vans-model.md, slice B): what the customer said when staff
   * checked their pickup, and whether the agent's list was sent. Each answers the booking.
   */
  app.put('/v1/bookings/:id/reconfirm', async (request) => {
    const { status, via } = parseReconfirmStatus(record(request.body));
    return store.transaction(async () => {
      const booking = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
      const { record: next, history } = withStatus(booking.reconfirm, status, via, new Date().toISOString(), actorOf(request.user) ?? null);
      await store.setReconfirm(booking.id, next);
      await store.addHistory(booking.id, history);
      return (await store.booking(booking.id))!;
    });
  });
  app.delete('/v1/bookings/:id/reconfirm', async (request) => store.transaction(async () => {
    const booking = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
    const all = (request.query as Record<string, unknown>).all;
    if (all !== undefined && all !== 'true' && all !== 'false') badRequest('all must be true or false');
    await store.setReconfirm(booking.id, withoutStatus(booking.reconfirm, all === 'true'));
    return (await store.booking(booking.id))!;
  }));
  /**
   * Route upgrade (todo/trip-ops-and-vans-model.md, slice E; legacy `bkV2UpgApply`): one trip moves to
   * another programme that sails that day, at the price it was booked at. A charge becomes an upgrade
   * sale to collect on tour. Undo moves it back and drops the charge unless it was collected.
   */
  const routeName = async (id: string) => (await store.listRoutes()).find((r) => r.id === id)?.name ?? id;
  /** Legacy's checks on the programme a trip moves to: a boat sails it that day, with seats for everyone. */
  const assertRoomOn = async (routeId: string, date: string, pax: number, verb: string) => {
    const capacity = await store.capacity(routeId, date);
    if (capacity.deployed_capacity === 0 && !capacity.unlimited) refuseWith(`${verb}: ${await routeName(routeId)} has no boat on ${date}`, 409, 'route_not_sailing');
    if (capacity.available_seats !== null && pax > capacity.available_seats) {
      refuseWith(`${verb}: not enough free seats on ${await routeName(routeId)} (${date}). Needs ${pax}, free ${capacity.available_seats}.`, 409, 'not_enough_seats');
    }
  };
  const upgradeTrip = async (request: { params: unknown }, tripId: string) => {
    const booking = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
    const trip = booking.trips.find((t) => t.id === tripId) ?? badRequest(`Trip ${tripId} is not on booking ${booking.id}`);
    return { booking, trip: trip! };
  };
  app.post('/v1/bookings/:id/upgrade', async (request) => {
    const input = parseRouteUpgrade(record(request.body));
    return store.transaction(async () => {
      const { booking, trip } = await upgradeTrip(request, input.trip_id);
      if (trip.booking_mode === 'charter') refuseWith(`No seat trip on ${trip.service_date} for this booking.`, 409, 'charter');
      if (trip.ovn || trip.ovn_leg) refuseWith('Overnight trips cannot be upgraded here. Edit the booking instead.', 409, 'overnight');
      if (Object.keys(trip.lock_draws).length) {
        refuseWith(`This booking draws seats from a seat lock on ${await routeName(trip.route_id)}. Release the lock draw first (edit the booking), then upgrade.`, 409, 'lock_draw');
      }
      if (trip.operations.upgrade) refuseWith(`This trip is already upgraded to ${await routeName(trip.route_id)}: undo that first`, 409, 'already_upgraded');
      if (input.to_route_id === trip.route_id) badRequest('to_route_id is the route the trip is already on');
      await assertRoomOn(input.to_route_id, trip.service_date, trip.pax_total, 'Cannot upgrade');
      const by = actorOf(request.user) ?? null, now = new Date().toISOString();
      const [fromName, toName] = [await routeName(trip.route_id), await routeName(input.to_route_id)];
      const moved = (await store.upgradeRoute(booking.id, trip.id, input.to_route_id, actorOf(request.user), routeUpgradeLine(by, fromName, toName, input.reason, input.charge)))!;
      let upgradeId: string | null = null;
      if (input.charge > 0) {
        upgradeId = `up_${Date.now()}`;
        await store.setUpgrades(booking.id, [...moved.upgrades.map(upgradeStored), routeUpgradeSale(upgradeId, input.charge, toName, input.reason, now)]);
      }
      await store.addTripUpgrade({ booking_trip_id: trip.id, from_route_id: trip.route_id, to_route_id: input.to_route_id, reason: input.reason,
        charge: input.charge, upgrade_id: upgradeId, at: now, by, undone_at: null, undone_by: null });
      await syncAltParts((await store.booking(booking.id))!);
      return (await store.booking(booking.id))!;
    });
  });
  app.post('/v1/bookings/:id/upgrade/undo', async (request) => {
    const body = record(request.body);
    const tripId = typeof body.trip_id === 'string' && body.trip_id ? body.trip_id : badRequest('trip_id is required');
    return store.transaction(async () => {
      const { booking, trip } = await upgradeTrip(request, tripId as string);
      const live = (await store.tripUpgradesOf(trip.id)).filter((u) => u.undone_at === null).sort((a, b) => b.id - a.id)[0]
        ?? refuseWith('This trip has no upgrade to undo', 409, 'not_upgraded');
      await assertRoomOn(live!.from_route_id, trip.service_date, trip.pax_total, 'Cannot undo');
      const by = actorOf(request.user) ?? null;
      const moved = (await store.upgradeRoute(booking.id, trip.id, live!.from_route_id, actorOf(request.user), upgradeUndoneLine(by, await routeName(live!.from_route_id))))!;
      // A charge already collected stays on the booking; one not collected goes with the upgrade.
      const sale = moved.upgrades.find((u) => u.id === live!.upgrade_id);
      if (sale && !sale.collected) await store.setUpgrades(booking.id, moved.upgrades.filter((u) => u.id !== sale.id).map(upgradeStored));
      await store.undoTripUpgrade(live!.id, new Date().toISOString(), by);
      await syncAltParts((await store.booking(booking.id))!);
      return (await store.booking(booking.id))!;
    });
  });
  /**
   * The agent's re-confirm list sent, or the send undone, for the bookings named. Legacy sends an
   * agent's bookings of one day and passes over cancelled ones; so does this, listing them in `skipped`.
   */
  app.post('/v1/reconfirm/sent', async (request) => {
    const { booking_ids, sent } = parseSentRequest(record(request.body));
    return store.transaction(async () => {
      const bookings = [];
      for (const id of booking_ids) bookings.push((await store.booking(id)) ?? badRequest(`Booking ${id} not found`));
      const done: { id: string; reconfirm: Booking['reconfirm'] }[] = [], skipped: { id: string; reason: string }[] = [];
      const now = new Date().toISOString(), by = actorOf(request.user) ?? null;
      for (const booking of bookings) {
        if (sent && (SEAT_RELEASING_STATUSES as readonly string[]).includes(booking.status)) { skipped.push({ id: booking.id, reason: booking.status }); continue; }
        const { record: next, history } = withSent(booking.reconfirm, sent, now, by);
        await store.setReconfirm(booking.id, next);
        if (history) await store.addHistory(booking.id, history);
        done.push({ id: booking.id, reconfirm: (await store.booking(booking.id))!.reconfirm });
      }
      return { bookings: done, skipped };
    });
  });
  app.post('/v1/bookings/:id/reschedule', async (request) => {
    const reschedule = parseRescheduleRequest(withoutVersion(request.body, true));
    return store.transaction(async () => {
      await assertBookingFresh(request);
      const before = (await store.booking(bookingId(request))) ?? notFound('Booking not found');
      const invoice = reschedule.kind === 'record' ? liveBookingInvoiceOf(before.id, await store.invoicesOfBookings([before.id])) : undefined;
      let moved = (await store.rescheduleBooking(before.id, invoice && reschedule.kind === 'record' ? { ...reschedule, invoice_number: invoice.number } : reschedule, actorOf(request.user)))
        ?? notFound('Booking not found');
      if (await topUpRescheduleFee(moved, invoice)) moved = (await store.booking(moved.id))!;
      // Moving a booking off a weather-closed trip resolves its follow-up there (decision 5).
      await resolveWeather(before, moved, 'reschedule', reschedule.kind === 'record' ? reschedule.to_date : reschedule.service_date, false, actorOf(request.user) ?? null);
      return (await syncAltParts(moved)) ? (await store.booking(moved.id))! : moved;
    });
  });
  /** Oldest first. Not part of the booking read, because it only grows. */
  app.get('/v1/bookings/:id/history', async (request) => ({ history: (await store.bookingHistory(bookingId(request))) ?? notFound('Booking not found') }));

  app.get('/v1/manifest', async (request) => {
    const query = request.query as Record<string, unknown>;
    const route_id = string(query.route_id, 'route_id'); const service_date = string(query.date ?? query.service_date, 'date');
    return { ...(await store.allotment(route_id, service_date)), bookings: (await store.listBookings({ routeId: route_id, serviceDate: service_date, limit: 100 })).bookings };
  });
  app.get('/operations/allotment', async (request) => {
    const query = request.query as Record<string, unknown>;
    return await store.allotment(string(query.route_id, 'route_id'), string(query.service_date, 'service_date'), exclusion(query));
  });
  app.get('/operations/deployments', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { deployments: await store.listDeployments(optionalString(query.from), optionalString(query.to), optionalString(query.route_id)) };
  });
  /**
   * Deployment guards (todo/deployment-guards-model.md, decided 2026-10-09): past days only for an admin,
   * a chartered boat stays, and a boat with bookings on it leaves only with `remove_anyway`.
   */
  const removeAnyway = (value: unknown): boolean => {
    if (value === undefined || value === false || value === 'false') return false;
    if (value === true || value === 'true') return true;
    return badRequest('remove_anyway must be true or false');
  };
  const guardDeployment = async (request: { user?: { user?: StoredUser } }, date: string, boatId: string, after: Deployment | undefined, anyway: boolean, deployAnyway = false) => {
    const before = (await store.listDeployments(date, date)).find((d) => d.boat_id === boatId);
    const boat = (await store.listBoats()).find((b) => b.id === boatId);
    const boatRecord = await store.boatRecord(boatId);
    // A retired boat is hidden from legacy's Boat Operation, so it can't be put on a route (catalogue decision 13).
    if (after && boatRecord?.retired) refuseWith(`${boat?.name ?? boatId} is retired: restore it before deploying it`, 409, 'boat_retired');
    const user = request.user?.user;
    const warnings: (ReturnType<typeof checkDeploymentChange>[number] | ReadinessWarning)[] = checkDeploymentChange(before, after, {
      today: todayInThailand(), admin: !user || user.role === 'admin', removeAnyway: anyway, boatName: boat?.name ?? boatId,
      catalogueLicense: boat?.license_pax,
      placedBefore: before ? placedOn(await store.bookingsOn(date, before.route_id), boatId, before.route_id, date) : { bookings: 0, pax: 0, charter: null },
      heldBy: before ? (await store.lockRows({ serviceDate: date, routeId: before.route_id })).find((l) => l.boat_id === boatId && l.status === 'active')?.id ?? null : null,
    });
    // A boat not ready that day (fleet decision 2): legacy's Boat Operation offers only ready boats and its
    // bulk forms skip the rest, so putting one on a route (or another route) needs `deploy_anyway`.
    if (after && boatRecord && (!before || before.route_id !== after.route_id)) {
      const ready = checkBoatReady(boatRecord.name, availability(boatRecord, date, await openWork(store, boatId)), deployAnyway);
      if (ready) warnings.push(ready);
    }
    return { before, warnings };
  };
  app.post('/operations/deployments', async (request, reply) => {
    const body = record(request.body);
    const input = deployment(body);
    const anyway = removeAnyway(body.remove_anyway);
    const deployAnyway = anywayFlag(body.deploy_anyway, 'deploy_anyway');
    return reply.code(201).send(await store.transaction(async () => {
      const { warnings } = await guardDeployment(request, input.service_date, input.boat_id, input, anyway, deployAnyway);
      const saved = await store.createDeployment(input);
      return warnings.length ? { ...saved, warnings } : saved;
    }));
  });
  app.delete('/operations/deployments/:service_date/:boat_id', async (request, reply) => {
    const params = request.params as { service_date: string; boat_id: string };
    const anyway = removeAnyway((request.query as Record<string, unknown>).remove_anyway);
    const warnings = await store.transaction(async () => {
      const { before, warnings } = await guardDeployment(request, params.service_date, params.boat_id, undefined, anyway);
      if (!before || !(await store.deleteDeployment(params.service_date, params.boat_id))) notFound('Deployment not found');
      return warnings;
    });
    return warnings.length ? reply.code(200).send({ warnings }) : reply.code(204).send();
  });

  /**
   * Agents, contracts, salespeople, markets, templates, the add-on catalogue, nationalities and
   * insurance: `sales-editing.ts` (todo/sales-editing-model.md).
   */
  registerSalesRoutes(app, { store, assertBookingFresh, agentCredit });
  registerFleetStockRoutes(app, { store });
  /** Partner van bills, van rates and the money reports: `money-reports.ts` (todo/money-model.md slices 5 and 6). */
  registerMoneyReportRoutes(app, { store });
  /** Fleet maintenance, part A: availability, engines/gearboxes/propellers, incidents, jobs (`fleet.ts`). */
  registerFleetRoutes(app, { store });
  registerMoneyRoutes(app, { store, assertBookingFresh });
  /**
   * A booking's price, computed as legacy computes it (`priceBooking`, README "Quote"). The body
   * is a booking's, plus per trip `ovn_charge` and the charter price fields; `booking_id` makes it an
   * edit of that booking (its old rate kept unless `rate: "agent"`; a B2C booking's stored price is
   * answered as it is). Nothing is saved.
   */
  app.post('/v1/quote', async (request) => {
    const body = record(request.body);
    const editing = optionalString(body.booking_id ?? body.bookingId);
    const stored = editing ? (await store.booking(editing)) ?? notFound('Booking not found') : undefined;
    const caller = request.user?.user;
    if (stored && caller?.agent_id && stored.agent_id !== caller.agent_id) notFound('Booking not found');
    if (stored && isB2C(stored)) return storedQuote(stored);
    const { header, ...input } = bookingInput(body);
    if (caller?.agent_id && input.agent_id !== undefined && input.agent_id !== caller.agent_id) forbidden(`This login quotes for agent ${caller.agent_id} only`);
    const agentId = caller?.agent_id ?? input.agent_id;
    if (agentId && !(await store.agent(agentId))) badRequest(`agent_id ${agentId} is not an agent (GET /v1/agents)`);
    return (await priceFor({ agentId, header: header ?? {}, trips: input.trips, add_ons: input.add_ons ?? [], adjustments: input.adjustments ?? [],
      rateTypeRef: input.rate_type_ref, rate: rateOf(body.rate, stored), stored })).quote;
  });

  /**
   * Prices a booking with `priceBooking`, reading the catalogue it needs: the agent and its seasons,
   * its contracts, the rate types those name, the boats. Answers the quote and what the booking stores
   * from it: the price fields, the price mode, the booking's rate. On an edit (`stored`), a trip that is
   * still the trip it was sold as (by id, else route and day) keeps the rate it was priced at.
   */
  async function priceFor(p: {
    agentId?: string; header: BookingHeaderPatch; trips: readonly BookingTripInput[]; add_ons: readonly BookingAddOnInput[];
    adjustments: readonly BookingAdjustmentInput[]; rateTypeRef?: string | null; rate: 'kept' | 'agent'; stored?: Booking;
  }): Promise<{ quote: Quote; header: BookingHeaderPatch; rateTypeRef: string | null }> {
    const row = p.agentId ? await store.agent(p.agentId) : undefined;
    const agent = row && { id: row.id, code: row.code, rate_type_id: row.rate_type_id, rate_seasons: row.rate_seasons };
    const header = { ...(p.stored ?? {}), ...p.header } as BookingHeaderPatch;
    const mode = enforcedPriceMode(agent, header.staff_purpose ?? undefined, p.header.price_mode ?? (p.stored ? header.price_mode ?? undefined : undefined), header.manual_total ?? undefined);
    // The booking's rate: the agent's when it is made (legacy sets it as the agent is picked), kept on
    // an edit, the agent's current one when an edit asks for today's rate.
    const rateTypeRef = (p.stored && p.rate === 'kept' ? p.stored.rate_type_ref : agent?.rate_type_id) ?? p.rateTypeRef ?? p.stored?.rate_type_ref ?? null;
    const contracts = agent ? await store.listContracts({ agentId: agent.id }) : [];
    const rateTypes = new Map<string, RateType>();
    const keptIds = (p.stored?.trips ?? []).map((t) => t.rate_type_id);
    for (const id of new Set([rateTypeRef, agent?.rate_type_id, ...(agent?.rate_seasons ?? []).map((s) => s.rate_type_id), ...contracts.map((c) => c.rate_type_id), ...keptIds])) {
      if (!id) continue;
      const found = await store.rateType(id);
      if (found) rateTypes.set(id, found);
    }
    const quote = priceBooking({
      agent_id: agent?.id, booking_date: header.booking_date ?? todayInThailand(),
      price_mode: mode.price_mode, manual_total: mode.manual_total, rate_type_ref: rateTypeRef, rate: p.rate,
      trips: p.trips.map((trip) => {
        const same = p.stored?.trips.find((t) => (trip.id ? t.id === trip.id : t.route_id === trip.route_id && t.service_date === trip.service_date));
        return { ...trip, ...(same ? { kept_rate_type_id: same.rate_type_id ?? null } : {}) };
      }),
      add_ons: p.add_ons, adjustments: p.adjustments,
    }, { rateTypes, agent, contracts, boatTypes: new Map((await store.listBoats()).map((b) => [b.id, b.type ?? ''])) });
    return {
      quote, rateTypeRef,
      header: {
        price_mode: quote.price_mode, manual_total: quote.price_mode === 'manual' ? mode.manual_total ?? 0 : null, total: quote.total,
        price_seat: quote.seat, price_addon: quote.add_on, price_foc_discount: quote.foc_discount, price_discount: quote.discount, price_extra: quote.extra,
      } as BookingHeaderPatch,
    };
  }

  /**
   * Dispatch for one departure (todo/trip-ops-and-vans-model.md, slice A1): the boat, or boats it is
   * split across, the final pickup time, `return_same_van` and the pier note. An absent field is
   * unchanged and `null` clears it. Answers the trip with its `operations`.
   */
  app.patch('/operations/trip-ops/:trip_id', async (request) => {
    const tripId = (request.params as { trip_id: string }).trip_id;
    const body = record(request.body);
    const patch = parseDispatchPatch(body);
    const raise = parseRaise(body.raise_capacity);
    const vanParts = body.van_parts === undefined ? undefined : parseVanParts(body.van_parts);
    return store.transaction(async () => {
      const found = (await store.tripForDispatch(tripId)) ?? notFound('Trip not found');
      // Legacy's "ล้างออก" (`ckStrandClear`): a cancelled booking still in a van group prints struck through on
      // the job order until its van parts are cleared, which is the one dispatch change it still takes.
      const clearsOnly = vanParts !== undefined && vanParts.length === 0 && Object.keys(body).every((key) => key === 'van_parts' || key === 'version');
      if ((SEAT_RELEASING_STATUSES as readonly string[]).includes(found.booking.status) && clearsOnly) {
        await store.setVanParts(tripId, []);
        return { trip: (await store.tripForDispatch(tripId))!.trip, warnings: [] };
      }
      if ((SEAT_RELEASING_STATUSES as readonly string[]).includes(found.booking.status)) {
        refuseWith(`Booking ${found.booking.id} is ${found.booking.status}: its dispatch cannot change`, 409, 'cancelled');
      }
      const now = new Date().toISOString(), by = actorOf(request.user) ?? null;
      const next = applyDispatch(found.dispatch, patch, { pax: parsePaxGrid(found.trip.pax), deployedBoats: found.deployedBoats, now, by });
      // Boat assignment rules (todo/boat-assignment-model.md): charter boat, chartered boats, capacity + 2.
      const { route_id: routeId, service_date: date } = found.trip;
      const day = (await store.dayRange([routeId], date, date))[0];
      const others = new Map<string, number>();
      for (const b of await store.bookingsOn(date, routeId)) {
        if ((SEAT_RELEASING_STATUSES as readonly string[]).includes(b.status)) continue;
        for (const t of b.trips) {
          if (t.id === tripId || t.route_id !== routeId || t.service_date !== date) continue;
          for (const [boat, n] of paxByBoat(t.operations, t.pax_total)) others.set(boat, (others.get(boat) ?? 0) + n);
        }
      }
      const user = request.user?.user;
      const raises = checkBoatAssignment({
        patch, next, trip: found.trip, others, raise,
        boats: new Map((day?.boats ?? []).map((b) => [b.boat_id, { ...b, chartered: b.chartered && !(found.trip.booking_mode === 'charter') }])),
        mayRaise: !user || user.role === 'admin' || user.actions.includes('act-capunlock'),
      });
      if (raises.length) {
        const catalogue = new Set((await store.listBoats()).map((b) => b.id));
        for (const r of raises) if (!catalogue.has(r.boat_id)) refuseWith(`Boat ${r.boat_id} is not in the boat catalogue: its capacity for a day can't be raised`, 409, 'boat_not_catalogued');
      }
      for (const r of raises) await store.putBoatCapacityOverride({ ...r, service_date: date, set_by: by, set_at: now });
      await store.setDispatch(tripId, next);
      let warnings: string[] = [];
      if (vanParts) {
        const day = await vanDayOf(found.trip.service_date, found.trip.route_id);
        const result = setTripParts(day.state, tripId, vanParts, next.return_same_van, day.vans);
        await applyVanPlan(result.plan);
        warnings = result.warnings;
      } else if (patch.return_same_van === true) {
        // R11: coming back on the same van drops every part's own return van (legacy left the splits' set).
        const parts = partsFromView(found.trip.operations.van_parts);
        if (parts.some((p) => p.return_van_id)) await store.setVanParts(tripId, partsToStore(parts.map((p) => ({ ...p, return_van_id: null }))));
      }
      return { trip: (await store.tripForDispatch(tripId))!.trip, warnings };
    });
  });

  /**
   * Rebuilds the van parts a booking's alternate pickups call for (`altPartsPlan`), and puts each charter
   * trip on its charter boat (`charterSynced`, legacy `§chOpsSync`); true when it changed anything.
   */
  async function syncAltParts(booking: Booking): Promise<boolean> {
    const plans = altPartsPlan(booking);
    for (const plan of plans) await store.setVanParts(plan.tripId, plan.parts);
    let charters = 0;
    for (const trip of booking.trips) {
      const synced = charterSynced(trip, (await store.tripForDispatch(trip.id))?.dispatch);
      if (synced) { await store.setDispatch(trip.id, synced); charters += 1; }
    }
    return plans.length > 0 || charters > 0;
  }

  /**
   * Check-in (todo/trip-ops-and-vans-model.md, slice C): one record per trip, side (van or pier) and
   * van part, written whole as legacy's `ckWrite` writes it. Answers the trip with its `operations`.
   */
  const checkinTrip = async (request: { params: unknown }) => {
    const params = request.params as { trip_id: string; kind: string; slot: string };
    const target = parseCheckinTarget(params);
    const found = (await store.tripForDispatch(params.trip_id)) ?? notFound('Trip not found');
    const part = found.trip.operations.van_parts.find((p) => p.idx === target.slot)
      ?? badRequest(`slot ${target.slot}: the trip has van parts ${found.trip.operations.van_parts.map((p) => p.idx).join(', ')}`);
    return { ...target, found, booked: part!.ad + part!.chd + part!.inf + part!.foc };
  };
  app.put('/operations/trip-ops/:trip_id/checkins/:kind/:slot', async (request) => {
    const input = parseCheckin(record(request.body));
    return store.transaction(async () => {
      const { kind, slot, found, booked } = await checkinTrip(request);
      const current = found.trip.operations.checkins[kind].find((r) => r.slot === slot);
      const stored = current && (({ no_show: _n, ...rest }) => rest)(current);
      const next = applyCheckin(stored, input, { kind, slot, booked, now: new Date().toISOString(), by: actorOf(request.user) ?? null });
      await store.setCheckin(found.trip.id, next);
      return { trip: (await store.tripForDispatch(found.trip.id))!.trip, warnings: [] };
    });
  });
  app.delete('/operations/trip-ops/:trip_id/checkins/:kind/:slot', async (request) => store.transaction(async () => {
    const { kind, slot, found } = await checkinTrip(request);
    if (!(await store.deleteCheckin(found.trip.id, kind, slot))) notFound(`No ${kind} check-in for slot ${slot}`);
    return { trip: (await store.tripForDispatch(found.trip.id))!.trip, warnings: [] };
  }));

  /**
   * Van groups (todo/trip-ops-and-vans-model.md, slice A2): the passengers who ride one outbound van run
   * together, on one route and day. Every write reads the route's day under its lock, decides in
   * `van-groups.ts`, and writes the plan back. Answers the group as `GET` shows it.
   */
  async function vanDayOf(date: string, routeId: string) {
    await store.lockVanDay(date, routeId);
    const state = await vanDayNow(date, routeId);
    const vans = await store.listVans();
    const onDay = vanMatrix(vans, await store.vanDays(date, date), [date], await matrixContext())
      .map((d) => ({ van: vans.find((v) => v.id === d.van_id)!, usable: d.usable, route_ids: d.route_ids, zone: d.zone_on }));
    return { state, vans: onDay, catalogue: vans };
  }
  async function applyVanPlan(plan: VanPlan): Promise<void> {
    for (const group of plan.groups) await store.writeVanGroup(group);
    for (const [tripId, parts] of plan.parts) await store.setVanParts(tripId, parts);
    for (const [tripId, fields] of plan.dispatch) await store.patchDispatch(tripId, fields);
    for (const id of plan.deleteGroups) await store.deleteVanGroup(id);
  }
  /** One route's day as it reads now. */
  const vanDayNow = async (date: string, routeId: string) =>
    vanDayState(await store.bookingsOn(date, routeId), await store.vanGroupsOn(date, routeId), await store.vanStopsOn(date, routeId), date, routeId);
  /** The group as it reads after a write. */
  async function groupNow(group: VanGroup) {
    const state = await vanDayNow(group.service_date, group.route_id);
    return groupView(state, state.groups.find((g) => g.id === group.id) ?? group, await store.listVans());
  }
  const routeDay = (source: Record<string, unknown>): { date: string; routeId: string } => {
    const date = source.service_date ?? source.date, routeId = source.route_id;
    if (typeof date !== 'string' || !isIsoDate(date)) badRequest('service_date must be YYYY-MM-DD');
    if (typeof routeId !== 'string' || !routeId) badRequest('route_id is required');
    return { date: date as string, routeId: routeId as string };
  };
  /** Runs a command on an existing group's day. */
  const onGroup = <T>(request: { params: unknown }, work: (day: Awaited<ReturnType<typeof vanDayOf>>, group: VanGroup) => Promise<T>) => store.transaction(async () => {
    const id = (request.params as { id: string }).id;
    const found = (await store.vanGroup(id)) ?? notFound(`Van group ${id} not found`);
    return work(await vanDayOf(found.service_date, found.route_id), found);
  });

  app.get('/operations/van-groups', async (request) => {
    const { date, routeId } = routeDay(request.query as Record<string, unknown>);
    return { service_date: date, route_id: routeId, groups: visibleGroups(await vanDayNow(date, routeId), await store.listVans()) };
  });
  app.post('/operations/van-groups', async (request, reply) => {
    const body = record(request.body);
    const { date, routeId } = routeDay(body);
    return reply.code(201).send(await store.transaction(async () => {
      const day = await vanDayOf(date, routeId);
      const { plan, group } = createGroup(day.state, body, day.vans, `vgrp_${randomUUID()}`);
      await applyVanPlan(plan);
      return groupNow(group);
    }));
  });
  app.post('/operations/van-groups/clear', async (request) => {
    const { date, routeId } = routeDay(record(request.body));
    return store.transaction(async () => {
      const day = await vanDayOf(date, routeId);
      await applyVanPlan(clearRouteVans(day.state));
      return { service_date: date, route_id: routeId, groups: visibleGroups(await vanDayNow(date, routeId), day.catalogue) };
    });
  });
  app.post('/operations/van-groups/:id/members', async (request) => {
    const body = record(request.body);
    return onGroup(request, async (day, group) => { await applyVanPlan(addMembers(day.state, group.id, body, day.vans)); return groupNow(group); });
  });
  app.patch('/operations/van-groups/:id', async (request) => {
    const body = record(request.body);
    return onGroup(request, async (day, group) => {
      const plan: VanPlan = { groups: [], deleteGroups: [], parts: new Map(), dispatch: new Map() };
      setGroup(day.state, group.id, body, day.vans, plan);
      await applyVanPlan(plan);
      return groupNow(group);
    });
  });
  app.put('/operations/van-groups/:id/order', async (request) => {
    const body = record(request.body);
    return onGroup(request, async (day, group) => { await applyVanPlan(orderGroup(day.state, group.id, body)); return groupNow(group); });
  });
  app.delete('/operations/van-groups/:id', async (request, reply) => {
    await onGroup(request, async (day, group) => applyVanPlan(disbandGroup(day.state, group.id)));
    return reply.code(204).send();
  });
  /** Legacy's drag on the By-trip tab (`bookingV2GrpOrderSet`): the order of one zone's groups, which the job orders follow too. */
  app.put('/operations/van-groups/order', async (request) => {
    const body = record(request.body);
    const { date, routeId } = routeDay(body);
    return store.transaction(async () => {
      await store.lockVanDay(date, routeId);
      for (const group of orderZoneGroups(await store.vanGroupsOn(date, routeId), body)) await store.writeVanGroup(group);
      return { service_date: date, route_id: routeId, groups: visibleGroups(await vanDayNow(date, routeId), await store.listVans()) };
    });
  });

  /**
   * Van job orders (todo/van-job-orders-model.md): the day's jobs and each one's sheet, built by
   * `van-jobs.ts` from what the day holds; "sent to the driver" per job; the Thai pickup names.
   */
  const vanJobsOn = async (date: string) => vanJobsDay({
    date, bookings: await store.bookingsOnDate(date), groups: await store.vanGroupsOnDate(date), stops: await store.vanStopsOn(date),
    vans: await store.listVans(), vanDays: await store.vanDays(date, date), routes: await store.listRoutes(), areas: await store.listPickupAreas(),
    names: await store.pickupNamesTh(), sends: await store.vanJobSends(date),
  });
  const jobTarget = (request: { params: unknown }) => {
    const { date, key } = request.params as { date: string; key: string };
    return { date: parseJobDate(date), key };
  };
  const sheetOf = async (date: string, key: string) =>
    (await vanJobsOn(date)).sheets.get(key) ?? notFound(`Van job ${key} not found on ${date}: no van carries anyone on it that day`);

  app.get('/operations/van-jobs', async (request) => {
    const query = request.query as Record<string, unknown>;
    const date = parseJobDate(query.date ?? query.service_date);
    const routeId = typeof query.route_id === 'string' && query.route_id ? query.route_id : undefined;
    const { day } = await vanJobsOn(date);
    return routeId ? { ...day, jobs: day.jobs.filter((j) => j.route_id === routeId) } : day;
  });
  app.get('/operations/van-jobs/:date/:key', async (request) => {
    const { date, key } = jobTarget(request);
    const { fingerprint: _f, ...sheet } = await sheetOf(date, key);
    return sheet;
  });
  /** Legacy's "ส่งคนขับแล้ว" tick: sent now, by the login, with the sheet as it is now. Ticking again re-sends. */
  app.put('/operations/van-jobs/:date/:key/sent', async (request) => {
    const { date, key } = jobTarget(request);
    if (isRecord(request.body) && request.body.sent_at !== undefined) badRequest('sent_at is the server\'s: it is the time of this request');
    return store.transaction(async () => {
      const sheet = await sheetOf(date, key);
      await store.putVanJobSend(sendFor(sheet.job, sheet.fingerprint, new Date().toISOString(), actorOf(request.user) ?? null));
      return (await sheetOf(date, key)).job;
    });
  });
  app.delete('/operations/van-jobs/:date/:key/sent', async (request) => {
    const { date, key } = jobTarget(request);
    return store.transaction(async () => {
      const sheet = await sheetOf(date, key);
      await store.deleteVanJobSend(sendFor(sheet.job, sheet.fingerprint, '', null));
      return (await sheetOf(date, key)).job;
    });
  });

  app.get('/operations/pickup-names-th', async () => ({
    names: (await store.pickupNamesTh()).map(({ name, name_th, updated_at, updated_by }) => ({ name, name_th, updated_at, updated_by })),
  }));
  /** Legacy `vanJobsSetPickupTh`: typed once per place, used on every sheet; emptied, it is deleted. */
  app.put('/operations/pickup-names-th', async (request) => {
    const input = parsePickupNameTh(record(request.body));
    return store.transaction(async () => {
      if (input.name_th === null) await store.deletePickupNameTh(input.name_key);
      else await store.putPickupNameTh({ ...input, name_th: input.name_th, updated_at: new Date().toISOString(), updated_by: actorOf(request.user) ?? null });
      return { name: input.name, name_th: input.name_th };
    });
  });

  /**
   * The van fleet and its month matrix (todo/trip-ops-and-vans-model.md slice A3, and
   * todo/van-extras-model.md), legacy's Vans page. Every field is the client's; the server works out
   * each day's status and zone, and writes the van's log in legacy's words.
   */
  const vanId = (request: { params: unknown }): string => (request.params as { id: string }).id;
  const vanNotFound = (id: string): never => notFound(`Van ${id} not found`);
  const rangeId = (request: { params: unknown }, what: string): number => {
    const id = Number((request.params as { range_id: string }).range_id);
    return Number.isInteger(id) && id > 0 ? id : notFound(`${what} not found`);
  };
  const logVan = async (id: string, lines: readonly VanLogLine[], request: { user?: unknown }) => {
    const at = new Date().toISOString(), by = actorOf(request.user as Parameters<typeof actorOf>[0]) ?? null;
    if (lines.length) await store.addVanLog(id, lines.map((line) => ({ ...line, at, by })));
  };
  const matrixContext = async () => ({
    statusRanges: await store.vanStatusRanges(), zoneRanges: await store.vanZoneRanges(),
    routePiers: new Map((await store.listRoutes()).map((route) => [route.id, route.pier])),
  });
  const existingVan = async (request: { params: unknown }) => (await store.van(vanId(request))) ?? vanNotFound(vanId(request));

  app.get('/operations/vans', async () => ({ vans: await store.listVans() }));
  app.get('/operations/vans/:id', async (request) => {
    const van = await existingVan(request);
    return { ...van, status_ranges: await store.vanStatusRanges(van.id), zone_ranges: await store.vanZoneRanges(van.id) };
  });
  app.get('/operations/vans/:id/log', async (request) => {
    const limit = parseLogLimit(request.query as Record<string, unknown>);
    return { log: await store.vanLog((await existingVan(request)).id, limit) };
  });
  app.post('/operations/vans', async (request, reply) => {
    const input = parseNewVan(record(request.body));
    return reply.code(201).send(await store.transaction(async () => {
      const van = await store.createVan(input);
      await logVan(van.id, [createdLine], request);
      return van;
    }));
  });
  app.patch('/operations/vans/:id', async (request) => {
    const patch = parseVanPatch(record(request.body));
    return store.transaction(async () => {
      const before = await existingVan(request);
      const after = (await store.updateVan(before.id, patch))!;
      await logVan(after.id, vanEditLines(before, after), request);
      return after;
    });
  });
  /** Legacy deletes a van outright; here only one nothing uses (decided 2026-10-09). */
  app.delete('/operations/vans/:id', async (request, reply) => {
    await store.transaction(async () => {
      const van = await existingVan(request);
      if (await store.vanInUse(van.id)) {
        refuseWith(`${van.name} is used by van groups or the month matrix: set it inactive instead`, 409, 'van_in_use');
      }
      await store.deleteVan(van.id);
    });
    return reply.code(204).send();
  });

  app.post('/operations/vans/:id/status-ranges', async (request, reply) => {
    const input = parseStatusRange(record(request.body));
    return reply.code(201).send(await store.transaction(async () => {
      const van = await existingVan(request);
      const range = await store.addStatusRange(van.id, input);
      await logVan(van.id, statusRangeLines(range), request);
      return range;
    }));
  });
  app.patch('/operations/vans/:id/status-ranges/:range_id', async (request) => {
    const body = record(request.body);
    return store.transaction(async () => {
      const range = (await store.vanStatusRanges(vanId(request))).find((r) => r.id === rangeId(request, 'Status range')) ?? notFound('Status range not found');
      const next = patchStatusRange(range, body);
      await store.putStatusRange(next);
      await logVan(next.van_id, statusRangeLines(next), request);
      return next;
    });
  });
  app.delete('/operations/vans/:id/status-ranges/:range_id', async (request, reply) => {
    if (!(await store.transaction(async () => store.deleteStatusRange(vanId(request), rangeId(request, 'Status range'))))) notFound('Status range not found');
    return reply.code(204).send();
  });

  app.post('/operations/vans/:id/zone-ranges', async (request, reply) => {
    const input = parseZoneRange(record(request.body));
    return reply.code(201).send(await store.transaction(async () => {
      const van = await existingVan(request);
      const range = await store.addZoneRange(van.id, input);
      await logVan(van.id, zoneRangeLines(range), request);
      return range;
    }));
  });
  app.patch('/operations/vans/:id/zone-ranges/:range_id', async (request) => {
    const body = record(request.body);
    return store.transaction(async () => {
      const range = (await store.vanZoneRanges(vanId(request))).find((r) => r.id === rangeId(request, 'Zone range')) ?? notFound('Zone range not found');
      const next = patchZoneRange(range, body);
      await store.putZoneRange(next);
      await logVan(next.van_id, zoneRangeLines(next), request);
      return next;
    });
  });
  app.delete('/operations/vans/:id/zone-ranges/:range_id', async (request, reply) => {
    await store.transaction(async () => {
      const range = (await store.vanZoneRanges(vanId(request))).find((r) => r.id === rangeId(request, 'Zone range')) ?? notFound('Zone range not found');
      await store.deleteZoneRange(range.van_id, range.id);
      await logVan(range.van_id, [zoneRangeDeletedLine(range)], request);
    });
    return reply.code(204).send();
  });

  /** Every van × every date in the range, with what each day comes to, and the ranges that touch it. */
  app.get('/operations/van-days', async (request) => {
    const { from, to } = parseVanDayRange(request.query as Record<string, unknown>);
    const [vans, days, ctx] = [await store.listVans(), await store.vanDays(from, to), await matrixContext()];
    const touches = (r: { from_date: string | null; to_date: string | null }) => (r.from_date === null || r.from_date <= to) && (r.to_date === null || r.to_date >= from);
    return {
      from, to, vans, days: vanMatrix(vans, days, [...eachDate(from, to)], ctx),
      status_ranges: ctx.statusRanges.filter(touches), zone_ranges: ctx.zoneRanges.filter(touches),
    };
  });
  app.put('/operations/van-days/:service_date/:van_id', async (request) => {
    const { service_date: date, van_id: id } = request.params as { service_date: string; van_id: string };
    if (!isIsoDate(date)) badRequest('service_date must be YYYY-MM-DD');
    const routes = await store.listRoutes();
    const patch = parseVanDayPatch(record(request.body), new Set(routes.map((route) => route.id)));
    return store.transaction(async () => {
      const van = (await store.van(id)) ?? vanNotFound(id);
      const before = (await store.vanDay(id, date)) ?? emptyVanDay(id, date);
      const day = applyVanDayPatch(before, patch);
      await store.setVanDay(day);
      await logVan(id, vanDayLines(before, day, (routeId) => routes.find((r) => r.id === routeId)?.name ?? routeId), request);
      return vanMatrix([van], [day], [date], await matrixContext())[0];
    });
  });

  /**
   * Van stops (todo/van-extras-model.md): a guide riding along, or something to pick up, on a
   * group's van. A ride-along takes seats in its group, checked like every other seat check.
   */
  const stopNotFound = (id: string): never => notFound(`Van stop ${id} not found`);
  const seatsAnyway = (body: Record<string, unknown>): boolean => {
    if (body.seats_anyway !== undefined && typeof body.seats_anyway !== 'boolean') badRequest('seats_anyway must be true or false');
    return body.seats_anyway === true;
  };
  /** The group a stop rides: it must exist and have a van (legacy's button needs one: "เลือกรถก่อน"). */
  const stopGroup = async (groupId: unknown): Promise<VanGroup> => {
    if (typeof groupId !== 'string' || !groupId) badRequest("group_id is required: a stop rides a group's van");
    const group = (await store.vanGroup(groupId as string)) ?? badRequest(`Van group ${groupId} not found`);
    if (!group!.van_id) refuseWith(`Group ${group!.number} has no van yet: choose its van first, a stop rides the group's van`, 409, 'group_has_no_van');
    return group!;
  };
  /** Adds the stop to its group's day and checks the seats, unless legacy's "Add anyway?" was answered. */
  async function checkStopSeats(stop: VanStop, group: VanGroup, anyway: boolean): Promise<void> {
    const day = await vanDayOf(group.service_date, group.route_id);
    day.state.stops = [...day.state.stops.filter((x) => x.id !== stop.id), stop];
    if (!anyway) assertCapacity(day.state, group, day.vans);
  }

  app.get('/operations/van-stops', async (request) => {
    const query = request.query as Record<string, unknown>;
    const date = query.service_date ?? query.date;
    if (typeof date !== 'string' || !isIsoDate(date)) badRequest('service_date must be YYYY-MM-DD');
    const routeId = typeof query.route_id === 'string' && query.route_id ? query.route_id : undefined;
    return { stops: sortStops(await store.vanStopsOn(date as string, routeId)) };
  });
  app.post('/operations/van-stops', async (request, reply) => {
    const body = record(request.body);
    const fields = parseStopFields(body);
    const anyway = seatsAnyway(body);
    return reply.code(201).send(await store.transaction(async () => {
      const group = await stopGroup(body.group_id);
      const stop: VanStop = {
        id: `vs_${randomUUID()}`, service_date: group.service_date, route_id: group.route_id, group_id: group.id, ...fields,
        checked_in: null, created_at: new Date().toISOString(), created_by: actorOf(request.user) ?? null, updated_at: null, updated_by: null,
      };
      if (outboundSeats(stop) > 0) await checkStopSeats(stop, group, anyway);
      await store.writeVanStop(stop);
      return stop;
    }));
  });
  app.patch('/operations/van-stops/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    const body = record(request.body);
    const anyway = seatsAnyway(body);
    return store.transaction(async () => {
      const current = (await store.vanStop(id)) ?? stopNotFound(id);
      const fields = parseStopFields(body, current);
      const group = body.group_id !== undefined ? await stopGroup(body.group_id) : current.group_id ? await store.vanGroup(current.group_id) : undefined;
      const next: VanStop = {
        ...current, ...fields, ...(group ? { group_id: group.id, service_date: group.service_date, route_id: group.route_id } : {}),
        updated_at: new Date().toISOString(), updated_by: actorOf(request.user) ?? null,
      };
      // Seats are checked when the stop takes more of its group's than before: a new group, more people, the outbound leg.
      const before = group && current.group_id === group.id ? outboundSeats(current) : 0;
      if (group && outboundSeats(next) > before) await checkStopSeats(next, group, anyway);
      await store.writeVanStop(next);
      return next;
    });
  });
  app.delete('/operations/van-stops/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!(await store.transaction(async () => store.deleteVanStop(id)))) stopNotFound(id);
    return reply.code(204).send();
  });
  /** Legacy `vsCheck`: checked in now, by the login, with the seats it takes; `DELETE` undoes it. */
  for (const method of ['PUT', 'DELETE'] as const) {
    app.route({
      method, url: '/operations/van-stops/:id/check-in', handler: async (request) => {
        const id = (request.params as { id: string }).id;
        return store.transaction(async () => {
          const stop = (await store.vanStop(id)) ?? stopNotFound(id);
          const next: VanStop = {
            ...stop,
            checked_in: method === 'PUT' ? { at: new Date().toISOString(), by: actorOf(request.user) ?? null, seats: stop.kind === 'staff' ? stop.pax : 0 } : null,
          };
          await store.writeVanStop(next);
          return next;
        });
      },
    });
  }

  /**
   * Rate types: the price lists agents are sold at (`src/domain/rate-types.ts`). Under `booking:*`
   * like agents. Prices are written one route at a time, because a route's block is one fact: the
   * zones, tiers, charter boats and transfers it offers replace what it had, never merge into it.
   */
  const rateTypeId = (request: { params: unknown }): string => (request.params as { id: string }).id;
  const routeParam = (request: { params: unknown }): string => (request.params as { route_id: string }).route_id;
  app.get('/v1/rate-types', async (request) => ({ rate_types: await store.listRateTypes(rateTypeListQuery(request.query as Record<string, unknown>)) }));
  app.get('/v1/rate-types/:id', async (request) => (await store.rateType(rateTypeId(request))) ?? rateTypeNotFound(rateTypeId(request)));
  app.post('/v1/rate-types', async (request, reply) => {
    const input = parseRateTypeCreate(request.body);
    return reply.code(201).send(await store.transaction(() => store.createRateType(input)));
  });
  app.patch('/v1/rate-types/:id', async (request) => {
    const patch = parseRateTypePatch(request.body);
    return store.transaction(async () => (await store.patchRateType(rateTypeId(request), patch)) ?? rateTypeNotFound(rateTypeId(request)));
  });
  app.put('/v1/rate-types/:id/routes/:route_id', async (request) => {
    const block = parseRouteBlock(request.body, '');
    const named = (request.body as Record<string, unknown>).route_id;
    if (named !== undefined && named !== routeParam(request)) badRequest(`route_id ${String(named)} does not match the path's ${routeParam(request)}`);
    return store.transaction(async () => (await store.putRateTypeRoute(rateTypeId(request), routeParam(request), block)) ?? rateTypeNotFound(rateTypeId(request)));
  });
  app.delete('/v1/rate-types/:id/routes/:route_id', async (request, reply) => {
    const removed = await store.transaction(async () => await store.deleteRateTypeRoute(rateTypeId(request), routeParam(request)));
    if (removed === undefined) rateTypeNotFound(rateTypeId(request));
    if (removed === false) notFound(`Route ${routeParam(request)} is not on rate type ${rateTypeId(request)}`);
    return reply.code(204).send();
  });
  app.delete('/v1/rate-types/:id', async (request, reply) => {
    if (!(await store.transaction(async () => await store.deleteRateType(rateTypeId(request))))) rateTypeNotFound(rateTypeId(request));
    return reply.code(204).send();
  });

  /**
   * Agent seat locks (todo/seat-lock-extras-model.md, decided 2026-10-09): day locks, sub-groups,
   * pending seats, expiry and the lock log. The rules are `seat-locks.ts`; the commands
   * `seat-lock-service.ts`. Every write to one lock needs its version from a login, as a booking's.
   */
  const lockNotFound = (): never => notFound('Seat lock not found');
  const groupNotFound = (): never => notFound('Seat lock group not found');
  const by = (request: { user?: unknown }): string | undefined => actorOf(request.user as Parameters<typeof actorOf>[0]);
  const optionalDay = (value: unknown, name: string): string | undefined => (value === undefined || value === '' ? undefined : isoDay(value, name));
  app.get('/v1/seat-locks', { schema: docs.listLocks }, async (request) => {
    const query = request.query as Record<string, unknown>;
    return { seat_locks: await locks.list({
      routeId: optionalString(query.route_id), serviceDate: optionalDay(query.service_date ?? query.date, 'service_date'),
      from: optionalDay(query.from, 'from'), to: optionalDay(query.to, 'to'), groupId: optionalString(query.group_id),
      parentIds: optionalString(query.parent_id) ? [optionalString(query.parent_id)!] : undefined, agentId: optionalString(query.agent_id),
    }) };
  });
  app.post('/v1/seat-locks', { schema: docs.createLock }, async (request, reply) => {
    const input = parseNewLock(request.body);
    return reply.code(201).send(await store.transaction(() => locks.create(input, by(request))));
  });
  /** Legacy `bkV2LockReleaseOverdueGo`: every overdue lock of the day that still holds seats. */
  app.post('/v1/seat-locks/release-overdue', async (request) => {
    const body = record(request.body ?? {});
    const date = isoDay(body.service_date ?? body.date, 'service_date');
    return store.transaction(() => locks.releaseOverdue(date, optionalString(body.route_id), by(request)));
  });
  app.get('/v1/seat-locks/:id', async (request) => (await locks.lock(lockId(request))) ?? lockNotFound());
  app.get('/v1/seat-locks/:id/log', async (request) => ({ events: (await locks.log(lockId(request))) ?? lockNotFound() }));
  /** Client facts only; a server-owned field with a new value is `400 server_owned`, naming the command. */
  app.patch('/v1/seat-locks/:id', async (request) => {
    const changes = parseLockChanges(withoutVersion(request.body));
    return store.transaction(async () => {
      await assertLockFresh(request);
      const current = (await locks.lock(lockId(request))) ?? lockNotFound();
      assertOwnedEcho(request.body, current);
      return (await locks.amend(lockId(request), changes, by(request))) ?? lockNotFound();
    });
  });
  /** Legacy "+ seats". */
  app.post('/v1/seat-locks/:id/add', async (request) => {
    const input = parseAdd(withoutVersion(request.body));
    return store.transaction(async () => { await assertLockFresh(request); return (await locks.add(lockId(request), input, by(request))) ?? lockNotFound(); });
  });
  app.post('/v1/seat-locks/:id/release', { schema: docs.releaseLock }, async (request) => {
    const seats = parseRelease(withoutVersion(request.body));
    return store.transaction(async () => { await assertLockFresh(request); return (await locks.release(lockId(request), seats, by(request))) ?? lockNotFound(); });
  });
  app.post('/v1/seat-locks/:id/release-departure', async (request) => store.transaction(async () => {
    await assertLockFresh(request);
    return (await locks.releaseDeparture(lockId(request), by(request))) ?? lockNotFound();
  }));
  app.post('/v1/seat-locks/:id/confirm-pending', async (request) => {
    const want = parseConfirm(withoutVersion(request.body));
    return store.transaction(async () => { await assertLockFresh(request); return (await locks.confirmPending(lockId(request), want, by(request))) ?? lockNotFound(); });
  });
  app.post('/v1/seat-locks/:id/sub-groups', async (request, reply) => {
    const input = parseSubGroup(withoutVersion(request.body));
    return reply.code(201).send(await store.transaction(async () => {
      await assertLockFresh(request);
      return (await locks.createSubGroup(lockId(request), input, by(request))) ?? lockNotFound();
    }));
  });

  /** Bulk locks: a group plus one lock per departure the route runs (legacy `scope: 'bulk'`). */
  app.get('/v1/seat-lock-groups', async (request) => {
    const query = request.query as Record<string, unknown>;
    return { seat_lock_groups: await locks.groups({ routeId: optionalString(query.route_id), agentId: optionalString(query.agent_id) }) };
  });
  app.get('/v1/seat-lock-groups/:id', async (request) => (await locks.group(lockId(request))) ?? groupNotFound());
  app.get('/v1/seat-lock-groups/:id/log', async (request) => ({ events: (await locks.groupLog(lockId(request))) ?? groupNotFound() }));
  app.post('/v1/seat-lock-groups', async (request, reply) => {
    const input = parseNewGroup(request.body);
    return reply.code(201).send(await store.transaction(() => locks.createGroup(input, by(request))));
  });
  app.patch('/v1/seat-lock-groups/:id', async (request) => {
    const changes = parseGroupChanges(withoutVersion(request.body));
    return store.transaction(async () => {
      await assertGroupFresh(request);
      const current = (await locks.group(lockId(request))) ?? groupNotFound();
      assertGroupOwnedEcho(request.body, current);
      return (await locks.amendGroup(lockId(request), changes, by(request))) ?? groupNotFound();
    });
  });
  app.post('/v1/seat-lock-groups/:id/add', async (request) => {
    const input = parseAdd(withoutVersion(request.body));
    return store.transaction(async () => { await assertGroupFresh(request); return (await locks.addGroup(lockId(request), input, by(request))) ?? groupNotFound(); });
  });
  app.post('/v1/seat-lock-groups/:id/release', async (request) => {
    const seats = parseRelease(withoutVersion(request.body));
    return store.transaction(async () => { await assertGroupFresh(request); return (await locks.releaseGroup(lockId(request), seats, by(request))) ?? groupNotFound(); });
  });
  app.post('/v1/seat-lock-groups/:id/sub-groups', async (request, reply) => {
    const input = parseSubGroup(withoutVersion(request.body));
    return reply.code(201).send(await store.transaction(async () => {
      await assertGroupFresh(request);
      return (await locks.groupSubGroups(lockId(request), input, by(request))) ?? groupNotFound();
    }));
  });
  done();
}
