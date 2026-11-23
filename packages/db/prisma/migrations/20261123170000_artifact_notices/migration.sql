-- Notices of artifacts (plan 88, Ар54; slice 88.17а): a notice may be of an artifact, with who did it.
BEGIN;
ALTER TABLE "chat_notifications"
  ADD COLUMN "artifact_id" UUID,
  ADD COLUMN "actor_user_id" UUID;
ALTER TABLE "chat_notifications"
  ADD CONSTRAINT "chat_notifications_artifact_id_fkey" FOREIGN KEY ("artifact_id")
  REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_notifications"
  ADD CONSTRAINT "chat_notifications_actor_user_id_fkey" FOREIGN KEY ("actor_user_id")
  REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat_notifications" DROP CONSTRAINT "chat_notifications_kind_check";
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_kind_check" CHECK (
  "kind" IN ('answered', 'question', 'ready', 'failed', 'limit', 'not_started', 'paused', 'missed',
             'artifact_shared', 'artifact_comment', 'artifact_agent_reply', 'artifact_changed')
);
ALTER TABLE "chat_notifications" DROP CONSTRAINT "chat_notifications_target_check";
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_target_check" CHECK (
  ("task_id" IS NOT NULL AND "artifact_id" IS NULL)
  OR ("scheduled_task_id" IS NOT NULL AND "kind" IN ('not_started', 'paused', 'missed'))
  OR ("artifact_id" IS NOT NULL AND "task_id" IS NULL AND "kind" LIKE 'artifact\_%')
);
CREATE INDEX "chat_notifications_artifact_id_user_id_created_at_idx"
  ON "chat_notifications"("artifact_id", "user_id", "created_at") WHERE "artifact_id" IS NOT NULL;
COMMIT;
