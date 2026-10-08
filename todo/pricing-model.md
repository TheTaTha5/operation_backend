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

1. **Contracts:** built (README → "Contracts"); what they leave open is in `contracts-model.md`.
2. **Agent rate seasons:** `agent_rate_seasons (agent_id, rate_type_id, from_date, to_date)` plus
   write endpoints (area `sales`). Not imported: sales re-enter the seasons through these endpoints
   (decided 2026-10-09; legacy keeps them only in browsers' localStorage).
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

## Decided 2026-10-09

- **Order 1 → 5** as above.
- **Legacy's price bugs are copied**, so the re-price test matches legacy exactly: pax counted from
  `ad_fr || ad` (a booking with both prices only `ad_fr`; charters and bundles add both),
  `focDiscount` shown but never subtracted, discount promos checking one rate and pricing from
  another (`laPromoHasRate` ignores the date), and the kept rate falling back after a reload
  (`rtRef` not stored). Fixing them is a later, separate decision. (A FOC booking already asks for
  the discount approval here too; that stays.)
- **Rate seasons are re-entered by hand**, not exported from a browser.
