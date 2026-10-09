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
/** Love Kingdom's login only: a write refused as bad input is held for ops instead (todo/b2c-sync-model.md). */
const HELD = {
  202: {
    type: 'object', description: 'Love Kingdom\'s login only: what would have been a `400` is held for ops to review (`code: held_for_review`). Nothing was booked or changed.',
    properties: { code: { type: 'string', enum: ['held_for_review'] }, message: { type: 'string' }, held_order: { type: 'object', additionalProperties: true } },
  },
};

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
  available_seats: { type: 'integer', nullable: true, description: 'What can be sold right now. The only number to sell against. `null` on a land route, which has no seat limit (`unlimited`). `0` on a marine day with no boat deployed, which still sells (see `unplaced_pax`).' },
  unlimited: { type: 'boolean', description: 'A land route: no seat pool, so a booking or lock is never refused for seats.' },
  unplaced_pax: { type: 'integer', description: 'On a marine day with no boat deployed: passengers sold and seats locked, waiting for a boat. Such a day sells ungated, as legacy does. `0` once a boat is deployed.' },
  licensed_free: { type: 'integer', nullable: true, description: 'Registered passenger seats left on the unchartered boats, locks not subtracted: how far an over-allotment approval may still go (legacy "Real seats left"). `null` on a land route; `0` with no boat deployed.' },
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
    pickupTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$', description: 'Hotel pickup, or the start of the pickup window. Absent for a pier deadline.' },
    pickupTimeEnd: { type: 'string', pattern: '^\\d{2}:\\d{2}$', description: 'End of the pickup window (`07:30-07:45` is `pickupTime` 07:30, `pickupTimeEnd` 07:45), or with `pickupAtPier` the time to be at the pier.' },
    pickupAtPier: { type: 'boolean', description: 'The guest meets the boat at the pier by `pickupTimeEnd` (legacy `Before 08:30 at pier`). Refuses `pickupTime`.' },
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

const STATUSES = ['draft', 'quote', 'pending', 'pending_approval', 'pending_foc', 'confirmed', 'rejected', 'cancelled', 'cancelled_weather', 'completed'];

const bookingHeaderIn = {
  external_id: { type: 'string', description: 'Your own booking id (e.g. `LOV-4190737`). Unique across all bookings.' },
  agent_id: { type: 'string', description: 'The selling agent, from `GET /v1/agents`' },
  voucher_ref: { type: 'string' },
  leadPax: { type: 'string', description: 'Lead passenger name (`lead_pax`)' },
  leadPhone: { type: 'string' },
  leadEmail: { type: 'string' },
  leadNationality: { type: 'string' },
  pickupZone: { type: 'string' },
  hotelName: { type: 'string' },
  roomNumber: { type: 'string' },
  total: { type: 'number', description: 'Sale total in THB. A number, never a string.' },
  price_discount: { type: 'number', description: 'Discount in THB, sent negative as legacy stores it. On a confirm, any discount waits for approval (`pending_approval`).' },
  focReason: { type: 'string', description: 'Why passengers travel free (`foc_reason`). Required to confirm a booking with FOC passengers.' },
  notes: { type: 'string' },
};

/** Set by the server, never by a request: refused on create, and on `PATCH` unless it repeats the stored value. */
const SERVER_SET = 'Set by the server.';
const serverOwned = {
  created_by: { type: 'string', readOnly: true, description: `${SERVER_SET} The logged-in user who created the booking.` },
  booked_at: { type: 'string', format: 'date-time', readOnly: true, description: `${SERVER_SET} When the booking was created.` },
  confirmed_by: { type: 'string', readOnly: true, description: `${SERVER_SET} The logged-in user who first confirmed it (\`/confirm\`, \`/approve\`, or a create the server confirmed).` },
  confirmed_at: { type: 'string', format: 'date-time', readOnly: true, description: `${SERVER_SET} When it was first confirmed.` },
  updated_by: { type: 'string', readOnly: true, description: `${SERVER_SET} The logged-in user who last changed it; a request's value is ignored.` },
};

const bookingIn = {
  type: 'object',
  description: 'Header scalars accept camelCase or snake_case. A field not listed in the README "Booking header fields" table is dropped, not stored. '
    + '`created_by`, `booked_at`, `confirmed_by` and `confirmed_at` are set by the server and refused here (`created_by` may only repeat the logged-in user).',
  properties: {
    intent: {
      type: 'string', enum: ['quote', 'confirm'], default: 'confirm',
      description: 'Which save button: "Save as quote" or "Confirm". The server decides the status from it and the facts: '
        + '`quote`; `confirmed`; `pending_foc` (FOC passengers, needs `focReason`); or `pending_approval` '
        + '(over the allotment but within the boats\' registered seats, holding no seats; or a discount on a confirm). See README "Booking status".',
    },
    status: {
      type: 'string', enum: ['quote', 'draft', 'confirmed', 'pending_foc'], deprecated: true,
      description: 'Deprecated: send `intent`. Read as `intent`: `quote`/`draft` → quote, `confirmed`/`pending_foc` → confirm. '
        + 'Any other status is `400`; `intent` and `status` that disagree are `400`. Logged as a deprecation warning.',
    },
    ...bookingHeaderIn,
    trips: { type: 'array', minItems: 1, items: tripIn },
    passengers: { type: 'array', items: passenger, description: 'Replaces the whole list' },
    addOns: { type: 'array', items: addOn, description: 'Replaces the whole list. `[]` or `null` clears it.' },
  },
};

const bookingPatchIn = {
  type: 'object',
  description: 'Only the fields you send change. `status` and the server-set fields (`created_by`, `booked_at`, `confirmed_by`, `confirmed_at`) '
    + 'are accepted only when they repeat the stored value, so a client that sends the whole booking back keeps working; a different value is `400`.',
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
    status: { type: 'string', enum: STATUSES, readOnly: true, description: `${SERVER_SET} Decided on create from \`intent\`, then moved by the commands and re-weighed by edits.` },
    foc_reason: { type: 'string' },
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
    approvals: {
      type: 'array', readOnly: true, description: `${SERVER_SET} Every approval asked for, oldest first, kept after it is decided. At most one per kind is \`pending\`.`,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['approval', 'foc'], description: '`approval`: over the allotment and/or a discount. `foc`: free passengers.' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'replaced'], description: '`replaced`: a later edit asked again before this was decided.' },
          reason: {
            type: 'string', nullable: true,
            description: 'Why it was asked: `over_capacity`, `discount` or `over_capacity+discount`; on one imported from legacy also `closed_day` or `b2c_hold`. `null` on an FOC approval (its reason is the booking\'s `foc_reason`).',
          },
          over_capacity: { type: 'boolean', description: 'Over the allotment. While pending, the booking holds no seats.' },
          over_total: { type: 'integer', nullable: true }, discount: { type: 'number', nullable: true }, foc_count: { type: 'integer', nullable: true },
          target_status: { type: 'string', description: 'Where `/approve` moves the booking' },
          requested_by: { type: 'string', nullable: true }, requested_at: { type: 'string', format: 'date-time' },
          decided_by: { type: 'string', nullable: true }, decided_at: { type: 'string', format: 'date-time', nullable: true }, note: { type: 'string', nullable: true },
          days: {
            type: 'array', description: 'The days over the allotment, as they were when asked',
            items: { type: 'object', properties: { route_id: { type: 'string' }, service_date: isoDate, need: { type: 'integer' }, over_by: { type: 'integer' }, licensed_free: { type: 'integer', nullable: true, description: 'Registered seats left that day when the approval was asked for (legacy "Real seats left"); at least `need`. `null` on a day recorded before it was kept.' } } },
          },
        },
      },
    },
    cancellation_reason: { type: 'string', readOnly: true, description: `${SERVER_SET} Written by \`/cancel\` and \`/cancel-weather\`.` },
    ...serverOwned,
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

/** What each status command does, for its documentation. */
const COMMAND_DOCS: Record<string, { summary: string; description: string }> = {
  confirm: {
    summary: 'Confirm a draft, quote or pending booking',
    description: 'From `draft`, `quote` or `pending`. Decided as a create with `intent: confirm`: `confirmed`; `pending_foc` when a trip carries FOC (free) passengers '
      + '(`foc_reason` required, else `400`); `pending_approval` when it carries a discount. The seats it holds are not weighed again. '
      + 'Stamps `confirmed_by` (the logged-in user) and `confirmed_at` the first time it is confirmed.',
  },
  approve: {
    summary: 'Approve a booking waiting for approval',
    description: 'From `pending_approval` or `pending_foc`. Moves to the approval\'s `target_status` (usually `confirmed`; `pending_foc` when FOC passengers still wait); '
      + 'the approver is the logged-in user. Approving a booking that waited over the allotment gives it its seats, even past the boats\' registered seats: '
      + 'then `warnings` lists each day (`over_licence`, `over_by`) — add a boat. Optional `note` is kept on the approval and in the history.',
  },
  reject: {
    summary: 'Reject a booking waiting for approval',
    description: 'From `pending_approval` or `pending_foc`. Becomes `rejected` and gives its seats back. Optional `note` is kept on the approval and in the history.',
  },
  'cancel-weather': {
    summary: 'Cancel a booking because the trip was called off for weather',
    description: 'From any status that holds seats. Becomes `cancelled_weather`, `cancellation_reason` `weather`, and gives its seats back. '
      + 'Undo with `/restore`. Refunds and credits are not handled here yet.',
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
const calendarKindSchema = { type: 'string', enum: ['open', 'closed'] };
const calendarSeason = { type: 'object', properties: { id: { type: 'string' }, kind: calendarKindSchema, from_date: isoDate, to_date: isoDate } };

export const docs = {
  routes: {
    tags: ['Catalogue'], summary: 'List routes (programmes)', security: BEARER,
    description: 'The route ids a booking trip must use. With `from` and `to`, each route carries its operating calendar per day. `kind=marine` lists boat programmes only; `kind=land` lists transfers, tours and tickets.',
    querystring: { type: 'object', properties: { from: isoDate, to: isoDate, kind: { type: 'string', enum: ['marine', 'land'] } } },
    response: { 200: { type: 'object', properties: { routes: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['marine', 'land'] }, ext_id: { type: 'string', description: 'Love Kingdom product code, e.g. PTP-005:VT-002' }, pier: { type: 'string' }, times: { type: 'array', items: { type: 'string' } },
      seasons: { type: 'array', description: 'The calendar as stored, by start date. Overlaps are allowed; the one that starts first decides a day.', items: calendarSeason },
      overrides: { type: 'array', description: 'Single days that beat any season, by date.', items: { type: 'object', properties: { service_date: isoDate, kind: calendarKindSchema } } },
    } } } } }, 400: err('Bad date range or kind'), ...UNAUTHORIZED },
  },
  addSeason: {
    tags: ['Catalogue'], summary: 'Add an open or closed season to a route', security: BEARER,
    description: 'Legacy\'s Settings → Programs "add season". Needs the `config` edit area. Seasons may overlap. A season that closes a day holding bookings or a deployed boat (from today on) is `409 bookings_on_closed_day`, listing them, unless the body says `close_anyway: true`.',
    params: idParam,
    body: { type: 'object', required: ['kind', 'from_date', 'to_date'], properties: { kind: calendarKindSchema, from_date: isoDate, to_date: isoDate, close_anyway: { type: 'boolean', default: false } } },
    response: { 201: calendarSeason, 400: err('Bad kind or dates'), 404: err('Route not found'), 409: err('Closes days that hold bookings or boats (`bookings_on_closed_day`)'), ...UNAUTHORIZED },
  },
  deleteSeason: {
    tags: ['Catalogue'], summary: 'Delete a season', security: BEARER,
    description: 'Needs the `config` edit area. Deleting an open season can close days; then the same `409 bookings_on_closed_day` applies, and `?close_anyway=true` overrides it.',
    params: { type: 'object', properties: { id: { type: 'string' }, season_id: { type: 'string' } } },
    querystring: { type: 'object', properties: { close_anyway: { type: 'boolean' } } },
    response: { 204: { type: 'null', description: 'Deleted' }, 404: err('Route or season not found'), 409: err('Closes days that hold bookings or boats (`bookings_on_closed_day`)'), ...UNAUTHORIZED },
  },
  setDay: {
    tags: ['Catalogue'], summary: 'Open or close one day, whatever the seasons say', security: BEARER,
    description: 'Needs the `config` edit area. Replaces any override on that day. Closing a day that holds bookings or a deployed boat is `409 bookings_on_closed_day` unless `close_anyway: true`.',
    params: { type: 'object', properties: { id: { type: 'string' }, date: isoDate } },
    body: { type: 'object', required: ['kind'], properties: { kind: calendarKindSchema, close_anyway: { type: 'boolean', default: false } } },
    response: { 200: { type: 'object', properties: { route_id: { type: 'string' }, service_date: isoDate, kind: calendarKindSchema } }, 400: err('Bad kind or date'), 404: err('Route not found'), 409: err('Closes a day that holds bookings or boats (`bookings_on_closed_day`)'), ...UNAUTHORIZED },
  },
  clearDay: {
    tags: ['Catalogue'], summary: 'Remove a day\'s override, so the seasons decide it again', security: BEARER,
    description: 'Needs the `config` edit area. Removing an override that opened a day can close it; then `?close_anyway=true` is needed if it holds bookings or a deployed boat.',
    params: { type: 'object', properties: { id: { type: 'string' }, date: isoDate } },
    querystring: { type: 'object', properties: { close_anyway: { type: 'boolean' } } },
    response: { 204: { type: 'null', description: 'Removed' }, 404: err('Route not found, or no override that day'), 409: err('Closes a day that holds bookings or boats (`bookings_on_closed_day`)'), ...UNAUTHORIZED },
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
        updated_since: { type: 'string', format: 'date-time', description: 'Bookings changed at or after this instant (Love Kingdom\'s reconciliation read)' },
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
    description: 'Seats are weighed and the status decided in one transaction. A trip that fits takes its seats. Over the allotment but within the boats\' '
      + 'registered seats, the booking is still created (`201`) as `pending_approval`, holding no seats until `/approve`. Seats held by other agents\' locks, '
      + 'or past the registered seats, are `409` and nothing is written. Read `status` from the response; it is the server\'s.',
    body: bookingIn,
    response: {
      201: booking, ...HELD, 400: err('Invalid input, unknown route/lock, `intent`/`status` not accepted, or FOC passengers confirmed without `focReason`'),
      409: err('A trip on a day its route does not run (`route_closed`), seats held by seat locks, the registered seats full, lock short, boat already chartered, or `external_id` already used (`duplicate_external_id`)'), ...UNAUTHORIZED,
    },
  },
  amendBooking: {
    tags: ['Bookings'], summary: 'Amend a booking', security: BEARER, params: idParam,
    description: 'Header fields merge (absent keeps, `null`/`""` clears). `trips`, `passengers` and `addOns` replace outright when sent. '
      + 'Asking for more seats is weighed like a create: over the allotment the booking moves to `pending_approval` (holding none); a waiting booking that fits again '
      + 'goes back to where it was. '
      + 'The status is not changed here: use the commands. A cancelled, rejected, weather-cancelled or completed booking cannot be edited (`409 booking_closed`).',
    body: bookingPatchIn,
    response: {
      200: booking, ...HELD, 400: err('Invalid input, or a different value for `status` or a server-set field (the message names the command to use)'),
      404: err('Booking not found'), 409: err('An added or moved trip on a day its route does not run (`route_closed`), over capacity, or the booking is closed (`booking_closed`)'), ...UNAUTHORIZED,
    },
  },
  statusCommand: (command: string) => ({
    tags: ['Bookings'], summary: COMMAND_DOCS[command].summary, description: COMMAND_DOCS[command].description, security: BEARER, params: idParam,
    body: { type: 'object', properties: { note: { type: 'string', description: 'Written into the booking history' } } },
    response: {
      200: {
        ...booking,
        properties: {
          ...booking.properties,
          warnings: {
            type: 'array', description: 'Empty unless `/approve` granted seats past the registered seats',
            items: { type: 'object', properties: { code: { type: 'string', enum: ['over_licence'] }, route_id: { type: 'string' }, service_date: isoDate, over_by: { type: 'integer' } } },
          },
        },
      },
      400: err('Invalid body, or FOC passengers confirmed without `foc_reason`'), 404: err('Booking not found'),
      409: err('Not allowed from the booking\'s current status (`wrong_status`, `already_cancelled` or `booking_closed`)'), ...UNAUTHORIZED,
    },
  }),
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
    response: { 200: booking, ...HELD, 400: err('Invalid category or charge'), 404: err('Booking not found'), 409: err('Already cancelled (`already_cancelled`) or not cancellable (`booking_closed`)'), ...UNAUTHORIZED },
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
    response: { 201: seatLock, 400: err('Invalid input'), 409: err('The route does not run that day (`route_closed`), or not enough seats'), ...UNAUTHORIZED },
  },
  releaseLock: {
    tags: ['Seat locks'], summary: 'Release a seat lock', security: BEARER, params: idParam,
    description: 'Idempotent. Seats already drawn by bookings stay with those bookings; only the undrawn rest goes back to the pool.',
    response: { 200: seatLock, 404: err('Seat lock not found'), ...UNAUTHORIZED },
  },
};
