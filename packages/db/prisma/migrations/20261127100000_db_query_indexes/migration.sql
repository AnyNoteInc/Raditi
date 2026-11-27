-- Indexes for the reads of plan 96, P31: only indexes, no data changes.
BEGIN;

-- The gallery reads the first three written blocks of each card in one query, in the order of
-- `artifactBlockOrder` (`rank` NULLS LAST, `position`, `id`).
CREATE INDEX "chat_document_sections_excerpt_idx" ON "chat_document_sections"("document_id", "rank", "position", "id")
  WHERE deleted_rev IS NULL AND state::text = 'written'::text;

-- `task.activity` reads the rows of a turn by `turn_id` after a cursor; the new index serves the
-- foreign key as well, so the one on `turn_id` alone goes.
CREATE INDEX "task_events_turn_id_id_idx" ON "task_events"("turn_id", "id");
DROP INDEX "task_events_turn_id_idx";

-- The few journal rows written while their turn had no row of `task_turns`: read by the number
-- in their payload.
CREATE INDEX "task_events_turnless_output_idx" ON "task_events"("task_id", "id")
  WHERE turn_id IS NULL AND type::text = 'turn.output'::text;

-- The chart of «Использование»: the requests of the chats of a workspace since a day.
CREATE INDEX "task_events_request_created_idx" ON "task_events"("task_id", "created_at")
  WHERE type::text = 'feed.request'::text;

-- The history of «Использование»: the reserves of a period.
CREATE INDEX "credit_holds_account_id_created_at_idx" ON "credit_holds"("account_id", "created_at");

-- The newest merge request of a branch.
CREATE INDEX "project_merge_requests_branch_idx" ON "project_merge_requests"("project_repository_id", "source_branch", "number" DESC);

COMMIT;
