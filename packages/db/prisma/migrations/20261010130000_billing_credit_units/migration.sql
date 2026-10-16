-- The unit of billing is the credit (docs/plan/37-billing-plan.md, «Кредиты вместо правок»;
-- spec §16, §17): the two accounts of a workspace are 'credit_tariff' — granted anew every
-- period — and 'credit_pack' — bought as a pack, never expiring; a plan counts its monthly
-- credits, the tasks it takes a day and the credits of a pack.
--
-- Names only: no row, no number and no rule changes. The CHECK constraints keep their
-- expressions — PostgreSQL stores a label and a column by their identity, not by their text,
-- so the whole-number checks and the two checks of "plans" follow the renames by themselves.
-- The directory 20261004110000_billing_edit_pack_unit keeps the old word: applied migrations
-- are not renamed.
--
-- One transaction: Prisma sends a migration statement by statement, and a database must never
-- be left with one half of the names.
BEGIN;

ALTER TYPE "BillingUnit" RENAME VALUE 'edit' TO 'credit_tariff';
ALTER TYPE "BillingUnit" RENAME VALUE 'edit_pack' TO 'credit_pack';

ALTER TABLE "plans" RENAME COLUMN "edits_per_month" TO "credits_per_month";
ALTER TABLE "plans" RENAME COLUMN "edits_per_day" TO "tasks_per_day";
ALTER TABLE "plans" RENAME COLUMN "pack_edits" TO "pack_credits";

ALTER TABLE "billing_accounts"
  RENAME CONSTRAINT "billing_accounts_edit_whole_check" TO "billing_accounts_credit_whole_check";
ALTER TABLE "credit_holds"
  RENAME CONSTRAINT "credit_holds_edit_whole_check" TO "credit_holds_credit_whole_check";
ALTER TABLE "credit_ledger"
  RENAME CONSTRAINT "credit_ledger_edit_whole_check" TO "credit_ledger_credit_whole_check";

COMMIT;
