# Server-side pricing, modelled

- **Source:** wt-lk-inbox@658298d — `08-app.js` `bkV2CalcQuote`, `_bkV2CalcQuoteRun`,
  `_bkV2TripSubtotalRun`, `bkV2GetRTForTrip`, `bkV2RtKeptFor`, `laMainRtFor`, `laSeasonAt`,
  `laPromoFor`, `laPromoRate`, `laPromoMainRt`, `bkV2AddOnInfo`, `bkV2AddOnRT`, `bkV2ApplyAgentRules`,
  `bkV2AddAdjustment`; `db/migrations/029_b2b_promo_own_pricing.sql`;
  `os-backend/src/mapping/field_mapping.json`; `server.js` `b2cAddonCatalog`.
- **Already here:** rate types (022, `todo/rate-types-model.md`), imported 84 of 84. Every price
  field on a booking is still taken from the client: the exception CLAUDE.md writes down.

## How legacy prices a booking

1. **Manual mode** (`price_mode = 'manual'`): total = `max(0, manual_total)`, nothing computed.
   - Only for house accounts: walk-in, staff, company. Company is always manual.
   - Staff inspection is manual at 0; staff welfare uses the `rt_staff` rate.
   - B2C bookings are always manual: B2C's own amounts are kept.
2. **The rate for each trip:** on an edit with the same route and date, the rate stamped at the last
   save; else the agent's **rate season** covering the travel date; else the agent's rate type. A
   **promo** is laid on top.
3. **Seat trip:** `seatRates[route][zone]`.
   - `adult-fr × (ad_fr || ad) + child-fr × (chd_fr || chd) + adult-thai × ad_th + child-thai × chd_th`.
   - Plus the longtail bundle when it applies. Infants and FOC pay 0; an overnight return leg is 0.
4. **Charter trip:** `charterRates[route][boat type]`.
   - `starterPrice + max(0, pax − starterIncludes) × extraPerPax`, plus the bundle.
   - A manual charter price overrides it.
5. **Add-ons:** longtail join and private transfers from the rate (season rate, never the promo).
   Custom add-ons are 0. B2C add-ons keep B2C's price.
6. **Adjustments:** `base = seat + addOn`.
   - Discounts are `%` of base or an amount; extras are an amount, plus overnight charges.
   - `total = max(0, base − discount + extra)`. `focDiscount` is shown, never subtracted.
   - A discount on confirm needs approval (built here, phase 2).

## What the server is missing

| Data | State | Where it is |
|---|---|---|
| agent rate seasons `[{rt, from, to}]` | **lost on legacy's server** (relational mode drops them) | only in browsers' localStorage `loveandaman_v2` (`sb_agents[].rateSeasons`, `sb_agents_rate_bindings`) |
| promo contracts | in legacy's DB | `sb_contracts` (`kind = 'promo'`), `sb_contracts__programperiods` |
| main contracts (rate type per agent) | in legacy's DB | `sb_contracts` (`kind = 'main'`) |
| adjustments `{kind, mode, value, label, note}` | dropped by our booking save | — |
| per-trip `rt_ref`, `promo_id`, `ovn_charge`, charter manual price | not columns here | `promo_id` in `sb_bookings__trips`; `rt_ref` lost by legacy too |
| B2C add-on prices | Love Kingdom's DB | `program_own_addons` |

## Proposal, in order (each its own approval and branch)

1. **Contracts:** `contracts` (main and promo) and `contract_program_periods`, imported from
   `sb_contracts`. Read endpoints.
2. **Agent rate seasons:** `agent_rate_seasons (agent_id, rate_type_id, from_date, to_date)` plus
   write endpoints (area `sales`). The data must first be **exported from a browser** that has it:
   a one-off script run in legacy's console, its JSON imported here. Before that, ask which browser
   holds the true copy.
3. **Adjustments:** `booking_adjustments (booking_id, seq, kind discount|extra, mode amount|percent,
   value, label, note)` — a client fact; the discount it yields is computed.
4. **`POST /v1/quote`:** the booking body in, the price out — `{trips: [{subtotal, rate_type_id,
   promo_id}], seat, add_on, foc_discount, discount, extra, total}`. One pure function
   `priceBooking(input, catalogue)` that both stores call. **Characterization test:** re-price
   real legacy bookings and expect their stored `priceBreakdown`, apart from the bugs below.
5. **Bookings priced by the server:** `total` and the price fields become computed. `PATCH` sending
   a different one is `400`, except `price_mode = 'manual'` for house accounts (who may: `sales`).

Also, as soon as the import has run on Railway: `agents.rate_type_id` → foreign key to
`rate_types (id)` (017 left it out). Data check first:
`SELECT count(*) FROM agents a WHERE rate_type_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rate_types r WHERE r.id = a.rate_type_id)`.

## Legacy bugs — copy or fix?

1. **Pax counting:** seats use `ad_fr || ad`, so a booking with both `ad_fr` and `ad` prices only
   `ad_fr`. Charter and bundle counts add both.
2. **`focDiscount` is never subtracted**, though it is in the breakdown.
3. **A FOC booking skips the discount approval** (it saves `pending_foc`). This service already asks
   for both.
4. **Discount promos check one rate and price from another** (`laPromoHasRate` ignores the date).
5. **The kept rate falls back after a reload** (`rtRef` is not stored).

## Questions

1. Order 1 → 5 as above? Contracts first because they are importable now; seasons need the browser
   export.
2. For each bug above: copy (the characterization test then matches legacy exactly) or fix?
   Recommended: fix 1, 4 and 5; keep 2 as legacy (it is display only); 3 is already decided.
3. **Who exports the rate seasons,** and from which browser?
