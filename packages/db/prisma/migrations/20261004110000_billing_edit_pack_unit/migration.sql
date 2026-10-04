-- A workspace gets a second edit account (docs/plan/37-billing-plan.md, «Модель данных»):
-- 'edit' holds the edits of the tariff, granted anew every period, and 'edit_pack' the edits
-- bought as a pack, which never expire. No row is changed.
--
-- Alone in its migration: PostgreSQL refuses to use a new enum value in the transaction that
-- added it, and the CHECK constraints of the next migration name it.
ALTER TYPE "BillingUnit" ADD VALUE 'edit_pack';
