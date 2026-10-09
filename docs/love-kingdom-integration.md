# Love Kingdom → Operation Backend: booking integration

For the Love Kingdom team (B2C website and CS sales back-office). This explains how to book boat
seats directly into Operation Backend, the operations system of record, instead of the ops side
importing `b2c_LOV-…` rows after the fact.

- **Live contract:** `https://<operation-backend-host>/docs` (Swagger UI) and `/docs/json` (OpenAPI 3).
  Generate a client from the JSON if you like.
- **Full field reference:** this repo's `README.md`, section "API". Where this guide and the README
  disagree, the README wins. Tell us when they disagree.

## 1. What changes for you

| Today | With this API |
|---|---|
| Availability is read from the ops DB view (`v_seat_availability`) | `GET /v1/availability`, which is the same answer ops sells against |
| `assertSeatsAvailable` checks, then you insert. Two buyers at once can both pass, and the check fails open | `POST /v1/bookings` checks and takes the seats in one transaction. `201` means the seats are yours, and `409` means they were not, with nothing written |
| The ops side drops `addonsSelected` on import | Add-ons are stored on the booking (`addOns`) |
| No hold while a B2C customer pays | Seat locks: hold, pay, then book from the hold, or release it |

Your own booking (customer, payments, hotels, third-party items, vouchers) **stays in Love Kingdom**.
We hold only the boat part: who is on which departure, and the sale details operations needs on
the day.

## 2. Authentication

Every call sends `Authorization: Bearer <token>`. Your server logs in as **your service user**, which
we create for you: it books for agent `a_b2c` only, and sees and changes only `a_b2c`'s bookings.

- `POST /v1/login {"username": "…", "password": "…"}` returns a 12-hour token (`access_token`,
  `expires_in`). Log in again when it expires, or on any `401`.
- A booking without `agent_id` gets `a_b2c`; another agent is `403`. Another agent's booking reads
  as `404`. Any write outside `/v1/bookings` is `403`.
- 15 failed logins in 3 minutes lock the username for up to 3 minutes (`429`).

**Edit conflicts (required):** every booking response carries `version` (and an `ETag`). Send it
back as `If-Match: "<version>"` on `PATCH` and `cancel`: a booking someone changed since you read it
answers `409 stale_version` instead of being overwritten. Without it the write is refused with
`428 version_required` (since 2026-10-09). Creating a booking needs none.

**Availability only:** `GET /v1/availability` also accepts your existing `X-Api-Key` header (the
`B2C_API_KEY` you send legacy's `/api/b2c/availability`) instead of a token. The key opens nothing
else: every other call answers `403` with it, so booking still needs the token.

Never call us from the browser or ship the credentials to the public `book/` page. Our server does
not allow your browser origin (CORS), and a token in the page would let anyone book.

## 3. The calls you need

| Purpose | Call |
|---|---|
| Route ids (map your `programId` / `opsRouteId` to these) | `GET /v1/routes` |
| Agent ids (map your channel → agent) | `GET /v1/agents` |
| Seats left, one day | `GET /v1/availability?route_id=r10&date=2030-01-04` → sell against `available_seats` only |
| Seats left, a month grid | `GET /v1/availability?from=2030-01-01&to=2030-01-31` (optionally `&route_id=`) |
| Create | `POST /v1/bookings` → `201` |
| Read | `GET /v1/bookings/{id}` and `GET /v1/bookings?agent_id=a_b2c&from=…&to=…` |
| Amend | `PATCH /v1/bookings/{id}` |
| Cancel | `POST /v1/bookings/{id}/cancel` (releases the seats) |
| Hold, then release | `POST /v1/seat-locks`, `POST /v1/seat-locks/{id}/release` |

**Keep the `id` we return.** It is the booking's id here. Store it on your booking, for example
next to `opsAgentCode`, and use it for every later call.

## 4. A booking, mapped from yours

Send one booking per Love Kingdom booking that has boat items. Each `day_trip` / `private_own` /
`private_partner` item becomes one entry in `trips`. Leave out `hotel`, `third_party` and
`transfer` items, because they are not boat seats.

```json
POST /v1/bookings
{
  "external_id": "LOV-4190737",
  "agent_id": "a_b2c",
  "intent": "confirm",
  "leadPax": "Jane Doe",
  "leadPhone": "+66 81 234 5678",
  "leadEmail": "jane@example.com",
  "leadNationality": "GB",
  "pickupZone": "PK",
  "hotelName": "Blu Monkey Hub Hotel Phuket",
  "total": 4198,
  "trips": [
    { "routeId": "r10", "date": "2030-01-04", "pax": { "ad_fr": 2, "chd_fr": 1 }, "zone": "PK" }
  ],
  "passengers": [
    { "name": "Jane Doe", "nationality": "GB" },
    { "name": "John Doe", "nationality": "GB" },
    { "name": "Amy Doe", "nationality": "GB" }
  ],
  "addOns": [
    { "type": "longtail-join", "label": "Longtail Join (2A + 0C)", "amount": 800, "qty": 1, "jAd": 2, "jChd": 0 }
  ]
}
```

| Love Kingdom | Send as | Notes |
|---|---|---|
| `id` (`LOV-…`) | `external_id` | Must be unique. See §7, "Retries". |
| "Confirm" or "Save as quote" | `intent`: `confirm` (default) or `quote` | **Don't send `status`.** We decide it and return it; read `status` from the response. The old `status` field still works for now but is deprecated and logged. See below. |
| channel → `opsAgentCode` | `agent_id` | We key agents by **id** (`a_b2c`), not code, and agent codes are not unique. Map each channel to an agent id from `GET /v1/agents`. |
| `customer.name/phone/email/nationality` | `leadPax`, `leadPhone`, `leadEmail`, `leadNationality` | |
| item `programId` / `opsRouteId` | `trips[].routeId` | Must exist in `GET /v1/routes`, else `400 Unknown route`. |
| item `travelDate` | `trips[].date` | `YYYY-MM-DD`. Send the string, never a JS `Date`. |
| `paxAdult/Child/Infant/Foc` + `paxThai/paxForeign` | `trips[].pax` | Grid of `ad`/`chd`/`inf`/`foc` × `_fr` (foreign) / `_th` (Thai). Infants and FOC take seats. An unknown key is a `400`. See §6. |
| why FOC passengers are free | `focReason` | **Required** when you confirm a booking with `foc` passengers, else `400`. |
| `pickupZone`, `pickupHotel` | `trips[].zone`, `hotelName` (`pickupZone` on the header too) | |
| `addonsSelected[{addonId,qty}]` | `addOns[{type,amount,qty}]` | `type` is the ops code (`longtail-join`, `transfer-<route>-<zone>-<vehicle>`, `b2c-…`). `amount` is the **line total**, not a unit price. |
| `passengers[{name,nationality}]` | `passengers[{name,nationality}]` | `passport`, `dob` and `remark` have no home here and are dropped. |
| `total` | `total` | THB, as a number. Kept as you send it: your bookings are B2C (agent `a_b2c`), which this service does not re-price, unlike staff bookings. The add-on `amount`s are kept too. |
| private charter item | `trips[].bookingMode: "charter"` + `charterBoatId` | The boat must be deployed that day. |

Fields not in the README's "Booking header fields" table are **dropped, not stored**. If you need
one kept, ask for it to be modelled.

**The status in the response is ours, and it may not be `confirmed`.** With `intent: confirm` you get:

| `status` | Why | Seats |
|---|---|---|
| `confirmed` | it fitted | held |
| `pending_foc` | it has FOC passengers; ops approve them | held |
| `pending_approval` | it carries a discount; the salesperson approves it | held |
| `pending_approval` | the day's seats on sale are gone, but the boat has registered seats left; ops decide | **not held** (`allocated_pax: 0`) until approved |

`approvals` on the booking says what it waits for. Show the customer "waiting for confirmation"
for any `pending_*` status, and read the booking again later (`GET /v1/bookings/{id}`) to see
the decision: `confirmed`, or `rejected`.

## 5. Flows

### CS (staff booking for a customer)

1. `GET /v1/availability` for the date. Show `available_seats`. It is `null` on a land route
   (`unlimited: true`): there is no seat limit to show.
2. Staff saves → `POST /v1/bookings` with `intent`. On `201`, store our `id` and show our
   `status` (§4). On `409`, show "sold out" and nothing is written.
3. An edit to date or pax → `PATCH /v1/bookings/{id}` with the full `trips`. It is weighed
   again: `409` if it no longer fits at all, or `200` with `status: pending_approval` if it now
   needs ops to approve it.
4. A cancel in Love Kingdom → `POST /v1/bookings/{id}/cancel` with
   `{ "category": "customer_cancel", "charge_type": "none" }`.

### B2C website (customer pays online)

The order is: hold the seats, take payment, then book from the hold.

1. **Customer clicks "Pay"** → `POST /v1/seat-locks`
   `{ "route_id": "r10", "service_date": "2030-01-04", "pax": 3, "agent_id": "a_b2c" }`.
   - `201` gives a lock `id`. Keep it with the PayPal order.
   - `409` means sold out, or (`code: "route_closed"`) the trip does not run that day. Don't send
     them to PayPal.
2. **Payment captured** → `POST /v1/bookings`, with the trip drawing on the lock:
   `"trips": [{ "routeId": "r10", "date": "2030-01-04", "pax": { "ad_fr": 2, "chd_fr": 1 }, "lockDraws": { "<lock id>": 3 } }]`.
   Then `POST /v1/seat-locks/{lockId}/release` to free anything left over. That is a no-op when
   every seat was drawn.
3. **Payment failed, cancelled or abandoned** → `POST /v1/seat-locks/{lockId}/release`.

**Locks do not expire.** A lock you never release holds its seats forever, and ops will see a
sold-out day that isn't. You need a sweeper that releases locks whose payment never completed,
for example after 30 minutes.

## 6. Errors

Every error is JSON: `{ "statusCode", "error", "message", "code"? }`. `message` names the field,
for example `addOns[2].amount must be a number` or `trips[0].pax.adult is not a passenger category`.

| Status | Meaning | What to do |
|---|---|---|
| `400` | Bad input: missing field, unknown route or lock, bad pax key, a `status` other than `quote`/`confirmed`, FOC without `focReason` | Bug in the mapping. Log the `message`, and don't retry. |
| `401` / `403` | No token or an expired one (`401`); a call your service user may not make (`403`) | Log in again on `401`. A `403` is a bug in the mapping: log the `message`. |
| `404` | Booking or lock id not found | |
| `409` | The route does not run that day (`route_closed`), seats held by other agents' locks, the boat's registered seats full, lock short, boat already chartered, already cancelled | Sold out, closed, or the state changed. Show it to the user, and don't retry blindly. |
| `5xx` | Our fault | Retry with backoff. See §7 before retrying a create. |

## 7. Known gaps, read before going live

- **Retrying a create.** If `POST /v1/bookings` times out, resend it with the same `external_id`.
  If the first one was written, the retry answers `409` with `code: "duplicate_external_id"` and
  the message `external_id LOV-… is already booking booking_…`: read that booking with
  `GET /v1/bookings/{id}` instead of creating it again. Nothing is written twice.
- **Thai/foreign split.** You store `paxThai` / `paxForeign` as totals, while we need them per
  category (`ad_th` vs `chd_th`). If you can't split them, send the untiered keys (`ad`, `chd`,
  `inf`, `foc`) and agree the rule with ops.
- **Add-on price and code.** `addonsSelected` carries your `addonId` and no price. You need to
  send our `type` code and the line `amount`. Agree the code list with ops.
- **CS agent.** Your channels (Facebook, Line, Walk-in, …) are contact channels, not agents. Decide
  with sales which `agent_id` each one books under.
- **No payments here.** Deposits, slips and refunds stay in Love Kingdom. Cancellation charges are
  recorded on our side for ops only.

## 8. Test checklist

1. Get a test token: `POST /v1/login`.
2. `GET /v1/routes` and `GET /v1/agents`, then build your two mapping tables.
3. Create a booking and check `GET /v1/availability` dropped by its pax.
4. Fill a day's seats on sale, create one more, and expect `201` with `status: pending_approval` and
   `allocated_pax: 0` (or `409` when the boat has no registered seats beyond those on sale).
5. Create with a `foc` passenger and no `focReason`, and expect `400`.
6. Lock → book with `lockDraws` → release, and check `locked_pax` returns to 0.
7. Cancel, and check the seats come back.
