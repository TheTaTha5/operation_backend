# Booking extras: what is still open

All four parts are built (migrations 040–043; README → "Attachments", "Allergy list and pier meals",
"Document check", "Pickup areas and pickup times"). Git history has the design.

## Open

1. **The other payment slips** (booking `paymentSlips`, pier payments, on-tour extras, invoice
   payments, cash-on-tour) and the fleet project documents come with their owners; their files are
   already copied by `import:attachments`.
2. **Validate the booking area foreign keys** on Railway once the import has loaded the areas:
   `ALTER TABLE bookings VALIDATE CONSTRAINT bookings_pickup_area_fk` (and `bookings_dropoff_area_fk`).
3. **Alternate pickups and van stops** keep plain area ids, not checked against the catalogue.
4. **Changing a booking's area** doesn't redo its trips' pickup times already set; legacy re-derives
   unless a time was edited by hand, a flag it never saved.
5. **Legacy flaws kept as-is** (decision D3): `pk-bangnon` duplicates `rn-bangnon`; trailing spaces in
   one region and one time group. Love Kingdom's area matcher strips the letter "s" (`/s+/g`), in
   their repo.
