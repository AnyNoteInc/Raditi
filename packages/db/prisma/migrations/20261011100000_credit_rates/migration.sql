-- The credit rate K (docs/plan/37-billing-plan.md, «Курс кредита и команда ставок»; spec §16,
-- §17): how many roubles of accounting cost one credit stands for. Rows are only added, by the
-- operator command `billing:rates`, together with the price rows of the models and with the
-- same `effective_from`; the table is never seeded. A model call is turned into credits at the
-- rate in force when it started, so nothing is pinned on a task or on a hold.
--
-- `effective_from` holds whole milliseconds: the code compares the instants of rates, prices and
-- calls as JavaScript dates as well as in SQL, and the two must agree. An instant written by
-- hand with now() carries microseconds and is refused.
--
-- One transaction: Prisma sends a migration statement by statement, and the table must not
-- exist without its unique key.
BEGIN;

CREATE TABLE "credit_rates" (
    "id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "rub_per_credit" DECIMAL(14,6) NOT NULL,
    "basis" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credit_rates_rub_per_credit_check" CHECK ("rub_per_credit" > 0),
    CONSTRAINT "credit_rates_effective_from_check"
      CHECK ("effective_from" = date_trunc('milliseconds', "effective_from"))
);

CREATE UNIQUE INDEX "credit_rates_effective_from_key" ON "credit_rates"("effective_from");

COMMIT;
