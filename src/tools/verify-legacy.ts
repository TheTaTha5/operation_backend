/**
 * The comparisons `verify-import.ts` makes between legacy's database and this one. Pure, so
 * `test/verify-legacy.test.ts` checks them without a database.
 *
 * Written apart from the importer on purpose: nothing here imports `import-legacy.ts` or its mapping
 * modules. What both share is the contract (which legacy column becomes which column here, written
 * out again below), not the code, so a bug in the importer's mapping shows up as a difference rather
 * than being reproduced on both sides of the comparison.
 */

export type Row = Record<string, unknown>;

/** How two values are compared. Blank, null and missing are all "no value" for every kind. */
export type Kind = 'text' | 'number' | 'bool' | 'day' | 'instant';

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** A value in the one form both sides are compared in; undefined for "no value". */
export function normal(v: unknown, kind: Kind): string | number | boolean | undefined {
  if (blank(v)) return undefined;
  switch (kind) {
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : String(v).trim(); }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      return s === 'true' || s === 't' || s === '1' ? true : s === 'false' || s === 'f' || s === '0' ? false : s;
    }
    case 'day': {
      // A pg `date` arrives as a Date at local midnight; legacy keeps text, sometimes a full timestamp.
      if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
      return String(v).trim().slice(0, 10);
    }
    case 'instant': {
      const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
      return Number.isNaN(t) ? String(v).trim() : new Date(t).toISOString();
    }
    default: return String(v).trim();
  }
}

/** True when the two values mean the same. A boolean false and no value are the same (legacy writes either). */
export function same(a: unknown, b: unknown, kind: Kind): boolean {
  const x = normal(a, kind), y = normal(b, kind);
  if (kind === 'bool') return (x ?? false) === (y ?? false);
  if (kind === 'number' && typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 0.005;
  return x === y;
}

/**
 * Booking header: column here ← legacy column(s), and how they compare. Where legacy has two columns
 * for one value (a newer and an older place it was written), the first one that is set is legacy's
 * value. `status` is compared separately, since it decides which rows are expected at all.
 */
export const BOOKING_HEADER: readonly (readonly [string, readonly string[], Kind])[] = [
  ['agent_id', ['agentid'], 'text'], ['voucher_ref', ['voucherref'], 'text'], ['rate_type_ref', ['ratetyperef'], 'text'],
  ['schema_ver', ['schemaver'], 'number'], ['sold_by', ['soldby'], 'text'], ['purpose', ['purpose'], 'text'],
  ['staff_id', ['staffid'], 'text'], ['staff_purpose', ['staffpurpose'], 'text'],
  ['lead_pax', ['leadpax'], 'text'], ['lead_nationality', ['leadnationality'], 'text'], ['lead_type', ['leadtype'], 'text'],
  ['lead_foc', ['leadfoc'], 'bool'], ['lead_phone', ['leadphone'], 'text'], ['lead_email', ['leademail'], 'text'],
  ['pickup_area_id', ['pickupareaid'], 'text'], ['pickup_self', ['pickupself'], 'bool'], ['pickup_area', ['pickuparea'], 'text'],
  ['pickup_zone', ['pickupzone'], 'text'], ['hotel_name', ['hotelname'], 'text'], ['room_number', ['roomnumber'], 'text'],
  ['dropoff_same', ['dropoffsame'], 'bool'], ['dropoff_area_id', ['dropoffareaid'], 'text'], ['dropoff_area', ['dropoffarea'], 'text'],
  ['dropoff_hotel_name', ['dropoffhotelname'], 'text'],
  ['guide_english', ['guides_english'], 'bool'], ['guide_russian', ['guides_russian'], 'bool'], ['guide_chinese', ['guides_chinese'], 'bool'],
  ['guide_other_lang', ['guides_otherlang'], 'text'],
  ['special_meals_veg', ['specialmeals_veg'], 'number'], ['special_meals_vegan', ['specialmeals_vegan'], 'number'],
  ['special_meals_halal', ['specialmeals_halal'], 'number'], ['special_meals_allergies', ['specialmeals_allergies'], 'text'],
  ['large_luggage', ['largeluggage'], 'number'],
  ['cash_on_tour_amount', ['cashontour_amount'], 'number'], ['cash_on_tour_currency', ['cashontour_currency'], 'text'],
  ['cash_on_tour_handling', ['cashontour_handling'], 'text'], ['cash_on_tour_note', ['cashontour_note'], 'text'],
  ['price_mode', ['pricemode'], 'text'], ['manual_total', ['manualtotal'], 'number'], ['total', ['total'], 'number'],
  ['price_seat', ['pricebreakdown_seat'], 'number'], ['price_addon', ['pricebreakdown_addon'], 'number'],
  ['price_foc_discount', ['pricebreakdown_focdiscount'], 'number'], ['price_discount', ['pricebreakdown_discount'], 'number'],
  ['price_extra', ['pricebreakdown_extra'], 'number'],
  ['payment_method', ['paymentsnapshot_method'], 'text'], ['payment_net_days', ['paymentsnapshot_netdays'], 'number'],
  ['payment_source', ['paymentsnapshot_source'], 'text'], ['payment_contract_version', ['paymentsnapshot_contractversion'], 'text'],
  ['market', ['marketsnapshot_market'], 'text'], ['market_sub', ['marketsnapshot_sub'], 'text'],
  ['market_agent_id', ['marketsnapshot_agentid'], 'text'], ['market_at', ['marketsnapshot_at'], 'day'],
  ['booking_date', ['bookingdate'], 'day'], ['booked_at', ['bookedat'], 'instant'], ['created_by', ['createdby'], 'text'],
  ['updated_by', ['updatedby'], 'text'], ['confirmed_at', ['confirmedat'], 'instant'], ['confirmed_by', ['confirmedby'], 'text'],
  ['notes', ['notes'], 'text'], ['note', ['note'], 'text'],
  ['foc_reason', ['focreason', 'focapproval_reason'], 'text'],
  ['cancellation_reason', ['cancellation_reason', 'cancelreason'], 'text'],
];

/** Legacy's value for a header field: the first of its columns that holds one. */
export const legacyValue = (row: Row, columns: readonly string[]): unknown => columns.map((c) => row[c]).find((v) => !blank(v));

/** The statuses that hold no seats, legacy's and this service's alike. */
export const RELEASED = new Set(['cancelled', 'cancelled_weather', 'rejected']);

/** A legacy trip's passengers as `category/residency` → count, the shape of `booking_trip_pax` here. */
export function legacyPax(trip: Row): Map<string, number> {
  const out = new Map<string, number>();
  for (const category of ['ad', 'chd', 'inf', 'foc']) {
    for (const [suffix, residency] of [['_fr', 'foreign'], ['_th', 'thai'], ['', 'unknown']] as const) {
      const n = Math.trunc(Number(trip[`pax_${category}${suffix}`]) || 0);
      if (n > 0) out.set(`${category}/${residency}`, (out.get(`${category}/${residency}`) ?? 0) + n);
    }
  }
  return out;
}

/** `booking_trip_pax` rows as the same map. */
export function targetPax(rows: readonly Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = `${String(r.category)}/${String(r.residency ?? 'unknown')}`;
    out.set(key, (out.get(key) ?? 0) + (Number(r.count) || 0));
  }
  return out;
}

/** The keys whose counts differ, as `key: legacy → here`. Empty when the maps agree. */
export function countDiff(legacy: Map<string, number>, here: Map<string, number>): string[] {
  const out: string[] = [];
  for (const key of [...new Set([...legacy.keys(), ...here.keys()])].sort()) {
    const a = legacy.get(key) ?? 0, b = here.get(key) ?? 0;
    if (a !== b) out.push(`${key}: ${a} → ${b}`);
  }
  return out;
}

/**
 * A legacy pickup text in one canonical form, so `7:30`, `07.30` and `07:30:00` compare equal:
 * `HH:MM`, `HH:MM-HH:MM`, `HH:MM-` or `Before HH:MM at pier`. Undefined when it is none of those
 * (the text can then only be compared as it is).
 */
export function canonicalPickup(value: unknown): string | undefined {
  const s = blank(value) ? '' : String(value).trim();
  if (!s) return '';
  const T = String.raw`(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?`;
  const clock = (h?: string, m?: string, half?: string): string | undefined => {
    if (h === undefined || m === undefined) return undefined;
    let hour = Number(h);
    if (half) { if (hour < 1 || hour > 12) return undefined; hour = /^p/i.test(half) ? (hour % 12) + 12 : hour % 12; }
    return hour > 23 || Number(m) > 59 ? undefined : `${String(hour).padStart(2, '0')}:${m}`;
  };
  let m = new RegExp(`^${T}$`, 'i').exec(s);
  if (m) return clock(m[1], m[2], m[3]);
  m = new RegExp(`^${T}\\s*[-–]\\s*(?:${T})?$`, 'i').exec(s);
  if (m) { const a = clock(m[1], m[2], m[3]); const b = m[4] === undefined ? '' : clock(m[4], m[5], m[6]); return a && b !== undefined ? `${a}-${b}` : undefined; }
  m = new RegExp(`^before\\s+${T}\\s+at\\s+(?:the\\s+)?pier$`, 'i').exec(s);
  if (m) { const a = clock(m[1], m[2], m[3]); return a ? `Before ${a} at pier` : undefined; }
  return undefined;
}

/** This service's pickup fields in the same canonical form. A schema without the window columns passes undefined for them. */
export function targetPickup(start: unknown, end: unknown, atPier: unknown): string {
  const a = blank(start) ? '' : String(start).slice(0, 5), b = blank(end) ? '' : String(end).slice(0, 5);
  if (atPier === true && b) return `Before ${b} at pier`;
  if (a && b) return `${a}-${b}`;
  return a;
}

/** True when a legacy pickup text and this service's fields mean the same. An open window `08:20-` is its start. */
export function samePickup(legacy: unknown, start: unknown, end: unknown, atPier: unknown): boolean {
  const want = canonicalPickup(legacy);
  const got = targetPickup(start, end, atPier);
  if (want === undefined) return got === String(legacy ?? '').trim();
  return (want.endsWith('-') ? want.slice(0, -1) : want) === got;
}

/**
 * The departures a legacy seat lock holds seats on, written from legacy's rules
 * (`bkV2LockRange`, `bkV2LockDowOk`, `bkV2LockPendOn`, `releasedDates`; 08-app.js:2886-3270), not
 * from the importer's: a day lock is its one date; a bulk lock every date `datefrom..dateto` on its
 * weekdays (`dow`, empty = all); a month lock its whole months; each only on a day the route runs
 * (`isOpen`). Seats are `qty` less that date's pending seats; a date released by hand, or a lock no
 * longer active, holds nothing (`holding` false).
 */
export function legacyLockDays(lock: Row, isOpen: (date: string) => boolean): { date: string; pax: number; holding: boolean }[] {
  const s = (v: unknown) => (v == null ? '' : String(v).trim());
  const parse = (v: unknown): unknown => { try { return s(v) ? JSON.parse(s(v)) : undefined; } catch { return undefined; } };
  const qty = Math.trunc(Number(lock.qty) || 0);
  const active = s(lock.status) === 'active';
  const scope = s(lock.scope);
  if (scope !== 'bulk' && scope !== 'month') {
    const pax = qty - Math.max(0, Math.trunc(Number(lock.pendqty) || 0));   // pending seats reserve nothing, day locks too
    return /^\d{4}-\d{2}-\d{2}$/.test(s(lock.date)) ? [{ date: s(lock.date), pax, holding: active }] : [];
  }
  let from = s(lock.datefrom), to = s(lock.dateto) || from;
  if (scope === 'month') {
    const a = s(lock.monthfrom) || s(lock.month), b = s(lock.monthto) || a;
    if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return [];
    from = `${a}-01`;
    to = `${b}-${String(new Date(Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
  const dowList = parse(lock.dow), dow = Array.isArray(dowList) && dowList.length ? new Set(dowList.map(Number)) : undefined;
  const releasedValue = parse(lock.releaseddates);
  const released = new Set(Array.isArray(releasedValue) ? releasedValue.map(String)
    : releasedValue && typeof releasedValue === 'object' ? Object.keys(releasedValue).filter((k) => (releasedValue as Row)[k]) : []);
  const pend = (parse(lock.pendby) ?? {}) as Row;
  const out: { date: string; pax: number; holding: boolean }[] = [];
  for (let d = new Date(`${from}T00:00:00Z`), n = 0; d <= new Date(`${to}T00:00:00Z`) && n < 800; d.setUTCDate(d.getUTCDate() + 1), n++) {
    const date = d.toISOString().slice(0, 10);
    if (dow && !dow.has(d.getUTCDay())) continue;
    if (!isOpen(date)) continue;
    const pax = qty - Math.max(0, Math.trunc(Number(pend[date]) || 0));
    if (pax > 0) out.push({ date, pax, holding: active && !released.has(date) });
  }
  return out;
}

/** Ids in one set and not the other. */
export function setDiff(legacy: Iterable<string>, here: Iterable<string>): { missing: string[]; extra: string[] } {
  const a = new Set(legacy), b = new Set(here);
  return { missing: [...a].filter((x) => !b.has(x)).sort(), extra: [...b].filter((x) => !a.has(x)).sort() };
}

/**
 * Column names the import code builds from two lookup tables, which no scan of the source can
 * spell out: rate-type seat prices, `${zone}_${pax}` from `SEAT_COLUMN_ZONE` × `PAX` in
 * `legacy-rate-types.ts`. A zone added there and not here is reported as unread: the list can only
 * make this check say too much, never hide a column.
 */
export const COMPOSED_READS: readonly RegExp[] = [/^(pk|kl|notransfer)_(adult|child|infant)_(fr|thai)$/];

/**
 * The column-name patterns the source builds with template literals: `pax_${category}${suffix}`
 * becomes /^pax_[a-z0-9_]*$/. Only templates that look like a column name (no spaces or other
 * punctuation) and spell at least three letters themselves count, so a message such as
 * `${routeId} ${zone}` or a bare `${a}_${b}` does not match every column.
 */
export function templateNames(source: string): RegExp[] {
  const out: RegExp[] = [];
  for (const m of source.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
    const literal = m[1]!.replace(/\$\{[^}]*\}/g, '');
    if (!/^[a-z0-9_]*$/i.test(literal) || (literal.match(/[a-z]/gi) ?? []).length < 3) continue;
    const pattern = m[1]!.split(/\$\{[^}]*\}/).map((part) => part.replace(/[^a-z0-9_]/gi, '')).join('[a-z0-9_]*')
      .replace(/(\[a-z0-9_\]\*)+/g, '[a-z0-9_]*');
    out.push(new RegExp(`^${pattern}$`, 'i'));
  }
  return out;
}

/**
 * Columns that hold data in legacy but are named nowhere in the import code: candidates for data
 * the import never reads. A column is "named" when its name appears as a whole word in the source
 * (`b.bookedat`, `'pricebreakdown_seat'`, `str(t.pickuptime)`), matches a name the source builds
 * (`templateNames`), or is one of `COMPOSED_READS`. Keys legacy's tables all share (`row_pk`, `idx`,
 * the parent id) are left out.
 */
export function unreadColumns(columns: readonly { table: string; column: string; filled: number }[], source: string): { table: string; column: string; filled: number }[] {
  const KEYS = new Set(['row_pk', 'idx', 'id']);
  const built = [...templateNames(source), ...COMPOSED_READS];
  return columns.filter((c) => c.filled > 0 && !KEYS.has(c.column) && !c.column.endsWith('_id')
    && !new RegExp(`\\b${c.column.replace(/[^a-z0-9_]/gi, '')}\\b`, 'i').test(source)
    && !built.some((re) => re.test(c.column)));
}
