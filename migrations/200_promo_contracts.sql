-- Promo contracts are written here (todo/contracts-model.md, "Design — promo writes"): legacy's
-- `ctSaveAddPromo` and `ctVoidContract`. A void records who and when, as legacy's browser wrote
-- (`voidedBy`, `voidedDate`) and its storage dropped. The two promos legacy voided have neither.

ALTER TABLE contracts
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by TEXT,
  ADD CONSTRAINT contracts_voided_only_void CHECK (voided_at IS NULL OR status = 'void');
