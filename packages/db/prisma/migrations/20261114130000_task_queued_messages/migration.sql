-- The queue of a chat (docs/plan/75-chat-input-output.md, ВВ1–ВВ5): the client's words written
-- while the agent worked. core takes them into the feed when the pass they waited for ended
-- (`feed.request` of the kind `queued`) and starts the next pass; until then the client may change
-- or remove them. A new table only.
CREATE TABLE "task_queued_messages" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "plan" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_queued_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_queued_messages_task_id_request_id_key"
  ON "task_queued_messages"("task_id", "request_id");
CREATE INDEX "task_queued_messages_task_id_created_at_idx"
  ON "task_queued_messages"("task_id", "created_at");

ALTER TABLE "task_queued_messages" ADD CONSTRAINT "task_queued_messages_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The words are words of a request (`feedLimits.requestText`), never empty; at most ten files.
ALTER TABLE "task_queued_messages" ADD CONSTRAINT "task_queued_messages_text_check"
  CHECK (char_length(text) BETWEEN 1 AND 4000);
ALTER TABLE "task_queued_messages" ADD CONSTRAINT "task_queued_messages_attachments_check"
  CHECK (cardinality(attachments) <= 10);
