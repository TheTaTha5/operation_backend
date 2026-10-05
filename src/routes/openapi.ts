/**
 * OpenAPI descriptions for the routes an external sales channel (an agent such as Love Kingdom) calls.
 *
 * **Documentation only.** `registerOperationsRoutes` installs pass-through validator and serializer
 * compilers, so nothing here validates a request or reshapes a response. The hand-written parsers
 * (`bookingInput`, `parsePaxGrid`, …) stay the only validators. That is deliberate: they accept
 * camelCase beside snake_case and coerce nothing, and Fastify's default Ajv would coerce
 * (`"6"` → `6`), drop fields a response schema does not list, and turn a field we never send into
 * a strict rule nobody tested. Because nothing enforces these schemas, they must be kept in step by
 * hand. The README is the full contract, and this file is the summary that `/docs` renders.
 */

const BEARER = [{ bearerAuth: [] }];
const isoDate = { type: 'string', format: 'date', description: 'YYYY-MM-DD, local (Asia/Bangkok) service day' };

const error = {
  type: 'object',
  description: 'Every non-2xx response. `message` names the field or rule that failed; `code` is set for booking-action refusals.',
  properties: {
    statusCode: { type: 'integer' },
    error: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string', examples: ['addOns[2].amount must be a number'] },
  },
};
const err = (description: string) => ({ ...error, description });
const UNAUTHORIZED = { 401: err('Missing or invalid Bearer token'), 403: err('Token lacks the required scope') };

const paxGrid = {
  type: 'object',
  description: 'Category × pricing tier. Categories `ad`, `chd`, `inf`, `foc`; a bare key is untiered, `_fr` is foreign, `_th` is Thai. Every category takes a seat, infants and FOC included. An unknown key is a 400.',
  additionalProperties: { type: 'integer', minimum: 0 },
  examples: [{ ad_fr: 2, chd_fr: 1 }],
};

const capacity = {
  deployed_capacity: { type: 'integer', description: 'Seats that may be sold on the boats deployed that day' },
  licensed_capacity: { type: 'integer', description: 'Registered passenger ceiling; a charter may fill to this' },
  booked_pax: { type: 'integer' },
  charter_pax: { type: 'integer' },
  locked_pax: { type: 'integer', description: 'Seats held by seat locks and not yet drawn by a booking' },
  available_seats: { type: 'integer', description: 'What can be sold right now. The only number to sell against.' },
};

const tripIn = {
  type: 'object',
  required: ['routeId', 'date', 'pax'],
  properties: {
    routeId: { type: 'string', description: 'Also accepted as `route_id`. Must exist in `GET /v1/routes`.' },
    date: { ...isoDate, description: 'Also accepted as `service_date`.' },
    pax: { oneOf: [paxGrid, { type: 'integer', minimum: 1 }] },
    bookingMode: { type: 'string', enum: ['seat', 'charter'], default: 'seat' },
    charterBoatId: { type: 'string', description: 'Required on a charter, refused otherwise' },
    lockDraws: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, description: '`{ lock_id: seats }`: the part of this trip sold from your seat lock' },
    zone: { type: 'string', examples: ['PK', 'KL', 'NoTransfer'] },
    pickupTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
    ovn: { type: 'string', enum: ['return', 'self'] },
    ovnReturnDate: isoDate,
    ovnLeg: { type: 'boolean' },
    ovnOf: { type: 'integer', description: 'Index in this `trips` list of the outbound trip' },
  },
};

const passenger = {
  type: 'object',
  properties: { name: { type: 'string' }, nationality: { type: 'string' }, type: { type: 'string' }, foc: { type: 'boolean' } },
};

const addOn = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', examples: ['longtail-join', 'transfer-r10-PK-van'] },
    label: { type: 'string' },
    amount: { type: 'number', minimum: 0, description: 'Line total (unit price × qty), not a unit price' },
    qty: { type: 'integer', minimum: 1 },
    note: { type: 'string' },
    jAd: { type: 'integer', minimum: 0, description: 'Longtail join only: adults taking it' },
    jChd: { type: 'integer', minimum: 0, description: 'Longtail join only: children taking it' },
  },
};

const bookingHeaderIn = {
  external_id: { type: 'string', description: 'Your own booking id (e.g. `LOV-4190737`). Unique across all bookings.' },
  agent_id: { type: 'string', description: 'The selling agent, from `GET /v1/agents`' },
  voucher_ref: { type: 'string' },
  status: { type: 'string', enum: ['draft', 'quote', 'pending', 'pending_approval', 'pending_foc', 'confirmed', 'rejected', 'cancelled', 'cancelled_weather', 'completed'], default: 'confirmed' },
  leadPax: { type: 'string', description: 'Lead passenger name (`lead_pax`)' },
  leadPhone: { type: 'string' },
  leadEmail: { type: 'string' },
  leadNationality: { type: 'string' },
  pickupZone: { type: 'string' },
  hotelName: { type: 'string' },
  roomNumber: { type: 'string' },
  total: { type: 'number', description: 'Sale total in THB. A number, never a string.' },
  notes: { type: 'string' },
};

const bookingIn = {
  type: 'object',
  description: 'Header scalars accept camelCase or snake_case. A field not listed in the README "Booking header fields" table is dropped, not stored.',
  properties: {
    ...bookingHeaderIn,
    trips: { type: 'array', minItems: 1, items: tripIn },
    passengers: { type: 'array', items: passenger, description: 'Replaces the whole list' },
    addOns: { type: 'array', items: addOn, description: 'Replaces the whole list. `[]` or `null` clears it.' },
  },
};

const booking = {
  type: 'object',
  description: 'Header fields come back in snake_case. A field never sent is absent, not `null`.',
  properties: {
    id: { type: 'string' },
    external_id: { type: 'string' },
    agent_id: { type: 'string' },
    status: { type: 'string' },
    lead_pax: { type: 'string' },
    total: { type: 'number' },
    route_id: { type: 'string', description: 'Derived: first trip' },
    service_date: { ...isoDate, description: 'Derived: first trip' },
    pax: { type: 'integer', description: 'Derived: total across every trip' },
    allocated_pax: { type: 'integer', description: 'Derived: seats currently held (0 once cancelled)' },
    trips: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, seq: { type: 'integer' }, route_id: { type: 'string' }, service_date: isoDate, booking_mode: { type: 'string' }, pax: paxGrid, pax_total: { type: 'integer' }, lock_draws: { type: 'object', additionalProperties: { type: 'integer' } } },
      },
    },
    passengers: { type: 'array', items: passenger },
    add_ons: { type: 'array', items: addOn },
    cancellation_reason: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const seatLock = {
  type: 'object',
  properties: {
    id: { type: 'string' }, route_id: { type: 'string' }, service_date: isoDate, pax: { type: 'integer' }, agent_id: { type: 'string' },
    status: { type: 'string', enum: ['active', 'released'] },
    drawn_pax: { type: 'integer', description: 'Seats bookings have already drawn; the lock still holds `pax − drawn_pax`' },
    created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }, released_at: { type: 'string', format: 'date-time' },
  },
};

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

export const docs = {
  routes: {
    tags: ['Catalogue'], summary: 'List routes (programmes)', security: BEARER,
    description: 'The route ids a booking trip must use. With `from` and `to`, each route carries its operating calendar per day.',
    querystring: { type: 'object', properties: { from: isoDate, to: isoDate } },
    response: { 200: { type: 'object', properties: { routes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, pier: { type: 'string' }, times: { type: 'array', items: { type: 'string' } } } } } } }, 400: err('Bad date range'), ...UNAUTHORIZED },
  },
  availability: {
    tags: ['Availability'], summary: 'Seats left on a route and day, or over a range', security: BEARER,
    description: 'Either `route_id` + `date` for one day, or `from` + `to` (optionally `route_id`) for a list of days. Sell against `available_seats` only. A day can show seats and still be refused at booking time if someone else sold them first; the booking call is the real check.',
    querystring: { type: 'object', properties: { route_id: { type: 'string' }, date: isoDate, from: isoDate, to: isoDate } },
    response: {
      200: {
        description: 'Single-day form. The range form returns `{ days: [{ route_id, service_date, open, ...these numbers, deployments }] }`.',
        type: 'object', properties: { route_id: { type: 'string' }, service_date: isoDate, ...capacity },
      },
      400: err('Missing or conflicting parameters'), ...UNAUTHORIZED,
    },
  },
  listBookings: {
    tags: ['Bookings'], summary: 'Search bookings', security: BEARER,
    querystring: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' }, route_id: { type: 'string' }, date: isoDate, from: isoDate, to: isoDate,
        status: { type: 'string', description: 'Comma-separated statuses' },
        voucher_ref: { type: 'string' }, q: { type: 'string', description: 'Matches id, voucher_ref or lead passenger name' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, cursor: { type: 'string' }, order: { type: 'string', enum: ['asc', 'desc'] },
      },
    },
    response: { 200: { type: 'object', properties: { bookings: { type: 'array', items: booking }, next_cursor: { type: 'string', description: 'Pass as `cursor` for the next page; absent on the last page' }, total: { type: 'integer' } } }, 400: err('Bad filter'), ...UNAUTHORIZED },
  },
  getBooking: {
    tags: ['Bookings'], summary: 'Read one booking', security: BEARER, params: idParam,
    response: { 200: booking, 404: err('Booking not found'), ...UNAUTHORIZED },
  },
  createBooking: {
    tags: ['Bookings'], summary: 'Create a booking', security: BEARER,
    description: 'Seats are checked and taken in the same transaction, so a 201 means the seats are yours. `409` means a trip did not fit and nothing was written.',
    body: bookingIn,
    response: { 201: booking, 400: err('Invalid input, or unknown route/lock'), 409: err('Over capacity, lock short, or boat already chartered'), ...UNAUTHORIZED },
  },
  amendBooking: {
    tags: ['Bookings'], summary: 'Amend a booking', security: BEARER, params: idParam,
    description: 'Header fields merge (absent keeps, `null`/`""` clears). `trips`, `passengers` and `addOns` replace outright when sent. Changing trips is capacity-checked.',
    body: bookingIn,
    response: { 200: booking, 400: err('Invalid input'), 404: err('Booking not found'), 409: err('Over capacity'), ...UNAUTHORIZED },
  },
  cancelBooking: {
    tags: ['Bookings'], summary: 'Cancel a booking and release its seats', security: BEARER, params: idParam,
    body: {
      type: 'object',
      description: 'Either `{ reason }` (or no body), or the full form with a `category`.',
      properties: {
        reason: { type: 'string' },
        category: { type: 'string', enum: ['customer_cancel', 'no_show', 'sick', 'flight_visa', 'agent_error', 'operator', 'force_majeure', 'other'] },
        note: { type: 'string' },
        charge_type: { type: 'string', enum: ['none', 'full', 'partial'] },
        charge_amount: { type: 'number', exclusiveMinimum: 0, description: 'Required, and above 0, when `charge_type` is `partial`' },
      },
    },
    response: { 200: booking, 400: err('Invalid category or charge'), 404: err('Booking not found'), 409: err('Already cancelled (`already_cancelled`) or not cancellable (`booking_closed`)'), ...UNAUTHORIZED },
  },
  listLocks: {
    tags: ['Seat locks'], summary: 'List seat locks', security: BEARER,
    querystring: { type: 'object', properties: { route_id: { type: 'string' }, date: isoDate } },
    response: { 200: { type: 'object', properties: { seat_locks: { type: 'array', items: seatLock } } }, ...UNAUTHORIZED },
  },
  createLock: {
    tags: ['Seat locks'], summary: 'Hold seats for an agent', security: BEARER,
    description: 'Takes seats out of the pool until released or drawn by a booking (`lockDraws`). There is no expiry: a lock you do not release holds its seats forever.',
    body: { type: 'object', required: ['route_id', 'service_date', 'pax'], properties: { route_id: { type: 'string' }, service_date: isoDate, pax: { type: 'integer', minimum: 1 }, agent_id: { type: 'string' } } },
    response: { 201: seatLock, 400: err('Invalid input'), 409: err('Not enough seats'), ...UNAUTHORIZED },
  },
  releaseLock: {
    tags: ['Seat locks'], summary: 'Release a seat lock', security: BEARER, params: idParam,
    description: 'Idempotent. Seats already drawn by bookings stay with those bookings; only the undrawn rest goes back to the pool.',
    response: { 200: seatLock, 404: err('Seat lock not found'), ...UNAUTHORIZED },
  },
};
