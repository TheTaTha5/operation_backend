# Contracts: what is still open

Built: migration 029, `GET /v1/contracts`, `GET /v1/contracts/{id}`, `npm run import:contracts`
(README → "Contracts"). These are for the pricing steps (`pricing-model.md`).

- **Main contracts are frozen snapshots.** Legacy made them once (2026-07-23); renewals since change
  only the agent's fields (74 agents' dates and 259 agents' rate types differ from their main
  contract). A discount promo prices from the main contract's rate (`laPromoMainRt`: the **first**
  main in legacy's list, whatever its status, else the agent's rate). Legacy loads contracts ordered
  by `id` (`os_repo.js` `§stableOrder`), so "first" is the smallest id, and an archived `ct_hist_…`
  sorts before `ct_main_…`. Copied as decided: the quote orders by id the same way.
- **Main contracts drift from their agent** (259 rates, 73 end dates): decided 2026-10-09 to copy
  legacy, so the agent's `contract_*` fields are the truth for the Agents screen and a renewal makes
  no contract row (`sales-editing-model.md` 6). A rate change syncs the active main contract's rate.
- **`import:contracts` reruns** overwrite a main contract's rate and `doc_id`, which are set here now:
  make it seed-only like the agents import (`sales-editing-model.md`, Flagged).
- **Writes** (the promo form, `ctSaveAddPromo`: `POST`/`PATCH /v1/contracts`, area `sales`) come
  with the quote, with legacy's warning when an edited promo was already sold.
- `booking_trips.promo_id` (legacy `trip.promoId`; no legacy trip uses it yet) arrives with step 5.

## Design — promo writes (feat/sales-extras, 2026-10-10)

Legacy (wt-lk-inbox@658298d, `08-app.js`): `ctOpenAddPromo`/`ctSaveAddPromo` (the promo form, add and
edit), `ctVoidContract`, `_ctContractStatus` (the badge), `laPromoStat` (buy N get one free
progress), and the pricing `laPromo*` that `priceBooking` already copies (unchanged here). Legacy has
4 promos today: 2 void, 1 `rate`, 1 `own`; none with a bonus.

**The form, as legacy saves it.** One travel window (`active_from`..`active_to`) and an optional
booking window; each picked route becomes a period `{book_from: book_from || active_from, book_to:
book_to || active_to, travel_from: active_from, travel_to: active_to}`; `book_window` is set when
either booking date is given. `version` is `promo-<active_from>`, `status` `active`, `priority`
defaults to 10, `created_date` today, `created_by` the login. An edit replaces the form's fields
and keeps id, agent, version, status, created and `doc_id`.

Legacy's checks, kept: travel dates required and in order; booking dates in order when both are
given; at least one route; `rate` needs a rate type; `own` keeps only zones (`PK`, `KL`,
`NoTransfer`) with an adult price above 0 and needs at least one; `discount` needs a value above 0,
a percentage below 100, and an amount below the cheapest adult price above 0 the main rate has on
the picked routes; bonus `buy` ≥ 1 (free is always 1; basis `adchd` or `ad`). Legacy's three confirms
become flags: routes without an own price, or with no main rate to discount, are `409
routes_unpriced` until `unpriced_anyway: true`; editing a promo that bookings were sold with is
`409 promo_sold` until `sold_anyway: true`. Routes offered are the agent's programmes, its main
contracts' routes and (on an edit) the promo's own; another is `400`.

| Field | Authority |
|---|---|
| `price_mode`, `rate_type_id`, `seat_prices`, `discount`, `bonus`, `active_from`, `active_to`, booking window, routes, `priority`, `note` | validated (the checks above) |
| `id`, `agent_id` (after create), `kind`, `version`, `created_date`, `created_by`, `doc_id` | computed / kept; `PATCH` may echo them, not change them (`400`) |
| `status` | changed only by `POST /v1/contracts/{id}/void` |
| `voided_at`, `voided_by` | computed by the void (legacy writes `voidedDate`/`voidedBy`; its storage dropped them) |
| `state` | computed: `void`, `expired` (past `active_to`), `scheduled` (before `active_from`), else `active` (`_ctContractStatus`) |
| `bonus_progress` | computed (`laPromoStat`), on a promo with a bonus that is not void |

```sql
-- 200_promo_contracts.sql
ALTER TABLE contracts
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by TEXT,
  ADD CONSTRAINT contracts_voided_only_void CHECK (voided_at IS NULL OR status = 'void');
```

Contract (writes area `sales`; a sales-bound login only for its own agents, `403` otherwise):

- `POST /v1/contracts` → `201` and the contract:

```jsonc
{ "agent_id": "a06", "price_mode": "discount", "discount": { "mode": "pct", "value": 10 },
  "active_from": "2026-11-01", "active_to": "2027-03-31", "book_from": "2026-10-10", "book_to": "2026-10-31",
  "route_ids": ["r10", "r12"], "bonus": { "buy": 10, "basis": "adchd" }, "priority": 10, "note": "Xmas Promo" }
```

  `price_mode: "rate"` takes `rate_type_id`; `"own"` takes `seat_prices` (the read's shape:
  `[{ route_id, zone, category: "ad"|"chd", residency: "thai"|"foreign", price }]`).
- `PATCH /v1/contracts/{id}`: any of those fields (not `agent_id`); what is not sent is the stored
  promo's, and the whole promo is checked again. `400` on a main contract (it follows its agent:
  `/v1/agents/{id}/rate-type`, `/renew`); `409 contract_void` on a void one; unchanged → `200`, nothing
  written.
- `POST /v1/contracts/{id}/void` → the contract, `status: "void"`; `409 contract_void` when it already
  is, `400` on a main contract. Pricing skips it from then on; trips already sold keep their price.
- Reads (`GET /v1/contracts`, `/{id}`) add `voided_at`, `voided_by`, `state` and `bonus_progress`:

```jsonc
"bonus_progress": { "buy": 10, "basis": "adchd", "sold": 23, "bookings": 4, "earned": 2, "used": 1,
                    "left": 1, "over": 0, "to_next": 7, "pct": 30 }
```

Errors: `{ "statusCode": 409, "code": "routes_unpriced", "message": "1 route has no promo price (Phi Phi Island): it sells at the standard rate. Send unpriced_anyway: true to save anyway." }`;
`{ "statusCode": 409, "code": "promo_sold", "message": "This promotion has been sold on 3 trips. Their prices stay as sold; reports compare against the new terms. Send sold_anyway: true to save anyway." }`.

The agent's activity gets `Promotion added · …`, `Promotion edited · …`, `Promotion void · …` (kind
`contract`); legacy wrote none.
