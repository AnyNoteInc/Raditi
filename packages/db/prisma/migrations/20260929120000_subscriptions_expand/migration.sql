-- Preserve the legacy catalogue and price history while disabling the old model path.
BEGIN;

UPDATE "llm_providers" SET "enabled" = false WHERE "kind" = 'api';
UPDATE "llm_models" SET "enabled" = false
 WHERE "provider_id" IN (SELECT "id" FROM "llm_providers" WHERE "kind" = 'api');

-- Keep the service enum value until the next release's contract migration.
UPDATE "llm_models" SET "enabled" = false WHERE "model_class" = 'service';

-- Admission reserves output before the call; this is not a provider output limit.
ALTER TABLE "llm_models" ADD COLUMN "reserve_output_tokens" INTEGER NOT NULL DEFAULT 32000
  CONSTRAINT "llm_models_reserve_output_tokens_check"
  CHECK ("reserve_output_tokens" BETWEEN 1024 AND 131072);

COMMIT;
