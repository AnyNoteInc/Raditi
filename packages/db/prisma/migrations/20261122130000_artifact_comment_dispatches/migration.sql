-- A private snapshot of the notes explicitly sent with one feed.request (Ар53, 88.18в).
BEGIN;
ALTER TABLE "task_events"
  ADD COLUMN "artifact_comment_has_words" BOOLEAN,
  ADD COLUMN "artifact_comment_source_id" BIGINT;
-- Existing rows have no dispatch; do not scan the whole event journal during deployment.
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_artifact_comment_source_check" CHECK (
  "artifact_comment_source_id" IS NULL OR (
    "type" = 'feed.question' AND "turn_id" IS NULL
    AND ("payload"->>'kind') IS NOT DISTINCT FROM 'ceiling'
    AND "artifact_comment_source_id" > 0 AND "artifact_comment_source_id" < "id"
  )
) NOT VALID;
-- Keep only the opaque idempotency key when the artifact or request is purged.
CREATE TABLE "artifact_comment_dispatch_keys" (
  "user_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  CONSTRAINT "artifact_comment_dispatch_keys_pkey" PRIMARY KEY ("user_id", "request_id"),
  CONSTRAINT "artifact_comment_dispatch_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "artifact_comment_dispatches" (
  "user_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "request_event_id" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "notes" JSONB NOT NULL,
  CONSTRAINT "artifact_comment_dispatches_pkey" PRIMARY KEY ("user_id", "request_id"),
  CONSTRAINT "artifact_comment_dispatches_user_id_request_id_fkey"
    FOREIGN KEY ("user_id", "request_id") REFERENCES "artifact_comment_dispatch_keys"("user_id", "request_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_comment_dispatches_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_comment_dispatches_request_event_id_fkey"
    FOREIGN KEY ("request_event_id") REFERENCES "task_events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "artifact_comment_dispatches_artifact_id_idx" ON "artifact_comment_dispatches"("artifact_id");
CREATE UNIQUE INDEX "artifact_comment_dispatches_request_event_id_key" ON "artifact_comment_dispatches"("request_event_id");
COMMIT;
