ALTER TABLE "mcp_calls"
  ADD COLUMN "journal_no" BIGSERIAL NOT NULL,
  ADD COLUMN "write_deadline_at" TIMESTAMPTZ(6),
  ADD COLUMN "applied_state_hash" VARCHAR(64),
  ADD COLUMN "restores_snapshot_id" UUID;

CREATE UNIQUE INDEX "mcp_calls_journal_no_key" ON "mcp_calls"("journal_no");
CREATE INDEX "mcp_calls_restores_snapshot_id_idx" ON "mcp_calls"("restores_snapshot_id");
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_restores_snapshot_id_fkey"
  FOREIGN KEY ("restores_snapshot_id") REFERENCES "snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_content_proof_check" CHECK (
  "applied_state_hash" IS NULL OR
  ("applied_state_hash" ~ '^[a-f0-9]{64}$' AND "result" = 'ok' AND "write_started_at" IS NOT NULL)
);
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_content_restore_check" CHECK (
  "restores_snapshot_id" IS NULL OR
  ("tool" = 'restore' AND "assignment_id" IS NOT NULL AND "snapshot_id" <> "restores_snapshot_id")
);
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_content_deadline_check" CHECK (
  "write_deadline_at" IS NULL OR
  ("write_started_at" IS NOT NULL AND "write_deadline_at" > "write_started_at")
);
