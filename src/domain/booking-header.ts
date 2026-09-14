/**
 * The booking header: the ~55 scalars the frontend writes flat on its booking document.
 *
 * These live as columns on `bookings`, not inside `booking_data`. The blob is being deleted
 * (`todo/booking-model.md` § "The blob is being deleted"), and a field that is not modelled is
 * dropped on the floor deliberately — dropping it is the signal that it needs modelling.
 *
 * The mapping is here rather than in either store because both need it and neither owns it. The
 * in-process store has no database, so expressing this as SQL would force a hand-written duplicate
 * that drifts — the failure `src/domain/calendar.ts` was written to avoid.
 *
 * Keys are read in the frontend's camelCase (`leadPax`) and in our own snake_case (`lead_pax`),
 * the way the route handler already accepts `routeId` beside `route_id`. Fixed-size structs are
 * flattened: `guides {english, russian, chinese, otherLang}` is four columns, because adding a
 * fifth language is a schema change either way.
 */

export type BookingHeader = {
  schema_ver?: number;
  sold_by?: string; purpose?: string; staff_id?: string; staff_purpose?: string;
  lead_pax?: string; lead_nationality?: string; lead_type?: string; lead_foc?: boolean;
  lead_phone?: string; lead_email?: string;
  pickup_area_id?: string; pickup_self?: boolean; pickup_area?: string; pickup_zone?: string;
  hotel_name?: string; room_number?: string;
  dropoff_same?: boolean; dropoff_area_id?: string; dropoff_area?: string; dropoff_hotel_name?: string;
  guide_english?: boolean; guide_russian?: boolean; guide_chinese?: boolean; guide_other_lang?: string;
  pax_type?: string;
  special_meals_veg?: number; special_meals_vegan?: number; special_meals_halal?: number;
  special_meals_allergies?: string; large_luggage?: number;
  cash_on_tour_amount?: number; cash_on_tour_currency?: string; cash_on_tour_handling?: string; cash_on_tour_note?: string;
  price_mode?: string; manual_total?: number; total?: number;
  price_seat?: number; price_addon?: number; price_foc_discount?: number; price_discount?: number; price_extra?: number;
  payment_method?: string; payment_net_days?: number; payment_source?: string; payment_contract_version?: string;
  market?: string; market_sub?: string; market_agent_id?: string; market_at?: string;
  booking_date?: string; booked_at?: string; created_by?: string; updated_by?: string;
  confirmed_at?: string; confirmed_by?: string;
  notes?: string; note?: string;
};

/**
 * A patch is a header in which a column may also be `null`, meaning *clear this column*.
 *
 * `PATCH` merges: a column the document does not mention is left alone. That would leave no way to
 * empty a field filled in by mistake unless clearing is said out loud, so a key that *is* mentioned
 * and carries no value — `null`, or the empty string a form sends when someone deletes the text in
 * a box — writes `NULL`. The distinction is the point: absent means "no opinion", null means "there
 * is no value for this", and only the second is a claim the caller is making.
 */
export type BookingHeaderPatch = { [K in keyof BookingHeader]?: BookingHeader[K] | null };

/**
 * Every header column, in one list.
 *
 * The SQL store builds its INSERT and its UPDATE from this rather than repeating the names, so
 * adding a column is one edit here plus the migration — not one edit here and a second in a
 * hand-maintained statement that silently stops writing the field it forgot.
 */
export const BOOKING_HEADER_COLUMNS = [
  'schema_ver',
  'sold_by', 'purpose', 'staff_id', 'staff_purpose',
  'lead_pax', 'lead_nationality', 'lead_type', 'lead_foc', 'lead_phone', 'lead_email',
  'pickup_area_id', 'pickup_self', 'pickup_area', 'pickup_zone', 'hotel_name', 'room_number',
  'dropoff_same', 'dropoff_area_id', 'dropoff_area', 'dropoff_hotel_name',
  'guide_english', 'guide_russian', 'guide_chinese', 'guide_other_lang',
  'pax_type', 'special_meals_veg', 'special_meals_vegan', 'special_meals_halal',
  'special_meals_allergies', 'large_luggage',
  'cash_on_tour_amount', 'cash_on_tour_currency', 'cash_on_tour_handling', 'cash_on_tour_note',
  'price_mode', 'manual_total', 'total',
  'price_seat', 'price_addon', 'price_foc_discount', 'price_discount', 'price_extra',
  'payment_method', 'payment_net_days', 'payment_source', 'payment_contract_version',
  'market', 'market_sub', 'market_agent_id', 'market_at',
  'booking_date', 'booked_at', 'created_by', 'updated_by', 'confirmed_at', 'confirmed_by',
  'notes', 'note',
] as const satisfies readonly (keyof BookingHeader)[];

/**
 * Column groups the SQL store needs, because `pg` hydrates three of these types into something
 * other than what the API returns.
 *
 * - `DATE` arrives as a JS `Date`. `String(row.booking_date)` yields `"Wed Jan 04 2030 …"` and
 *   `toISOString().slice(0,10)` is off by one day east of UTC, so these are cast in the query.
 * - `NUMERIC` arrives as a *string* (`"1500.00"`), deliberately, since it is wider than a float.
 *   Returned unconverted, `total` would be a string for one store and a number for the other.
 * - `TIMESTAMPTZ` arrives as a `Date` and is rendered the way `created_at` already is.
 */
export const BOOKING_HEADER_DATE_COLUMNS = ['market_at', 'booking_date'] as const;
export const BOOKING_HEADER_NUMERIC_COLUMNS = [
  'cash_on_tour_amount', 'manual_total', 'total',
  'price_seat', 'price_addon', 'price_foc_discount', 'price_discount', 'price_extra',
] as const;
export const BOOKING_HEADER_TIMESTAMP_COLUMNS = ['booked_at', 'confirmed_at'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An absent value and an empty string are the same thing here: the field was not filled in. */
const text = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  const raw = typeof value === 'string' ? value : String(value);
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
};
const bool = (value: unknown): boolean | undefined => (value == null ? undefined : Boolean(value));
const num = (value: unknown): number | undefined => {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const int = (value: unknown): number | undefined => {
  const parsed = num(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
};
/**
 * A `DATE` column takes a plain `YYYY-MM-DD`. The frontend already truncates its timestamps for
 * these two fields, but an integrator sending a full ISO instant must not write a row that reads
 * back a day early east of UTC, so the day is taken from the string rather than through a `Date`.
 */
const dateOnly = (value: unknown): string | undefined => {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const day = raw.slice(0, 10);
  return ISO_DATE.test(day) ? day : undefined;
};

const struct = (value: unknown): Record<string, unknown> =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

type Parse = (value: unknown) => string | number | boolean | undefined;
/** Where a column's value may arrive from: an object, and the key to look for in it. */
type Source = readonly [Record<string, unknown>, string];
type Field = readonly [keyof BookingHeader, Parse, readonly Source[]];

/**
 * Every column, its converter, and the document keys it may arrive under — in one table.
 *
 * Create and amend both read this table, so the two cannot come to disagree about where a field
 * lives. A second hand-maintained list of which keys mean which column is how `PATCH` would end up
 * quietly ignoring a field `POST` had just learned to accept — which is what it did before this
 * table existed.
 *
 * Order matters within a field's sources: the first key that is *present* wins, present being
 * distinct from carrying a value. Naming a key at all is what makes it a claim, and that is what
 * lets an amendment tell "leave it alone" apart from "empty it".
 */
function fields(document: Record<string, unknown>): readonly Field[] {
  const doc = document;
  const guides = struct(doc.guides);
  const meals = struct(doc.specialMeals ?? doc.special_meals);
  const cash = struct(doc.cashOnTour ?? doc.cash_on_tour);
  const price = struct(doc.priceBreakdown ?? doc.price_breakdown);
  const payment = struct(doc.paymentSnapshot ?? doc.payment_snapshot);
  const market = struct(doc.marketSnapshot ?? doc.market_snapshot);

  /** The document's own keys: the frontend's camelCase first, then the snake_case we answer in. */
  const own = (...keys: string[]): readonly Source[] => keys.map((key) => [doc, key] as Source);
  /** A key inside a flattened struct, with the flat column name as the second spelling. */
  const inside = (source: Record<string, unknown>, key: string, column: string): readonly Source[] =>
    [[source, key], [doc, column]];

  return [
    ['schema_ver', int, own('schemaVer', 'schema_ver')],

    ['sold_by', text, own('soldBy', 'sold_by')],
    ['purpose', text, own('purpose')],
    ['staff_id', text, own('staffId', 'staff_id')],
    ['staff_purpose', text, own('staffPurpose', 'staff_purpose')],

    ['lead_pax', text, own('leadPax', 'lead_pax')],
    ['lead_nationality', text, own('leadNationality', 'lead_nationality')],
    ['lead_type', text, own('leadType', 'lead_type')],
    ['lead_foc', bool, own('leadFoc', 'lead_foc')],
    ['lead_phone', text, own('leadPhone', 'lead_phone')],
    ['lead_email', text, own('leadEmail', 'lead_email')],

    ['pickup_area_id', text, own('pickupAreaId', 'pickup_area_id')],
    ['pickup_self', bool, own('pickupSelf', 'pickup_self')],
    ['pickup_area', text, own('pickupArea', 'pickup_area')],
    ['pickup_zone', text, own('pickupZone', 'pickup_zone')],
    ['hotel_name', text, own('hotelName', 'hotel_name')],
    ['room_number', text, own('roomNumber', 'room_number')],

    ['dropoff_same', bool, own('dropoffSame', 'dropoff_same')],
    ['dropoff_area_id', text, own('dropoffAreaId', 'dropoff_area_id')],
    ['dropoff_area', text, own('dropoffArea', 'dropoff_area')],
    ['dropoff_hotel_name', text, own('dropoffHotelName', 'dropoff_hotel_name')],

    ['guide_english', bool, inside(guides, 'english', 'guide_english')],
    ['guide_russian', bool, inside(guides, 'russian', 'guide_russian')],
    ['guide_chinese', bool, inside(guides, 'chinese', 'guide_chinese')],
    ['guide_other_lang', text, inside(guides, 'otherLang', 'guide_other_lang')],

    ['pax_type', text, own('paxType', 'pax_type')],
    ['special_meals_veg', int, inside(meals, 'veg', 'special_meals_veg')],
    ['special_meals_vegan', int, inside(meals, 'vegan', 'special_meals_vegan')],
    ['special_meals_halal', int, inside(meals, 'halal', 'special_meals_halal')],
    ['special_meals_allergies', text, inside(meals, 'allergies', 'special_meals_allergies')],
    ['large_luggage', int, own('largeLuggage', 'large_luggage')],

    ['cash_on_tour_amount', num, inside(cash, 'amount', 'cash_on_tour_amount')],
    ['cash_on_tour_currency', text, inside(cash, 'currency', 'cash_on_tour_currency')],
    ['cash_on_tour_handling', text, inside(cash, 'handling', 'cash_on_tour_handling')],
    ['cash_on_tour_note', text, inside(cash, 'note', 'cash_on_tour_note')],

    ['price_mode', text, own('priceMode', 'price_mode')],
    ['manual_total', num, own('manualTotal', 'manual_total')],
    ['total', num, own('total')],
    ['price_seat', num, inside(price, 'seat', 'price_seat')],
    ['price_addon', num, inside(price, 'addOn', 'price_addon')],
    ['price_foc_discount', num, inside(price, 'focDiscount', 'price_foc_discount')],
    ['price_discount', num, inside(price, 'discount', 'price_discount')],
    ['price_extra', num, inside(price, 'extra', 'price_extra')],

    ['payment_method', text, inside(payment, 'method', 'payment_method')],
    ['payment_net_days', int, inside(payment, 'netDays', 'payment_net_days')],
    ['payment_source', text, inside(payment, 'source', 'payment_source')],
    ['payment_contract_version', text, inside(payment, 'contractVersion', 'payment_contract_version')],

    ['market', text, inside(market, 'market', 'market')],
    ['market_sub', text, inside(market, 'sub', 'market_sub')],
    ['market_agent_id', text, inside(market, 'agentId', 'market_agent_id')],
    ['market_at', dateOnly, inside(market, 'at', 'market_at')],

    ['booking_date', dateOnly, own('bookingDate', 'booking_date')],
    ['booked_at', text, own('bookedAt', 'booked_at')],
    ['created_by', text, own('createdBy', 'created_by')],
    ['updated_by', text, own('updatedBy', 'updated_by')],
    ['confirmed_at', text, own('confirmedAt', 'confirmed_at')],
    ['confirmed_by', text, own('confirmedBy', 'confirmed_by')],

    ['notes', text, own('notes')],
    ['note', text, own('note')],
  ];
}

/** The first source that names the key. Presence is the question, not whether a value came with it. */
const found = (sources: readonly Source[]): { present: boolean; raw: unknown } => {
  for (const [source, key] of sources) if (key in source) return { present: true, raw: source[key] };
  return { present: false, raw: undefined };
};

/**
 * Reads a booking document as an amendment: every column the document *mentions*, carrying `null`
 * where it names a column and gives it no value.
 *
 * Columns the document is silent about are absent from the result, and whoever applies it leaves
 * those alone — `PATCH` merges, so sending one field must not blank the other fifty-six.
 * Unrecognised keys are ignored, which is the point: there is no overflow column for them to fall
 * into any more.
 */
export function bookingHeaderPatch(document: Record<string, unknown>): BookingHeaderPatch {
  const patch: Record<string, unknown> = {};
  for (const [column, parse, sources] of fields(document)) {
    const { present, raw } = found(sources);
    if (!present) continue;
    const value = parse(raw);
    patch[column] = value === undefined ? null : value;
  }
  return patch as BookingHeaderPatch;
}

/**
 * Reads a booking document into header columns, for a create.
 *
 * Nothing exists to clear yet, so the two claims an amendment distinguishes — "no opinion" and "no
 * value" — reach the same stored row here, and a mentioned-but-empty field is simply absent.
 */
export function bookingHeader(document: Record<string, unknown>): BookingHeader {
  const patch = bookingHeaderPatch(document);
  for (const key of Object.keys(patch) as (keyof BookingHeader)[]) if (patch[key] === null) delete patch[key];
  return patch as BookingHeader;
}

/**
 * Applies a patch to a booking held in memory, as the `UPDATE` applies it to a row.
 *
 * Clearing deletes the key rather than setting it to `null`: an absent field is how this service
 * says "never given" on the wire, and a store answering `null` where the other answers nothing at
 * all is exactly the divergence `bookingView` exists to prevent.
 */
export function applyBookingHeader(target: Record<string, unknown>, patch: BookingHeaderPatch): void {
  for (const [column, value] of Object.entries(patch)) {
    if (value === null) delete target[column];
    else target[column] = value;
  }
}

/** The columns the table above covers, so a test can hold it against `BOOKING_HEADER_COLUMNS`. */
export const mappedHeaderColumns = (): readonly (keyof BookingHeader)[] => fields({}).map(([column]) => column);
