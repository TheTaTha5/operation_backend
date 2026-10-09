# Booking extras, modelled: attachments, allergy list, document check, pickup areas

**Approved 2026-10-09**, with these answers:
- **A1:** files in PostgreSQL (`bytea`);
- **A2:** import the 5,890 referenced files;
- **A3:** any login may download;
- **B1:** keep the pier meal editor's `pierAt`/`pierBy`;
- **C1:** `verified` doesn't need all ticks;
- **C2:** keep the raw OCR text;
- **C3:** anyone may edit the note, as legacy;
- **D1:** the server fills a trip's pickup time and zone only when the client sends none;
- **D2:** deleting an area makes it inactive;
- **D3:** import the areas exactly as legacy has them;
- **D4:** import the old flat time table as an open-ended fallback profile.

The rest of the booking area. Each part is independent. Source: wt-lk-inbox@`658298d`, `allotment_v2/js/08-app.js` and `server.js`; counts
from legacy production, read-only, 2026-10-09.

## 1. Attachments

**Legacy.** One file store for everything. `server.js` keeps each file as a `bytea` row in
`allotment.attachments` (`id att_<time>_<hex>, booking_id, filename, mime, size, data, uploaded_by,
created_at`).
- `POST /api/attach` takes JSON `{bookingId, filename, mime, dataB64}`.
  - Limit: 6 MB.
  - Any mime type.
  - Any logged-in user who may edit.
- `GET /api/attach/:id` serves a file to any logged-in user.
- `DELETE` doesn't check whether anything still points at the file.

Records point at files through JSON lists of `{id, name, mime, size, …}`, with no foreign key:

| Who points at files | Records | Refs |
|---|---|---|
| Booking documents `bk.attachments` (`kind` upload/capture/paste, `by`, `at`) | 4,020 | 5,319 (10 missing) |
| Booking payment slips `bk.paymentSlips` (with `amount`) | 392 | 442 |
| Pier payments `bk.pierPayments[].slips` | 34 | 34 |
| Upgrade sales `upgrades[].slips` | 7 | 7 |
| On-tour extras `SB_EXTRAS[].slips` | 49 | 49 |
| Invoice payments `SB_PAYMENTS[].slips` | 354 | 375 |
| Cash-on-tour decisions `TS_COT[].slips` | 8 | 8 |
| Fleet projects `p.docs[].attId` | 9 | 58 |

- **Files:** 6,342, using 699 MB. JPEG 6,117 (666 MB; images are shrunk in the browser), PNG 214
  (all daily-report chart images, public, deleted after 120 days), PDF 11. The largest is 1.4 MB.
- **Orphans:** 248 files (38 MB) are referenced by nothing. 71 point at a booking id that doesn't
  exist (drafts upload under their code before the booking exists).

**Proposed.** One file table, and one reference table per owner (an owner-type column would lose
the foreign keys). This slice covers the booking's own documents and upgrade slips. The payment
slips come with the payments model, the fleet docs with fleet.

```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                       -- legacy's att_… ids kept
  filename TEXT NOT NULL, mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 6291456),
  data BYTEA NOT NULL,                       -- or a storage key: decision A1
  uploaded_by TEXT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE booking_documents (             -- legacy bk.attachments
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, attachment_id TEXT NOT NULL REFERENCES attachments (id),
  kind TEXT CHECK (kind IN ('upload', 'capture', 'paste')), by TEXT, at TIMESTAMPTZ,
  PRIMARY KEY (booking_id, seq)
);
CREATE TABLE booking_upgrade_slips (
  booking_id TEXT NOT NULL, upgrade_id TEXT NOT NULL, seq INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  PRIMARY KEY (booking_id, upgrade_id, seq),
  FOREIGN KEY (booking_id, upgrade_id) REFERENCES booking_upgrades (booking_id, id) ON DELETE CASCADE
);
```

**Contract.**
- `POST /v1/attachments` takes legacy's JSON `{filename, mime, data_b64}` and answers
  `201 {id, name, mime, size}`.
  - `400`: over 6 MB, or a type outside JPEG, PNG and PDF.
  - Area `operations` (or `pier` for slips).
- `GET /v1/attachments/{id}` returns the file itself.
- Bookings take `attachments: [{id, kind?}]`, and `upgrades[].slips: [{id}]`.
  - Both lists replace outright.
  - An unknown id is `400`.
  - The server fills `name`, `mime` and `size` from the file, and `by` and `at` when one is added.
- `DELETE /v1/attachments/{id}` refuses a file still referenced (`409 attachment_in_use`).

**Decisions.**
- **A1. Where the bytes live.**
  - **Postgres `bytea`, as legacy does (proposed):** simplest; one backup. 700 MB today, growing
    roughly 100 MB a month.
  - **Object storage** (a Railway volume or S3/R2 bucket): a key in the row.
- **A2. Import:** every referenced file (5,890, about 660 MB; proposed), leaving the 248 orphans and
  the chart images behind. Or start empty and keep legacy's server for old files.
- **A3. Who may download:** any login, as legacy (proposed), or the area that wrote it.

## 2. Allergy list

**Legacy.** `specialMeals.allergyList = [{name, qty}]`, beside the free-text `allergies`.
- **Column:** `specialmeals_allergylist`, since 2026-08-15.
- **Writers:** `bkV2AllergyAdd`, its preset buttons, `bkV2AllergySetQty` and `bkV2AllergyRemove`.
  Each enforces `name` not blank and `qty` a whole number ≥ 1; adding a name already listed (any
  case) adds to its qty.
- **Kitchen count (`bkV2AllergyCount`):** the sum of `qty`, or 1 when the list is empty but the
  free text isn't.
- **Data:** 29 bookings have a list (5,341 bookings): 25 with one entry, at most 5; qty 1, 2 or 4.
  Names are free text ("no spicy", Thai), so no fixed allergen list fits. qty never exceeds the
  trip's passengers.

**Proposed.** A booking field `allergy_list` (also legacy's `specialMeals.allergyList`), replacing
outright.
```sql
CREATE TABLE booking_allergies (
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, name TEXT NOT NULL, qty INTEGER NOT NULL CHECK (qty >= 1),
  PRIMARY KEY (booking_id, seq)
);
```
- **Kinds of field:** `name` and `qty` are client facts. `allergy_count` (on the read) is
  computed, by legacy's kitchen rule.
- **Refused (`400`):** a blank name; qty below 1.
- **Merged:** two entries with the same name (any case) become one, qty added, as the add
  button does.
- **Import:** the 29 lists.
- **Decision B1.** Legacy's pier meal editor also writes `pierAt`/`pierBy` (who changed the meals at
  the pier), and legacy has no column for them, so they're lost. Give them a home?

## 3. Document check

**Legacy.** `bk.docCheck`, B2B bookings only: staff compare the agent's attached document with the
booking.
- **Column:** `doccheck`, since 2026-07-03.
- **Shape:** `{status, by, at, note, items{route, date, lead, pax, voucher, payment}, pre}`.
- **Status:** `verified` or `issue` (`docCheckSetStatus`, which logs "Document check · ✅ verified"
  with tag `DocCheck`). `pending` is only a default.
- **`pre`:** the browser's own OCR of the image attachments (Tesseract), matched against the
  booking: per item `{s: match|maybe|mismatch|none, ev, detail}`, a summary, and up to 3,000
  characters of raw OCR text. It auto-ticks matching items.
- **Data:** 3,181 bookings; `verified` 3,151, `pending` 29, `issue` never used.
  - 11 are verified without all six ticks.
  - 3,131 have a pre-check.
  - 2,408 history lines.

**Proposed.** A fixed set of fields, so columns, in their own table (one per booking):
```sql
CREATE TABLE booking_doc_checks (
  booking_id TEXT PRIMARY KEY REFERENCES bookings (id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('pending', 'verified', 'issue')), by TEXT, at TIMESTAMPTZ, note TEXT,
  route_ok BOOLEAN NOT NULL DEFAULT false, date_ok BOOLEAN NOT NULL DEFAULT false, lead_ok BOOLEAN NOT NULL DEFAULT false,
  pax_ok BOOLEAN NOT NULL DEFAULT false, voucher_ok BOOLEAN NOT NULL DEFAULT false, payment_ok BOOLEAN NOT NULL DEFAULT false,
  pre_at TIMESTAMPTZ, pre_error TEXT, pre_text TEXT        -- pre_text: decision C2
);
CREATE TABLE booking_doc_check_results (     -- the pre-check, per item
  booking_id TEXT NOT NULL REFERENCES booking_doc_checks (booking_id) ON DELETE CASCADE,
  item TEXT NOT NULL CHECK (item IN ('route', 'date', 'lead', 'pax', 'voucher', 'payment', 'cot')),
  result TEXT NOT NULL CHECK (result IN ('match', 'maybe', 'mismatch', 'none')), evidence TEXT, detail TEXT,
  PRIMARY KEY (booking_id, item)
);
```
- `PUT /v1/bookings/{id}/doc-check/items/{item}` `{checked}`: area `operations`.
- `PUT /v1/bookings/{id}/doc-check/status` `{status, note?}`: the server stamps `by` and `at`, and
  logs legacy's line.
- `PUT /v1/bookings/{id}/doc-check/note` `{note}`.
- `PUT /v1/bookings/{id}/doc-check/pre`: the browser's OCR result, stored as sent (a client fact:
  the OCR runs in the browser).
- Every booking read carries `doc_check`, or `null`. The import brings all 3,181.

**Decisions.**
- **C1.** Must `verified` need all six ticks? Legacy doesn't (11 bookings).
- **C2.** Keep the raw OCR text (`pre.text`, up to 3,000 characters of a voucher, so names and
  numbers)? Proposed: no, keep only the per-item results.
- **C3.** Legacy lets anyone edit the note (no area guard). Require `operations` like the rest
  (proposed)?

## 4. Pickup areas and pickup times

**Legacy.** `SB_PICKUP_AREAS` (`sb_pickup_areas`).
- **Area:** `{id, name, zone PK|KL|RN|NoTransfer, region, timeGroup}`.
- **Edited on "Pickup time setup"** (area `operations`; `psuSaveArea`, `psuDeleteArea`):
  - The id is `<zone>-<name slug>` and never changes.
  - Delete is a hard delete; bookings keep their name and zone copies.
- **Pickup-time profiles** (`SB_PICKUP_TIME_PROFILES`): `{id, name, from, to, notes, clonedFrom,
  times[route][area or time group] = "HH:MM-HH:MM" | "Before HH:MM at pier"}`.
- **A trip's pickup time comes from** `bkV2GetPickupTime(route, area, date)`:
  1. the profile covering the date (the narrowest range wins, then the newest);
  2. in it, the area's own time, else its time group's;
  3. else legacy's older flat table.

  It's re-derived whenever the area or route changes, unless edited by hand. The "edited" flag is
  never saved.
- **The trip's price zone comes from the area's zone** (except a private van on a NoTransfer seat).
- **Data:**
  - **Catalogue:** 54 areas (PK 35, KL 12, RN 4, NoTransfer 3), 28 time groups.
  - **Profiles:** one, `prof-default-2026`, valid to 2027-05-15. It holds 390 time cells over 13 routes.
  - **Bookings:** 5,268 have an area id, and **none points outside the catalogue**. The README's
    examples (`pa_kata`) don't match legacy's ids (`pk-kata`).
  - **Replaying the time lookup on B2B trips:** 4,660 match what was stored, 63 differ (hand
    edits), and 46 stored nothing.
- **Legacy flaws found:**
  - Legacy's database has no time column for 6 areas (the four RN areas, `pk-bangnon`,
    `nt-grand-andaman-pier-s`), so their times can't be saved.
  - `pk-bangnon` duplicates `rn-bangnon`.
  - Love Kingdom's area matcher strips the letter "s" instead of spaces (`/s+/g`; their repo).

**Proposed.**
```sql
CREATE TABLE pickup_areas (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT NOT NULL CHECK (zone IN ('PK', 'KL', 'RN', 'NoTransfer')),
  region TEXT, time_group TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE pickup_time_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, from_date DATE NOT NULL, to_date DATE NOT NULL CHECK (to_date >= from_date),
  notes TEXT, cloned_from TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE pickup_times (                  -- one cell: a route and an area, or a time group
  profile_id TEXT NOT NULL REFERENCES pickup_time_profiles (id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES routes (id), target TEXT NOT NULL,   -- an area id or a time group
  pickup_time TEXT, pickup_time_end TEXT, pickup_at_pier BOOLEAN NOT NULL DEFAULT false,  -- the 024 window
  PRIMARY KEY (profile_id, route_id, target)
);
-- Bookings, trips' alternate pickups and van stops then point at pickup_areas (0 orphans today).
```

**Contract.**
- `GET`, `POST` and `PATCH /v1/pickup-areas`, with legacy's id rule.
- `GET`, `POST` and `PATCH /v1/pickup-time-profiles`, plus `PUT …/{id}/times/{route}/{target}` for
  one cell.
- `GET /v1/pickup-time?route_id=&area_id=&date=` answers legacy's lookup.
- On a booking save, a trip sent without a pickup time gets the derived one, and its zone from the
  area.

**Decisions.**
- **D1. Should the server derive pickup times and trip zones** (the rule moves out of the
  browsers), or keep them client facts with only the lookup endpoint?
  - Proposed: derive when the client sends none; never overwrite a sent time, as the "edited by
    hand" flag is lost.
- **D2. Deleting an area:** legacy hard-deletes. Proposed: `active: false`, as there would be
  foreign keys from bookings. Changes legacy's delete button.
- **D3. Clean-ups on import:**
  - keep `pk-bangnon` (2 bookings?) or merge it into `rn-bangnon`;
  - trim the trailing spaces;
  - store the 6 areas' times, which legacy couldn't.
- **D4. The flat legacy table** (3 routes) behind the profile. Import it as an open-ended
  fallback profile, or drop it now that a profile covers to 2027-05-15?

## Corrections to earlier notes

- `todo/booking-model.md` said `docCheck` is "dropped on every save". That's true here, not in
  legacy: legacy has stored it since 2026-07-03, and `allergyList` since 2026-08-15.
