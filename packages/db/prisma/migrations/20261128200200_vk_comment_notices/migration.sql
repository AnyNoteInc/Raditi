-- The notice of a new comment in a connected VK community (docs/plan/99-vk-community.md, slice
-- 99.6): a row of `chat_notifications` names the community it is of; neither the words nor the
-- author of the comment are kept (spec §11). Adds a nullable column and widens two CHECKs: nothing
-- stops and nothing is carried over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;
ALTER TABLE "chat_notifications" ADD COLUMN "vk_community_id" UUID;
ALTER TABLE "chat_notifications"
  ADD CONSTRAINT "chat_notifications_vk_community_id_fkey" FOREIGN KEY ("vk_community_id")
  REFERENCES "vk_communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_notifications" DROP CONSTRAINT "chat_notifications_kind_check";
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_kind_check" CHECK (
  "kind" IN ('answered', 'question', 'ready', 'failed', 'limit', 'not_started', 'paused', 'missed',
             'artifact_shared', 'artifact_comment', 'artifact_agent_reply', 'artifact_changed',
             'vk_comment')
);
ALTER TABLE "chat_notifications" DROP CONSTRAINT "chat_notifications_target_check";
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_target_check" CHECK (
  ("task_id" IS NOT NULL AND "artifact_id" IS NULL AND "vk_community_id" IS NULL)
  OR ("scheduled_task_id" IS NOT NULL AND "kind" IN ('not_started', 'paused', 'missed')
      AND "vk_community_id" IS NULL)
  OR ("artifact_id" IS NOT NULL AND "task_id" IS NULL AND "kind" LIKE 'artifact\_%'
      AND "vk_community_id" IS NULL)
  OR ("vk_community_id" IS NOT NULL AND "task_id" IS NULL AND "artifact_id" IS NULL
      AND "scheduled_task_id" IS NULL AND "kind" = 'vk_comment')
);
CREATE INDEX "chat_notifications_vk_community_id_user_id_created_at_idx"
  ON "chat_notifications"("vk_community_id", "user_id", "created_at")
  WHERE "vk_community_id" IS NOT NULL;
COMMIT;
