-- A workspace gets a third credit account (docs/plan/37-billing-plan.md, «Порядок счетов и
-- правило списания»; spec §16): 'credit_gift' holds the credits given once at registration.
-- They never expire and are spent after the credits of the tariff and before purchased ones.
-- No row is changed.
--
-- Alone in its migration: PostgreSQL refuses to use a new enum value in the transaction that
-- added it, and the CHECK constraints of the next migration name it.
ALTER TYPE "BillingUnit" ADD VALUE 'credit_gift';
