-- Remove the deprecated legacy namespace.
--
-- `operation_schemas` is the single schema the legacy monolith keeps all 103 of its tables in. This
-- database only ever received its `users` login table, created when that app was briefly pointed here;
-- the legacy system runs against its own database and nothing in this service reads the schema. It was
-- verified empty (0 rows) with no foreign keys referencing it from outside before this ran.
--
-- Destructive and not repeatable, so it depends on the schema_migrations ledger to run exactly once.
DROP SCHEMA IF EXISTS operation_schemas CASCADE;
