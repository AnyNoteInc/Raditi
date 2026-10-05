-- Keep historical identities/results while retiring only external content data.
ALTER TABLE "tasks"
  ADD COLUMN "content_accessed_at" TIMESTAMPTZ(6),
  ADD COLUMN "content_retired_at" TIMESTAMPTZ(6),
  ADD COLUMN "content_masks_purged_at" TIMESTAMPTZ(6);
ALTER TABLE "snapshots"
  ADD COLUMN "purge_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "purged_at" TIMESTAMPTZ(6);
ALTER TABLE "mcp_calls" ADD COLUMN "receipt_purged_at" TIMESTAMPTZ(6);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_content_retention_check" CHECK (
  "content_masks_purged_at" IS NULL OR "content_retired_at" IS NOT NULL
);
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_content_retention_check" CHECK (
  ("purge_requested_at" IS NULL OR "purge_requested_at" >= "expires_at") AND
  ("purged_at" IS NULL OR "purge_requested_at" IS NOT NULL)
);
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_receipt_retention_check" CHECK (
  "receipt_purged_at" IS NULL OR "result" IS NOT NULL
);
