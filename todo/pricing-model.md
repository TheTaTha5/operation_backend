# Pricing: what is still open

The server prices bookings (README → "Prices", "Quote"); `priceBooking` copies legacy's rule, proven
on 4,352 of legacy's own bookings.

- **`agents.rate_type_id` → foreign key to `rate_types (id)`**, as soon as the import has run on
  Railway. Data check first:
  `SELECT count(*) FROM agents a WHERE rate_type_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rate_types r WHERE r.id = a.rate_type_id)`.
- **Add-on labels** are still the client's; legacy writes them from its add-on catalogue
  (`bkV2AddOnInfo`), which has no home here yet.
- **`rate: "agent"` does not change `rate_type_ref`**: the trips' `rate_type_id` record the new rate,
  the booking keeps the one it was made with.
- **B2C add-on prices** live in Love Kingdom's database (`program_own_addons`); not needed while B2C
  prices stay as sent.
- **Legacy's price quirks** `priceBooking` copies (decided 2026-10-09) are marked "legacy:" in its
  code. Fixing any of them is a later, separate decision; rebuild the proof after
  (`src/tools/build-quote-fixture.ts`).
