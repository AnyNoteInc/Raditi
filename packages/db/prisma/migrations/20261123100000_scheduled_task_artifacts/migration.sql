-- The artifacts a scheduled task names in its window (plan 88, Ар24, slice 88.20б); additive.
-- A run without its client may change them, beside the client's own without a project.
BEGIN;
CREATE TABLE "scheduled_task_artifacts" (
  "scheduled_task_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduled_task_artifacts_pkey" PRIMARY KEY ("scheduled_task_id", "artifact_id"),
  CONSTRAINT "scheduled_task_artifacts_scheduled_task_id_fkey"
    FOREIGN KEY ("scheduled_task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "scheduled_task_artifacts_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "scheduled_task_artifacts_artifact_id_idx" ON "scheduled_task_artifacts"("artifact_id");
COMMIT;
