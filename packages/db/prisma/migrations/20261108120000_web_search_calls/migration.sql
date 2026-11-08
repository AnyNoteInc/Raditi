-- The agent's web search (`raditi_search_web`, spec §20, «Веб-поиск агента — 08.11.2026»): one row
-- per call, written before the request leaves, so the limits of a turn and of the service hold; the
-- calls of a workspace are counted, not limited. Neither the query nor the results are kept.
CREATE TABLE "web_search_calls" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "first_epoch" INTEGER NOT NULL,
    "status" VARCHAR(24),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "web_search_calls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "web_search_calls_task_id_session_id_turn_no_first_epoch_idx" ON "web_search_calls"("task_id", "session_id", "turn_no", "first_epoch");
CREATE INDEX "web_search_calls_workspace_id_created_at_idx" ON "web_search_calls"("workspace_id", "created_at");
CREATE INDEX "web_search_calls_created_at_idx" ON "web_search_calls"("created_at");

ALTER TABLE "web_search_calls" ADD CONSTRAINT "web_search_calls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What a finished call says of itself: a status with its latency, or neither while it is out.
ALTER TABLE "web_search_calls" ADD CONSTRAINT "web_search_calls_finished_check" CHECK (
  ("status" IS NULL AND "latency_ms" IS NULL AND "finished_at" IS NULL)
  OR ("status" IN ('ok', 'timeout', 'rate_limited', 'quota_exhausted', 'failed')
    AND "latency_ms" >= 0 AND "finished_at" IS NOT NULL)
);
