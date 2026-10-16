-- Gift credits are counted in whole credits, like the credits of the tariff and of a pack
-- (docs/plan/37-billing-plan.md, «Что меняется в базе»; spec §16): the three whole-number
-- checks are re-created for the three credit units. Roubles keep kopecks. No row is changed:
-- an account, a reserve or an entry of 'credit_gift' could not exist before the unit did, and
-- the rows of the other two units already pass the same expression.
--
-- One transaction: Prisma sends a migration statement by statement, and a constraint dropped
-- here must never be left without the one that replaces it.
BEGIN;

ALTER TABLE "billing_accounts"
  DROP CONSTRAINT "billing_accounts_credit_whole_check",
  ADD CONSTRAINT "billing_accounts_credit_whole_check"
    CHECK ("unit" NOT IN ('credit_tariff', 'credit_gift', 'credit_pack') OR ("balance" = trunc("balance") AND "held" = trunc("held")));

ALTER TABLE "credit_holds"
  DROP CONSTRAINT "credit_holds_credit_whole_check",
  ADD CONSTRAINT "credit_holds_credit_whole_check"
    CHECK ("unit" NOT IN ('credit_tariff', 'credit_gift', 'credit_pack') OR "amount" = trunc("amount"));

ALTER TABLE "credit_ledger"
  DROP CONSTRAINT "credit_ledger_credit_whole_check",
  ADD CONSTRAINT "credit_ledger_credit_whole_check"
    CHECK ("unit" NOT IN ('credit_tariff', 'credit_gift', 'credit_pack') OR (
      "amount" = trunc("amount") AND "balance_after" = trunc("balance_after")
    ));

COMMIT;
