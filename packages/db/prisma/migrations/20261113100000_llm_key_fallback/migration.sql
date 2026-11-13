-- The account of the API the gateway carries the calls of a key of the plan to once the plan's
-- window is out (owner's answer of 13.11.2026, docs/plan/70-turn-without-time-limit.md, ВР25).
-- Expansion only: a key without one is a key as before.
ALTER TABLE "llm_keys" ADD COLUMN "fallback_account_id" UUID;

ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_fallback_account_id_fkey"
  FOREIGN KEY ("fallback_account_id") REFERENCES "subscription_accounts"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A key never falls back on its own account.
ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_fallback_account_check"
  CHECK ("fallback_account_id" IS NULL OR "fallback_account_id" <> "subscription_account_id");
