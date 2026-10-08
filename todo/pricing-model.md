# Server-side pricing: what is left

Built: rate types, contracts, rate seasons, adjustments, and `POST /v1/quote` (README → "Quote"):
`priceBooking` in `src/domain/pricing.ts` computes a booking's price as legacy does, bugs included,
proven on 4,352 of legacy's own bookings (`test/quote-legacy.test.ts`). Every price field on a booking
is still taken from the client: the exception CLAUDE.md writes down. Step 5 ends it.

## Step 5: bookings priced by the server

- `total`, `price_seat`, `price_addon`, `price_foc_discount`, `price_discount`, `price_extra` become
  **computed** on create, on `PATCH` and on the commands that change trips or pax: `priceBooking`'s
  answer. A different value sent is `400` naming `POST /v1/quote`. `price_mode` and `manual_total`
  follow `enforcedPriceMode` (company and staff inspection by hand; a walk-in either; agents by rate).
- **Per trip, stored** (new columns): `subtotal`, `rate_type_id` (the rate it was priced at, so an
  edit keeps it per trip: decided 2026-10-09), `promo_id`, `ovn_charge`, `charter_price_mode`,
  `charter_price_manual`, `charter_price_note`. The quote already accepts them.
- An edit keeps the old rates unless the client asks `rate: "agent"` (legacy's "use today's rate").
- B2C bookings keep the price Love Kingdom sent (legacy never re-prices them): they stay client facts.
- The discount approval reads the computed discount.
- Fix migration 029's comment on `contract_seat_prices` (it says a missing cell falls back to the
  standard rate; legacy, and `priceBooking`, replace a promo's zone whole).
- Partial cancels keep legacy's "take the refund off the total".
- Love Kingdom: its bookings are B2C, so its contract does not change.

## Also

- As soon as the import has run on Railway: `agents.rate_type_id` → foreign key to
  `rate_types (id)`. Data check first:
  `SELECT count(*) FROM agents a WHERE rate_type_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rate_types r WHERE r.id = a.rate_type_id)`.
- B2C add-on prices live in Love Kingdom's database (`program_own_addons`); not needed while B2C
  prices are kept as sent.
- The bugs `priceBooking` copies (decided 2026-10-09) are listed in its comments ("legacy:"). Fixing
  any of them is a later, separate decision.
