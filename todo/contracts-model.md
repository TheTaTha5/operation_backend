# Contracts: what is still open

Built: migrations 029 and 200, the reads, promo writes (`POST`/`PATCH /v1/contracts`,
`POST /v1/contracts/{id}/void`, legacy's `ctSaveAddPromo` and `ctVoidContract`, decided 2026-10-10),
and `npm run import:contracts -- --seed`, seed-only (README → "Contracts"; `src/domain/contract-writes.ts`).

- **Main contracts are frozen snapshots.** Legacy made them once (2026-07-23); renewals since change
  only the agent's fields (74 agents' dates and 259 agents' rate types differ from their main
  contract). A discount promo prices from the main contract's rate (`laPromoMainRt`: the **first**
  main in legacy's list, whatever its status, else the agent's rate). Legacy loads contracts ordered
  by `id` (`os_repo.js` `§stableOrder`), so "first" is the smallest id, and an archived `ct_hist_…`
  sorts before `ct_main_…`. Copied as decided: the quote and the promo checks order by id the same way.
- **Main contracts drift from their agent** (259 rates, 73 end dates): decided 2026-10-09 to copy
  legacy, so the agent's `contract_*` fields are the truth for the Agents screen and a renewal makes
  no contract row (`sales-editing-model.md` 6). A rate change syncs the active main contract's rate.
- `booking_trips.promo_id` (legacy `trip.promoId`; no legacy trip uses it yet) arrives with step 5.
- **`bonus_progress.used`** is legacy's guess: every FOC seat on the promo's trips, whatever the
  reason. Tying an FOC seat to the promo that earned it would need a field on the booking; legacy
  chose not to.

## Flagged

Decisions made while building the promo writes (each defaults to legacy where legacy had a rule):

- **Confirms became flags:** a route with no own price, or no main-contract price to discount, is
  `409 routes_unpriced` until `unpriced_anyway: true`; editing a promo trips were sold with is
  `409 promo_sold` until `sold_anyway: true`. A `PATCH` that changes nothing writes nothing and
  does not ask (legacy asked on every save).
- **Stricter than the form:** an own price that is negative or not a number is `400` (legacy skipped
  the cell silently); a price for a route not picked is `400` (legacy's table only showed picked
  routes); a route outside the agent's programmes and main contracts is `400` (legacy's picker); a
  `priority` below 1 is `400` (legacy read 0 as 10); a booking start after the last travel date
  with no booking end is `400` (legacy saved a window that could never match); a mode's fields sent
  with another mode are `400`.
- **Kept as legacy:** a `rate` promo may use any rate type (legacy's picker was not scoped by owner);
  a zone with no adult price above 0 is not saved; the discount checks read the main rate without a
  date (`laPromoMainRt(agentId)`), while pricing uses the season of the travel date.
- **New:** `voided_at`/`voided_by` are stored (legacy's browser set them, its storage dropped them);
  each add, edit and void writes a line to the agent's activity (legacy wrote none); `state` and
  `bonus_progress` are computed here (legacy drew them in the browser).
- **`import:contracts`** writes nothing without `--seed`. `--seed` is legacy-wins as before, except
  that a void made here keeps its stamp only while legacy's row is void too (else the `CHECK` on
  `voided_at` would fail). Rehearsed 2026-10-10: 918 contracts, 3,242 periods, 16 own prices.
