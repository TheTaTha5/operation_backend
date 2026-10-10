-- Why a company booking was made (todo/booking-model.md, decided 2026-10-10): legacy `bkV2Save`'s
-- `companyPurpose`, required on every booking for agent `a_company` ("Please choose a reason for this
-- company booking"), the three reasons its form offers. A client fact.
--
-- Legacy stores no `companypurpose` column: it writes the reason into `purpose` for a company booking.
-- Legacy, 2026-10-10: 2 company bookings, `company_guest` and `company_special`; the import copies them.

ALTER TABLE bookings ADD COLUMN company_purpose TEXT
  CHECK (company_purpose IN ('company_guest', 'pr_foc', 'company_special'));
