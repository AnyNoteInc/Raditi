-- The daily limit in credits (decision of the owner of 17.10.2026; docs/plan/37-billing-plan.md,
-- «Дневной лимит в кредитах»; spec §16, §17). A tariff gives a Moscow day a number of its
-- credits: «Старт» 50, «Бизнес» 100, «Агентство» 300. Gift and pack credits are outside it.
--
-- `plans.credits_per_day` is that number; NULL: no daily cap. It is filled only on the plans
-- that still hold every published term it is derived from — the credits of the month and the
-- tasks of the day —, as billing_credit_amounts did: a plan changed by hand, a plan of another
-- slug and an empty table are left alone, and in a new database the seed writes the number.
-- So the check that a day never gives more than the month cannot fail inside the transaction
-- below. `plans.tasks_per_day` stays, unused, until the narrowing release (M5.18).
--
-- `credit_holds.charged` is what a reserve row paid when its task was charged: written once,
-- with the row's move to 'captured', and only then. The day a row counts on is the day it was
-- placed (`placed_at`), and what it counts there is what it holds while active and what it paid
-- once captured; a returned row counts nothing. The index on (account_id, settled_at) finds the
-- charges of a day.
--
-- What a row captured before this migration paid is recorded nowhere: the charge of a task is
-- one journal entry per account, not one per row. The migration stops there and changes
-- nothing. Nothing in the product places reserves before P12: only test runs write such rows,
-- and the database is cleaned of their tasks or recreated. A hold of the rouble wallet ('rub')
-- is not a reserve of credits and does not stop it.
--
-- The stop stands before BEGIN on purpose. `prisma migrate deploy` sends this file as one
-- query: a statement that fails inside the file's own transaction leaves the session in an
-- aborted transaction block, Prisma then cannot record the failure and prints «current
-- transaction is aborted» in place of the reason. Raised before BEGIN, the exception ends the
-- query with nothing open, and its message is what the operator reads.
DO $$
DECLARE
  captured bigint;
BEGIN
  SELECT count(*) INTO captured FROM "credit_holds"
    WHERE "status" = 'captured' AND "unit" IN ('credit_tariff', 'credit_gift', 'credit_pack');
  IF captured > 0 THEN
    RAISE EXCEPTION 'credit_holds holds charged reserves of credits (% rows): what each row paid is not recorded. Only test runs write them: delete those test tasks with their billing rows, or recreate this database', captured;
  END IF;
END $$;

-- One transaction for the changes: a database must never be left with the column of the day
-- and without its check, however the statements of this file are sent.
BEGIN;

ALTER TABLE "plans" ADD COLUMN "credits_per_day" INTEGER;

UPDATE "plans" SET "credits_per_day" = 50, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota' AND "credits_per_month" = 300 AND "tasks_per_day" = 5;
UPDATE "plans" SET "credits_per_day" = 100, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota' AND "credits_per_month" = 800 AND "tasks_per_day" = 10;
UPDATE "plans" SET "credits_per_day" = 300, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota' AND "credits_per_month" = 2500 AND "tasks_per_day" = 30;

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_credits_per_day_check" CHECK ("credits_per_day" IS NULL OR "credits_per_day" > 0),
  ADD CONSTRAINT "plans_day_within_month_check" CHECK (
    "credits_per_day" IS NULL OR "credits_per_month" IS NULL OR "credits_per_day" <= "credits_per_month"
  );

ALTER TABLE "credit_holds" ADD COLUMN "charged" DECIMAL(14,2);

-- A row of credits has `charged` exactly when it is captured: a whole number of credits from 0
-- to what the row held. A hold of the rouble wallet is not asked.
ALTER TABLE "credit_holds"
  ADD CONSTRAINT "credit_holds_charged_check" CHECK (
    "unit" NOT IN ('credit_tariff', 'credit_gift', 'credit_pack')
    OR (
      ("status" = 'captured') = ("charged" IS NOT NULL)
      AND (
        "charged" IS NULL
        OR ("charged" >= 0 AND "charged" <= "amount" AND "charged" = trunc("charged"))
      )
    )
  );

CREATE INDEX "credit_holds_account_id_settled_at_idx" ON "credit_holds"("account_id", "settled_at");

COMMIT;
