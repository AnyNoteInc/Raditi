-- The profile of a turn key that sees images (docs/plan/88-artifacts.md, Ар32, slice 88.15в): the
-- helper `look` of the driver runs on it. Only added columns and constraints.

-- A profile that sees images is never the main model of a class: the choice of a class skips it.
ALTER TABLE "llm_models" ADD COLUMN "vision" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "llm_keys"
  ADD COLUMN "vision_model_id" UUID,
  ADD COLUMN "vision_reasoning_effort" VARCHAR(16);

-- NOT VALID: the new column is NULL in every row, nothing to scan under a lock.
ALTER TABLE "llm_keys"
  ADD CONSTRAINT "llm_keys_vision_model_id_fkey" FOREIGN KEY ("vision_model_id")
  REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "llm_keys" VALIDATE CONSTRAINT "llm_keys_vision_model_id_fkey";

CREATE INDEX "llm_keys_vision_model_idx" ON "llm_keys"("vision_model_id")
  WHERE "vision_model_id" IS NOT NULL;

-- A vision profile has its level of reasoning, a key without one has neither.
ALTER TABLE "llm_keys"
  ADD CONSTRAINT "llm_keys_vision_profile_check"
  CHECK ("vision_model_id" IS NOT NULL OR "vision_reasoning_effort" IS NULL);
