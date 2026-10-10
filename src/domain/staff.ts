/**
 * Staff and their welfare quotas (todo/sales-editing-model.md, "Design — extras"): legacy's staff
 * registry (`SB_STAFF`, `staffAdd`, `staffSetField`, `staffSetQuota`, `staffDelete`), what it reads
 * (`staffWelfareUsed`, `staffTripsFor`, `renderStaff`) and the booking form's guard (`bkV2Save`), in
 * allotment_v2/js/08-app.js. A staff booking's price is `priceBooking`'s and does not change here.
 * Pure, so both stores decide alike.
 */
import { refuse } from './booking-actions.js';
import { SEAT_RELEASING_STATUSES } from './booking-status.js';
import { assertKnownKeys } from './server-owned.js';
import type { Booking } from './operations.js';

const bad = (message: string): never => refuse(message, 400);

/** A staff member: `quotas` is free welfare seats by year, `{"2026": 3}`. */
export type StaffMember = { id: string; code: string | null; name: string; dept: string | null; active: boolean; quotas: Record<string, number>; created_at: string; updated_at: string };

/** Legacy `staffAdd` gives a new member three free seats for the year on screen. */
export const DEFAULT_FREE_SEATS = 3;
const FIELDS = ['code', 'name', 'dept', 'active'] as const;

export const parseYear = (value: unknown, name = 'year'): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : bad(`${name} must be a year, 2000 to 2100`);
};
const text = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  return typeof value === 'string' ? value.trim() || null : bad(`${name} must be text`);
};
function parseFields(body: Record<string, unknown>): Partial<Pick<StaffMember, 'code' | 'name' | 'dept' | 'active'>> {
  const f: Partial<Pick<StaffMember, 'code' | 'name' | 'dept' | 'active'>> = {};
  if (body.code !== undefined) f.code = text(body.code, 'code');
  // Legacy adds a blank row and names it in place, so a name may be empty.
  if (body.name !== undefined) f.name = text(body.name, 'name') ?? '';
  if (body.dept !== undefined) f.dept = text(body.dept, 'dept');
  if (body.active !== undefined) f.active = typeof body.active === 'boolean' ? body.active : bad('active must be true or false');
  return f;
}

/** Legacy `staffAdd`: id `st<n+1>` and code `EMP-<n+1>` from the highest number in use, a quota for this year. */
export function planStaffCreate(body: Record<string, unknown>, staff: readonly StaffMember[], year: number, now: string): StaffMember {
  assertKnownKeys(body, [...FIELDS], 'A staff member');
  const max = Math.max(0, ...staff.map((s) => parseInt(s.id.replace(/^st/, ''), 10) || 0));
  const f = parseFields(body);
  return {
    id: `st${String(max + 1).padStart(2, '0')}`, code: f.code === undefined ? `EMP-${String(max + 1).padStart(3, '0')}` : f.code,
    name: f.name ?? '', dept: f.dept ?? null, active: f.active ?? true, quotas: { [String(year)]: DEFAULT_FREE_SEATS }, created_at: now, updated_at: now,
  };
}

/** What a `PATCH` may echo but not change, and where to change it instead. */
export const STAFF_SERVER_OWNED: Record<string, string> = {
  id: 'the server makes it', quotas: 'PUT /v1/staff/{id}/quotas/{year}', quota: 'PUT /v1/staff/{id}/quotas/{year}',
  used: 'the server counts it from bookings', remaining: 'the server counts it from bookings', created_at: 'the server sets it', updated_at: 'the server sets it',
};
/** Legacy `staffSetField`, on a body already rid of server-owned fields (`withoutServerOwned`). */
export function planStaffPatch(stored: StaffMember, body: Record<string, unknown>, now: string): StaffMember {
  assertKnownKeys(body, [...FIELDS], 'A staff member');
  const f = parseFields(body);
  const next = { ...stored, ...f };
  return JSON.stringify(next) === JSON.stringify(stored) ? stored : { ...next, updated_at: now };
}

/** Legacy `staffSetQuota`: a whole number of free seats, 0 or more (a 0 is kept: no free seats that year). */
export function parseQuota(body: Record<string, unknown>): number {
  assertKnownKeys(body, ['free_seats'], 'A quota');
  return Number.isInteger(body.free_seats) && (body.free_seats as number) >= 0 ? body.free_seats as number : bad('free_seats must be a whole number, 0 or more');
}

/** The member with a year's quota set, years in order (as both stores answer them). */
export const withQuota = (member: StaffMember, year: number, freeSeats: number, now: string): StaffMember => ({
  ...member, updated_at: now,
  quotas: Object.fromEntries(Object.entries({ ...member.quotas, [String(year)]: freeSeats }).sort(([a], [b]) => (a < b ? -1 : 1))),
});

/** Legacy's delete asked "Delete staff?"; here a member bookings name stays, inactive instead. */
export function assertStaffDeletable(member: StaffMember, bookings: number): void {
  if (bookings > 0) refuse(`${member.name || member.code || member.id} is named on ${bookings} booking${bookings === 1 ? '' : 's'}: make them inactive instead`, 409, 'in_use');
}

/** Legacy `isStaff`: the house account staff bookings are made on. */
export const isStaffAgent = (agent: { id: string; code: string | null } | undefined): boolean => !!agent && (agent.code === 'STAFF' || agent.id === 'a_staff');

/** The reasons legacy's company booking form offers (`companyPurpose`): company guest, PR / influencer, special price. */
export const COMPANY_PURPOSES = ['company_guest', 'pr_foc', 'company_special'] as const;
const isCompanyAgent = (agent: { id: string; code: string | null } | undefined): boolean => !!agent && (agent.code === 'COMPANY' || agent.id === 'a_company');

/**
 * Legacy `bkV2Save`'s company guard (decided 2026-10-10): a booking on the company account says why it
 * was made, one of `COMPANY_PURPOSES` ("Please choose a reason for this company booking"), on every
 * save. `company_purpose` is a client fact; a value that is not one of the three is `400` too.
 */
export function checkCompanyPurpose(agent: { id: string; code: string | null } | undefined, purpose: string | null | undefined): void {
  if (purpose !== undefined && purpose !== null && !(COMPANY_PURPOSES as readonly string[]).includes(purpose)) bad(`company_purpose must be one of ${COMPANY_PURPOSES.join(', ')}`);
  if (isCompanyAgent(agent) && !purpose) bad(`company_purpose is required: choose a reason for this company booking (${COMPANY_PURPOSES.join(', ')})`);
}
const isInspection = (b: { staff_purpose?: string | null; purpose?: string | null }) => b.staff_purpose === 'inspection' || b.purpose === 'staff_inspection';
const holds = (b: Booking) => !(SEAT_RELEASING_STATUSES as readonly string[]).includes(b.status);
const focOf = (pax: Record<string, number>): number => (pax.foc ?? 0) + (pax.foc_fr ?? 0) + (pax.foc_th ?? 0);
const headsOf = (pax: Record<string, number>): number => Object.values(pax).reduce((s, n) => s + n, 0);

/** Legacy `staffWelfareUsed`: FOC seats on the member's trips that year, not cancelled, not an inspection. */
export function welfareUsed(staffId: string, year: number, bookings: readonly Booking[]): number {
  let n = 0;
  for (const b of bookings) {
    if (b.staff_id !== staffId || isInspection(b) || !holds(b)) continue;
    for (const t of b.trips) if (t.service_date.slice(0, 4) === String(year)) n += focOf(t.pax);
  }
  return n;
}

/** Legacy's roster (`renderStaff`): each member's quota, used and remaining for the year, and the totals. */
export function staffRoster(staff: readonly StaffMember[], year: number, bookings: readonly Booking[]) {
  const rows = [...staff].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => {
    const quota = s.quotas[String(year)] ?? 0, used = welfareUsed(s.id, year, bookings);
    return { ...s, quota, used, remaining: quota - used };
  });
  return {
    year, staff: rows,
    totals: { active: staff.filter((s) => s.active).length, all: staff.length, quota: rows.reduce((n, r) => n + r.quota, 0), used: rows.reduce((n, r) => n + r.used, 0) },
  };
}

/** Legacy `staffTripsFor`: staff bookings' trips that year, welfare or inspection, by date. */
export function staffTrips(year: number, bookings: readonly Booking[]) {
  return bookings
    .filter((b) => (b.staff_id || b.purpose === 'staff_welfare' || b.purpose === 'staff_inspection') && holds(b))
    .flatMap((b) => b.trips.filter((t) => t.service_date.slice(0, 4) === String(year)).map((t) => {
      const foc = focOf(t.pax), head = headsOf(t.pax);
      return { booking_id: b.id, staff_id: b.staff_id ?? null, service_date: t.service_date, route_id: t.route_id, purpose: isInspection(b) ? 'inspection' : 'welfare', foc, head, paid: Math.max(0, head - foc) };
    }))
    .sort((a, b) => (a.service_date < b.service_date ? -1 : a.service_date > b.service_date ? 1 : a.booking_id < b.booking_id ? -1 : 1));
}

/**
 * Legacy `bkV2Save`'s staff guard. A booking on the staff account names a staff member; a staff id
 * sent must be one; a welfare booking's free seats in a year must fit what that year has left (the
 * booking itself left out), else `409 over_quota` until `quota_anyway`. `others` are the bookings that
 * name staff, this one included or not.
 */
export function checkStaffBooking(input: {
  bookingId?: string; staffAgent: boolean; staffId: string | null; staffIdSent: boolean; staffPurpose: string | null; purpose: string | null;
  trips: readonly { service_date: string; foc: number }[];
}, member: StaffMember | undefined, others: readonly Booking[], quotaAnyway: boolean): void {
  if (input.staffAgent && !input.staffId) bad('staff_id is required: a staff booking names the staff member (GET /v1/staff)');
  if (input.staffIdSent && input.staffId && !member) bad(`staff_id ${input.staffId} is not a staff member (GET /v1/staff)`);
  if (!input.staffAgent || !member || isInspection({ staff_purpose: input.staffPurpose, purpose: input.purpose }) || quotaAnyway) return;
  const requested = new Map<string, number>();
  for (const t of input.trips) { const y = t.service_date.slice(0, 4); if (y) requested.set(y, (requested.get(y) ?? 0) + t.foc); }
  const rest = others.filter((b) => b.id !== input.bookingId);
  const over: string[] = [];
  for (const [year, req] of [...requested].sort()) {
    const left = (member.quotas[year] ?? 0) - welfareUsed(member.id, Number(year), rest);
    if (req > left) over.push(`${year}: ${left} free seat${left === 1 ? '' : 's'} left, ${req} requested, over by ${req - left}`);
  }
  if (over.length) {
    refuse(`Free welfare seats exceed the quota: ${over.join('; ')}. The over-quota people should be Adult (charged at the staff rate), not FOC. Send quota_anyway: true to save anyway.`, 409, 'over_quota');
  }
}
