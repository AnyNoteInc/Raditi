-- How many tokens a request of the model may hold — what `/context` of a chat measures the last
-- request by (owner's request of 15.11.2026). NULL: not known, the command says nothing of it.
-- glm-5.3 holds 1 000 000, as the catalogue of the pinned OpenCode CLI says
-- (packages/agent-drivers/src/opencode.ts, MODEL_LIMIT).
ALTER TABLE "llm_models" ADD COLUMN "context_tokens" INTEGER;
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_context_tokens_check"
  CHECK ("context_tokens" IS NULL OR "context_tokens" > 0);
UPDATE "llm_models" SET "context_tokens" = 1000000
  WHERE "provider_model_id" = 'glm-5.3' AND "context_tokens" IS NULL;
