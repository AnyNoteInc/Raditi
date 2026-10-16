-- Reserves in credits (docs/plan/37-billing-plan.md, «Что меняется в базе»; spec §16, §17).
--
-- A reserve of an attempt may stand on several accounts — the tariff, the gift, the pack — one
-- row per account it touches: the unique key gets the account.
--
-- `placed_at` is the moment a reserve was placed, the same on every row of a placement; the
-- daily limit counts launches by it. `created_at` keeps its meaning: on a tariff row it is the
-- stamp of the period the credits are of, which for a reserve placed after a period ended and
-- before its renewal is settled is the last millisecond of that period — the day counted by it
-- would not see such a reserve. Rows that exist get the stamp they were counted by so far.
--
-- `gift_site_claims`: one site spends gift credits in one workspace only. The first reserve
-- that takes gift credits without a paid tariff writes the row of the site — its host as the
-- platform normalises it, without one leading `www.`, with the port when the stored address
-- has one — and a reserve of another workspace for the same site is refused.
--
-- One transaction: Prisma sends a migration statement by statement, and the reserves must not
-- be left without a unique key, nor the column without its values.
BEGIN;

DROP INDEX "credit_holds_task_id_attempt_key";

CREATE UNIQUE INDEX "credit_holds_task_id_attempt_account_id_key"
  ON "credit_holds"("task_id", "attempt", "account_id");

ALTER TABLE "credit_holds" ADD COLUMN "placed_at" TIMESTAMPTZ(6);

UPDATE "credit_holds" SET "placed_at" = "created_at";

ALTER TABLE "credit_holds"
  ALTER COLUMN "placed_at" SET NOT NULL,
  ALTER COLUMN "placed_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "credit_holds_account_id_placed_at_idx" ON "credit_holds"("account_id", "placed_at");

CREATE TABLE "gift_site_claims" (
    "host_key" VARCHAR(512) NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_site_claims_pkey" PRIMARY KEY ("host_key")
);

CREATE INDEX "gift_site_claims_workspace_id_idx" ON "gift_site_claims"("workspace_id");

ALTER TABLE "gift_site_claims"
  ADD CONSTRAINT "gift_site_claims_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
