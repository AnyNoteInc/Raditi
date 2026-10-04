-- Add the subscription gateway without removing the legacy columns or model class.
BEGIN;

CREATE TYPE "SubscriptionAccountStatus" AS ENUM ('active', 'banned', 'retired');
CREATE TYPE "SubscriptionAccountHealth" AS ENUM ('ok', 'needs_relogin', 'suspended');
CREATE TYPE "LlmCallState" AS ENUM ('open', 'completed', 'failed', 'aborted', 'lost');
CREATE TYPE "WorkspaceDataClass" AS ENUM ('synthetic', 'client');

-- Before P3 nothing wrote these tables; stop instead of guessing or losing history.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "subscription_accounts") THEN RAISE EXCEPTION 'subscription_accounts is not empty'; END IF;
  IF EXISTS (SELECT 1 FROM "token_usage") THEN RAISE EXCEPTION 'token_usage is not empty'; END IF;
END $$;

ALTER TABLE "workspaces" ADD COLUMN "data_class" "WorkspaceDataClass" NOT NULL DEFAULT 'client';

ALTER TABLE "subscription_accounts"
  ALTER COLUMN "driver_id" SET NOT NULL,             -- every account serves exactly one shell
  ADD COLUMN "plan" VARCHAR(32) NOT NULL,
  ADD COLUMN "external_account_id" VARCHAR(128),     -- chatgpt_account_id: not a secret, relogin must match
  ADD COLUMN "paid_until" DATE,
  ADD COLUMN "status" "SubscriptionAccountStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "status_reason" VARCHAR(64),
  ADD COLUMN "health" "SubscriptionAccountHealth" NOT NULL DEFAULT 'ok',
  ADD COLUMN "health_reason" VARCHAR(64),
  ADD COLUMN "health_changed_at" TIMESTAMPTZ(6),
  ADD COLUMN "cooling_until" TIMESTAMPTZ(6),
  ADD COLUMN "breaker_open_until" TIMESTAMPTZ(6),
  ADD COLUMN "usage_missing_streak" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "max_concurrent_turns" SMALLINT NOT NULL,
  ADD COLUMN "max_concurrent_requests" SMALLINT NOT NULL,
  ADD COLUMN "limit_windows" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "headroom_pct" NUMERIC(5,2),
  ADD COLUMN "limits_seen_at" TIMESTAMPTZ(6),
  ADD COLUMN "credits_seen" JSONB,                   -- x-codex-credits-*: the balance must stay 0
  ADD COLUMN "credential_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "credential_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "credential_refreshed_at" TIMESTAMPTZ(6),
  ADD COLUMN "refresh_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "refresh_finished_at" TIMESTAMPTZ(6),
  ADD COLUMN "refresh_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retire_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "credentials_revoked_at" TIMESTAMPTZ(6),
  ADD COLUMN "client_identity" JSONB NOT NULL DEFAULT '{}',   -- device/installation ids: not secrets
  ADD COLUMN "last_used_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "subscription_accounts_concurrency_check"
    CHECK ("max_concurrent_turns" BETWEEN 1 AND 8 AND "max_concurrent_requests" BETWEEN 1 AND 16),
  ADD CONSTRAINT "subscription_accounts_headroom_check" CHECK ("headroom_pct" IS NULL OR "headroom_pct" BETWEEN 0 AND 100),
  ADD CONSTRAINT "subscription_accounts_json_check"
    CHECK (jsonb_typeof("limit_windows") = 'array' AND jsonb_typeof("client_identity") = 'object'),
  ADD CONSTRAINT "subscription_accounts_numbers_check"
    CHECK ("credential_version" >= 0 AND "refresh_failures" >= 0 AND "usage_missing_streak" >= 0),
  ADD CONSTRAINT "subscription_accounts_retired_check" CHECK ("status" <> 'retired' OR NOT "enabled");
CREATE UNIQUE INDEX "subscription_accounts_label_key" ON "subscription_accounts"("label");
CREATE UNIQUE INDEX "subscription_accounts_external_key" ON "subscription_accounts"("provider_id", "external_account_id");
CREATE INDEX "subscription_accounts_pick_idx" ON "subscription_accounts"("provider_id", "status", "health") WHERE "enabled";

CREATE TABLE "task_account_bindings" (
  "task_id" UUID PRIMARY KEY REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "driver_id" VARCHAR(32) NOT NULL REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "subscription_account_id" UUID NOT NULL REFERENCES "subscription_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "bound_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "rebinds" INTEGER NOT NULL DEFAULT 0 CONSTRAINT "task_account_bindings_rebinds_check" CHECK ("rebinds" >= 0),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "task_account_bindings_account_idx" ON "task_account_bindings"("subscription_account_id");

CREATE TABLE "llm_keys" (
  "id" UUID PRIMARY KEY, "key_hash" VARCHAR(64) NOT NULL UNIQUE CONSTRAINT "llm_keys_hash_check" CHECK ("key_hash" ~ '^[0-9a-f]{64}$'),
  "task_id" UUID NOT NULL REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE RESTRICT, "task_attempt" INTEGER NOT NULL,
  "session_id" VARCHAR(64) NOT NULL, "turn_no" INTEGER NOT NULL, "first_epoch" INTEGER NOT NULL,
  "driver_id" VARCHAR(32) NOT NULL REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "model_id" UUID NOT NULL REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "subscription_account_id" UUID NOT NULL REFERENCES "subscription_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "reasoning_effort" VARCHAR(16),
  "budget_rub" DECIMAL(18,10) NOT NULL CONSTRAINT "llm_keys_budget_check" CHECK ("budget_rub" > 0 AND "budget_rub" <= 750),
  "bound_source" INET,                                   -- runner VM address; NULL for the local executor
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "valid_until" TIMESTAMPTZ(6) NOT NULL, "revoke_requested_at" TIMESTAMPTZ(6), "revoked_at" TIMESTAMPTZ(6),
  "usage_closed_at" TIMESTAMPTZ(6),
  "last_call_at" TIMESTAMPTZ(6), "last_refusal" VARCHAR(32), "last_refusal_at" TIMESTAMPTZ(6),
  UNIQUE ("task_id", "turn_no", "first_epoch"),
  CONSTRAINT "llm_keys_attempt_check" CHECK ("task_attempt" > 0 AND "turn_no" > 0 AND "first_epoch" > 0),
  CONSTRAINT "llm_keys_expiry_check" CHECK ("expires_at" > "issued_at" AND "valid_until" >= "expires_at"),
  CONSTRAINT "llm_keys_revoked_check" CHECK ("revoked_at" IS NULL OR "revoke_requested_at" IS NOT NULL),
  CONSTRAINT "llm_keys_usage_closed_check" CHECK ("usage_closed_at" IS NULL OR "revoked_at" IS NOT NULL),
  CONSTRAINT "llm_keys_refusal_check" CHECK (("last_refusal" IS NULL) = ("last_refusal_at" IS NULL)));
CREATE INDEX "llm_keys_account_active_idx" ON "llm_keys"("subscription_account_id", "expires_at") WHERE "revoked_at" IS NULL;
CREATE INDEX "llm_keys_task_attempt_idx" ON "llm_keys"("task_id", "task_attempt");
CREATE INDEX "llm_keys_revoke_retry_idx" ON "llm_keys"("revoke_requested_at") WHERE "revoke_requested_at" IS NOT NULL AND "revoked_at" IS NULL;
CREATE INDEX "llm_keys_usage_open_idx" ON "llm_keys"("revoked_at") WHERE "usage_closed_at" IS NULL;

CREATE TABLE "llm_calls" (
  "id" UUID PRIMARY KEY,                                  -- gateway uuid v7 = token_usage.gateway_call_id
  "key_id" UUID NOT NULL REFERENCES "llm_keys"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "subscription_account_id" UUID NOT NULL REFERENCES "subscription_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "model_id" UUID NOT NULL REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "route" VARCHAR(64) NOT NULL, "state" "LlmCallState" NOT NULL DEFAULT 'open',
  "reserved_rub" DECIMAL(18,10) NOT NULL CONSTRAINT "llm_calls_reserved_check" CHECK ("reserved_rub" >= 0),
  "request_bytes" INTEGER NOT NULL CONSTRAINT "llm_calls_request_bytes_check" CHECK ("request_bytes" >= 0), "response_bytes" BIGINT NOT NULL DEFAULT 0 CONSTRAINT "llm_calls_response_bytes_check" CHECK ("response_bytes" >= 0),
  "upstream_status" INTEGER, "upstream_response_id" VARCHAR(256), "signal" VARCHAR(32),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "llm_calls_finished_check" CHECK (("state" = 'open') = ("finished_at" IS NULL)));
CREATE INDEX "llm_calls_open_idx" ON "llm_calls"("started_at") WHERE "state" = 'open';
CREATE INDEX "llm_calls_key_idx" ON "llm_calls"("key_id");
CREATE INDEX "llm_calls_account_started_idx" ON "llm_calls"("subscription_account_id", "started_at");
CREATE INDEX "llm_calls_signal_idx" ON "llm_calls"("signal", "started_at") WHERE "signal" IS NOT NULL;

CREATE TABLE "cross_border_clearances" (
  "id" UUID PRIMARY KEY, "provider_id" UUID NOT NULL REFERENCES "llm_providers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "countries" VARCHAR(64) NOT NULL CONSTRAINT "cross_border_clearances_countries_check" CHECK ("countries" ~ '^[A-Z]{2}(,[A-Z]{2})*$'),
  "notice22_ref" VARCHAR(128) NOT NULL, "notice22_date" DATE NOT NULL,
  "recipients_assessed_on" DATE NOT NULL,
  "notice12_ref" VARCHAR(128) NOT NULL, "notice12_received_on" DATE NOT NULL,
  "transfer_allowed_from" DATE NOT NULL,                 -- after 10 working days for the US, set by the operator
  "documents" VARCHAR(1024) NOT NULL,                    -- published versions of the legal documents
  "recorded_by" VARCHAR(255) NOT NULL, "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "cross_border_clearances_dates_check" CHECK ("recipients_assessed_on" <= "notice12_received_on" AND "notice22_date" <= "notice12_received_on"
     AND "transfer_allowed_from" >= "notice12_received_on"));
CREATE INDEX "cross_border_clearances_active_idx" ON "cross_border_clearances"("provider_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "token_usage"
  ALTER COLUMN "gateway_call_id" TYPE UUID USING "gateway_call_id"::uuid,
  ALTER COLUMN "turn_id" DROP NOT NULL,                  -- until P12 writes task_turns before issue
  ADD COLUMN "key_id" UUID NOT NULL, ADD COLUMN "subscription_account_id" UUID NOT NULL,
  ADD COLUMN "task_attempt" INTEGER NOT NULL,
  ADD COLUMN "estimated" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "estimate_reason" VARCHAR(16),
  ADD COLUMN "billable" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "token_usage_gateway_call_id_fkey" FOREIGN KEY ("gateway_call_id") REFERENCES "llm_calls"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "token_usage_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "llm_keys"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "token_usage_account_fkey" FOREIGN KEY ("subscription_account_id") REFERENCES "subscription_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "token_usage_reasoning_check" CHECK ("reasoning_tokens" <= "output_tokens"),
  ADD CONSTRAINT "token_usage_attempt_check" CHECK ("task_attempt" > 0),
  ADD CONSTRAINT "token_usage_estimate_check" CHECK (
    "estimated" = ("estimate_reason" IS NOT NULL)
    AND ("estimate_reason" IS NULL OR "estimate_reason" IN ('aborted_client', 'aborted_platform', 'lost', 'no_usage', 'invalid_usage'))
    AND "billable" = ("estimate_reason" IS NULL OR "estimate_reason" NOT IN ('aborted_platform', 'lost')));
CREATE INDEX "token_usage_key_id_idx" ON "token_usage"("key_id");
CREATE INDEX "token_usage_task_attempt_idx" ON "token_usage"("task_id", "task_attempt");
CREATE UNIQUE INDEX "llm_model_prices_id_model_id_key" ON "llm_model_prices"("id", "model_id");
ALTER TABLE "token_usage" DROP CONSTRAINT "token_usage_price_id_fkey";
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_price_id_model_id_fkey"
  FOREIGN KEY ("price_id", "model_id") REFERENCES "llm_model_prices"("id", "model_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Privileges. Default privileges give raditi_app (web and core) DML on every new table
-- (infra/app/postgres/init-roles.sh): take it back at once and grant core directly.
-- init-roles.sh may run before this migration: existing runtime roles receive their grants
-- now, without waiting for a second bootstrap. In dev these roles need not exist.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi_app') THEN
    REVOKE ALL ON "llm_keys", "llm_calls", "task_account_bindings", "subscription_accounts",
                  "token_usage", "cross_border_clearances" FROM raditi_app;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi_core') THEN
    GRANT SELECT, INSERT, UPDATE ON "llm_keys", "task_account_bindings" TO raditi_core;
    GRANT SELECT, INSERT ON "subscription_accounts", "token_usage" TO raditi_core;
    GRANT UPDATE ("enabled", "status", "status_reason", "health", "health_reason", "health_changed_at",
                  "plan", "external_account_id", "paid_until", "max_concurrent_turns", "max_concurrent_requests",
                  "retire_requested_at", "credential_version", "credential_expires_at", "credential_refreshed_at",
                  "refresh_started_at", "refresh_finished_at", "client_identity", "updated_at") ON "subscription_accounts" TO raditi_core;
    GRANT SELECT, UPDATE ("state", "finished_at") ON "llm_calls" TO raditi_core;   -- backup sweeper
    GRANT SELECT ON "cross_border_clearances" TO raditi_core;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi_llm') THEN
    GRANT SELECT ON "llm_keys", "llm_models", "llm_model_prices", "llm_providers",
                    "subscription_accounts", "token_usage", "llm_calls" TO raditi_llm;
    GRANT UPDATE ("last_call_at", "last_refusal", "last_refusal_at") ON "llm_keys" TO raditi_llm;
    GRANT INSERT, UPDATE ("state", "finished_at", "response_bytes", "upstream_status", "upstream_response_id", "signal")
      ON "llm_calls" TO raditi_llm;
    GRANT INSERT ON "token_usage" TO raditi_llm;
    GRANT UPDATE ("health", "health_reason", "health_changed_at", "cooling_until", "breaker_open_until",
                  "usage_missing_streak", "limit_windows", "headroom_pct", "limits_seen_at", "credits_seen",
                  "credential_version", "credential_expires_at", "credential_refreshed_at", "refresh_started_at",
                  "refresh_finished_at", "refresh_failures", "credentials_revoked_at", "last_used_at", "updated_at")
      ON "subscription_accounts" TO raditi_llm;
  END IF;
END $$;

COMMIT;
