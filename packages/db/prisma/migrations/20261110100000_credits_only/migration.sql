-- Only credits bound a task (owner's decision of 10.11.2026, docs/spec.md §20, «Только кредиты»,
-- КР5–КР8). A pass is charged what its work took, and what the accounts could not pay is the
-- workspace's debt: it stands on the pack account and the next grant pays it first. A turn key
-- holds what the customer can pay: no limit of 750 RUB, only what the column holds.
BEGIN;

ALTER TABLE "billing_accounts" ADD COLUMN "debt" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "billing_accounts"
  ADD CONSTRAINT "billing_accounts_debt_check"
  CHECK ("debt" >= 0 AND "debt" = trunc("debt") AND ("debt" = 0 OR "unit" = 'credit_pack'));

ALTER TABLE "llm_keys" DROP CONSTRAINT "llm_keys_budget_check";
ALTER TABLE "llm_keys"
  ADD CONSTRAINT "llm_keys_budget_check" CHECK ("budget_rub" > 0);

COMMIT;
