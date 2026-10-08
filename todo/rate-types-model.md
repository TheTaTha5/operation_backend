# Rate types: what is still open

Rate types exist: migration 022, the endpoints and the importer (`README.md`, "Rate types").

## To do

Run the import in production, then add the foreign key (it cannot ship before):

```sql
ALTER TABLE agents ADD CONSTRAINT agents_rate_type_fk FOREIGN KEY (rate_type_id) REFERENCES rate_types (id);
```

## Open

1. **Lost prices are re-entered by hand** (agreed 2026-10-07): RN prices, longtail charter rows,
   transfer prices outside r4/5/6/10/11/12, every bundle's `applies_to`. The data that does exist
   shows where to look: the 4 Ranong route rows, the 2 `paid` bundles.
2. **Agent rate seasons live only in browsers.** Sales re-enter them once the endpoints exist
   (`pricing-model.md`, step 2).
3. **Custom add-ons:** keep (priced once a quote exists) or drop? Left out until decided.
4. **`nationality_scope` does not restrict pricing in legacy** (spec Q2). Decided with the quote.

## Pricing a booking still needs

In order (`pricing-model.md` owns the design):

1. `agent_rate_seasons` and `PUT /v1/agents/{id}/rate-seasons`.
2. Promo contracts (`sb_contracts` with `pricemode`, `rates`, `discount`, `bookwin`, and
   `__programperiods`).
3. `POST /v1/quote`: a pure `src/domain/pricing.ts` called by both stores, then used by
   `POST /v1/bookings` and the pricing-relevant `PATCH`es, storing per-trip `subtotal`,
   `rate_type_id` and `promo_id` (columns that do not exist yet).
4. `POST /v1/rate-types/{id}/clone`, agent binding (`POST /v1/rate-types/{id}/agents`), the add-on
   type catalogue, the B2C rate endpoints (`/api/b2c/rate-types`, `/routes`, `/availability`).
