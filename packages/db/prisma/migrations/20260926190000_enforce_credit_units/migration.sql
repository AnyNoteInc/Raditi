-- Keep the applied init migration immutable. Backfill existing holds from their accounts
-- before enforcing matching units and whole edits (spec §16, §17).
BEGIN;

ALTER TABLE "credit_holds" ADD COLUMN "unit" "BillingUnit";

UPDATE "credit_holds" AS hold
SET "unit" = account."unit"
FROM "billing_accounts" AS account
WHERE hold."account_id" = account."id";

ALTER TABLE "credit_holds"
  ALTER COLUMN "unit" SET NOT NULL,
  DROP CONSTRAINT "credit_holds_account_id_fkey",
  ADD CONSTRAINT "credit_holds_account_id_unit_fkey"
    FOREIGN KEY ("account_id", "unit") REFERENCES "billing_accounts"("id", "unit")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "credit_holds_edit_whole_check"
    CHECK ("unit" <> 'edit' OR "amount" = trunc("amount"));

-- Both the movement and the resulting balance are whole numbers for edit accounts.
ALTER TABLE "credit_ledger"
  DROP CONSTRAINT "credit_ledger_edit_whole_check",
  ADD CONSTRAINT "credit_ledger_edit_whole_check"
    CHECK ("unit" <> 'edit' OR (
      "amount" = trunc("amount") AND "balance_after" = trunc("balance_after")
    ));

COMMIT;
