-- An agent's reply in a note sent to its chat (plan 88, Ар53, 88.18г); additive.
-- It waits for the check of core (`pending_at`), and closes the note after it if asked.
BEGIN;
ALTER TABLE "artifact_comment_replies"
  ADD COLUMN "by_agent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "author_task_id" UUID,
  ADD COLUMN "author_turn_no" INTEGER,
  ADD COLUMN "pending_at" TIMESTAMPTZ(6),
  ADD COLUMN "resolve_on_pass" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "artifact_comment_replies"
  ADD CONSTRAINT "artifact_comment_replies_author_task_id_fkey" FOREIGN KEY ("author_task_id")
  REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- One author: a person, or a turn of an agent; only an agent's reply waits for the check.
ALTER TABLE "artifact_comment_replies"
  ADD CONSTRAINT "artifact_comment_replies_author_check" CHECK (
    ("by_agent" AND "author_user_id" IS NULL)
    OR (NOT "by_agent" AND "author_task_id" IS NULL AND "author_turn_no" IS NULL
      AND "pending_at" IS NULL AND NOT "resolve_on_pass")
  );
CREATE INDEX "artifact_comment_replies_pending_idx"
  ON "artifact_comment_replies"("author_task_id") WHERE "pending_at" IS NOT NULL;
COMMIT;
