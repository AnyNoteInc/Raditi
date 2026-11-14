-- «Закрепить» and «В архив» of a chat (docs/plan/75-chat-input-output.md, ВВ21). Columns only:
-- nothing is read or rewritten, a chat without them is neither pinned nor archived.
ALTER TABLE "tasks" ADD COLUMN "pinned_at" TIMESTAMPTZ(6);
ALTER TABLE "tasks" ADD COLUMN "archived_at" TIMESTAMPTZ(6);

-- The pinned chats of a workspace, read at the head of the list.
CREATE INDEX "tasks_workspace_pinned_idx" ON "tasks" ("workspace_id", "pinned_at" DESC)
  WHERE pinned_at IS NOT NULL;
