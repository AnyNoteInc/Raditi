-- The windows of 5 hours and of the week (owner's decision of 11.11.2026, docs/spec.md §20,
-- «Лимиты 5 часов и недели»; docs/plan/69-usage-limits.md):
-- - token_usage.plan_credits and llm_calls.reserved_plan_credits: the credits of the provider's
--   plan a call took and was estimated at — NULL where the provider has no plan rates (zai-api);
-- - llm_plan_rates: the multipliers and the peak of the plan, rows only added by an operator;
-- - llm_turn_costs: the cost of a turn of a profile, a snapshot core recomputes;
-- - plans.credits_per_5h, credits_per_week, max_concurrent_turns and their values for the three
--   tariffs (Л4, Л10), changed in place as billing_pricing_2026_11 did: only plans that still
--   hold the terms published on 06.11.2026 and no value of their own;
-- - workspace_usage_windows: the windows a workspace opened with its first call.
-- New columns and tables only: code without this file keeps working on a database with it.
BEGIN;

ALTER TABLE "token_usage" ADD COLUMN "plan_credits" DECIMAL(14,4);
ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_plan_credits_check" CHECK ("plan_credits" IS NULL OR "plan_credits" >= 0);

-- The forecast of an account's windows sums its calls after the last probe.
CREATE INDEX "token_usage_account_occurred_idx"
  ON "token_usage"("subscription_account_id", "occurred_at");

ALTER TABLE "llm_calls" ADD COLUMN "reserved_plan_credits" DECIMAL(14,4);
ALTER TABLE "llm_calls"
  ADD CONSTRAINT "llm_calls_reserved_plan_credits_check"
  CHECK ("reserved_plan_credits" IS NULL OR "reserved_plan_credits" >= 0);

CREATE TABLE "llm_plan_rates" (
  "id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "model" VARCHAR(255) NOT NULL,
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "input_uncached_per_10k" DECIMAL(12,6) NOT NULL,
  "cache_read_per_10k" DECIMAL(12,6) NOT NULL,
  "output_per_10k" DECIMAL(12,6) NOT NULL,
  "off_peak_share" DECIMAL(5,4) NOT NULL,
  "peak" JSONB NOT NULL,
  "source_url" VARCHAR(1024) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "llm_plan_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "llm_plan_rates_provider_fkey" FOREIGN KEY ("provider_id")
    REFERENCES "llm_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "llm_plan_rates_values_check" CHECK (
    "input_uncached_per_10k" >= 0 AND "cache_read_per_10k" >= 0 AND "output_per_10k" >= 0
    AND "off_peak_share" > 0 AND "off_peak_share" <= 1
    AND jsonb_typeof("peak") = 'object')
);
CREATE UNIQUE INDEX "llm_plan_rates_provider_model_effective_from_key"
  ON "llm_plan_rates"("provider_id", "model", "effective_from");

CREATE TABLE "llm_turn_costs" (
  "model_id" UUID NOT NULL,
  "turns" INTEGER NOT NULL,
  "p50_plan_credits" DECIMAL(14,4) NOT NULL,
  "p95_plan_credits" DECIMAL(14,4) NOT NULL,
  "computed_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "llm_turn_costs_pkey" PRIMARY KEY ("model_id"),
  CONSTRAINT "llm_turn_costs_model_fkey" FOREIGN KEY ("model_id")
    REFERENCES "llm_models"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "llm_turn_costs_values_check" CHECK (
    "turns" > 0 AND "p50_plan_credits" >= 0 AND "p95_plan_credits" >= "p50_plan_credits")
);

ALTER TABLE "plans" ADD COLUMN "credits_per_5h" INTEGER;
ALTER TABLE "plans" ADD COLUMN "credits_per_week" INTEGER;
ALTER TABLE "plans" ADD COLUMN "max_concurrent_turns" SMALLINT;
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_usage_windows_check" CHECK (
    ("credits_per_5h" IS NULL OR "credits_per_5h" > 0)
    AND ("credits_per_week" IS NULL OR "credits_per_week" > 0)
    AND ("credits_per_5h" IS NULL OR "credits_per_week" IS NULL
         OR "credits_per_5h" <= "credits_per_week")
    AND ("max_concurrent_turns" IS NULL OR "max_concurrent_turns" > 0));

UPDATE "plans"
  SET "credits_per_5h" = 20, "credits_per_week" = 55, "max_concurrent_turns" = 1,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota' AND "price" = 1990.00
    AND "credits_per_month" = 150 AND "credits_per_5h" IS NULL;
UPDATE "plans"
  SET "credits_per_5h" = 70, "credits_per_week" = 210, "max_concurrent_turns" = 2,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota' AND "price" = 6990.00
    AND "credits_per_month" = 600 AND "credits_per_5h" IS NULL;
UPDATE "plans"
  SET "credits_per_5h" = 200, "credits_per_week" = 700, "max_concurrent_turns" = 3,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota' AND "price" = 19990.00
    AND "credits_per_month" = 2000 AND "credits_per_5h" IS NULL;

CREATE TABLE "workspace_usage_windows" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "kind" VARCHAR(8) NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "workspace_usage_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_usage_windows_workspace_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- A window lasts its length from its first call, as the windows of the plan do (Л3).
  CONSTRAINT "workspace_usage_windows_length_check" CHECK (
    ("kind" = '5h' AND "ends_at" = "started_at" + interval '5 hours')
    OR ("kind" = 'week' AND "ends_at" = "started_at" + interval '7 days'))
);
-- Windows of one kind never overlap: a new one is opened under the lock of the workspace and
-- only after the one before has ended (docs/spec.md §9); two at one moment cannot exist.
CREATE UNIQUE INDEX "workspace_usage_windows_workspace_kind_started_key"
  ON "workspace_usage_windows"("workspace_id", "kind", "started_at");
CREATE INDEX "workspace_usage_windows_workspace_kind_ends_idx"
  ON "workspace_usage_windows"("workspace_id", "kind", "ends_at");

COMMIT;
