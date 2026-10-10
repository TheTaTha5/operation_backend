-- A booking's readable number (todo/booking-model.md, decided 2026-10-10): legacy
-- `bkV2GenerateBookingCode`'s `BK-YYMM` + sequence, now numbered by the server per Bangkok month, as
-- invoice numbers are (045). Legacy's own code is its booking id (`BK-26100452-J6YM`), so an imported
-- booking keeps it: the import writes `code` = legacy's id, which is `external_id` here.
--
-- Legacy, 2026-10-10: 5,416 bookings, 4,840 with a `BK-YYMMNNNN-XXXX` id, the rest `b2c_…` and older
-- shapes; ids are unique, so the codes are.

-- The last sequence given per month, so two creates never get the same code.
CREATE TABLE booking_code_counters (
  year_month TEXT PRIMARY KEY CHECK (year_month ~ '^[0-9]{4}$'),   -- YYMM, as in BK-YYMMNNNN
  last INTEGER NOT NULL CHECK (last >= 0)
);

ALTER TABLE bookings ADD COLUMN code TEXT;

-- Imported from legacy: its id.
UPDATE bookings SET code = external_id WHERE id LIKE 'lg\_%' AND external_id IS NOT NULL;

-- Every other booking is numbered in the order it was made, within its Bangkok month, after the
-- highest sequence that month already has (legacy's included), as `nextBookingCode` numbers new ones.
WITH given AS (
  SELECT substr(code, 4, 4) AS ym, max((regexp_match(code, '^BK-[0-9]{4}([0-9]+)'))[1]::int) AS n
  FROM bookings WHERE code ~ '^BK-[0-9]{5}' GROUP BY 1
), numbered AS (
  SELECT id, to_char(created_at AT TIME ZONE 'Asia/Bangkok', 'YYMM') AS ym,
         row_number() OVER (PARTITION BY to_char(created_at AT TIME ZONE 'Asia/Bangkok', 'YYMM') ORDER BY created_at, id) AS rn
  FROM bookings WHERE code IS NULL
)
UPDATE bookings b
SET code = 'BK-' || n.ym || lpad((COALESCE(g.n, 0) + n.rn)::text, greatest(4, length((COALESCE(g.n, 0) + n.rn)::text)), '0')
FROM numbered n LEFT JOIN given g ON g.ym = n.ym
WHERE b.id = n.id;

INSERT INTO booking_code_counters (year_month, last)
SELECT substr(code, 4, 4), max((regexp_match(code, '^BK-[0-9]{4}([0-9]+)'))[1]::int)
FROM bookings WHERE code ~ '^BK-[0-9]{5}' GROUP BY 1;

ALTER TABLE bookings ALTER COLUMN code SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_code_unique UNIQUE (code);
