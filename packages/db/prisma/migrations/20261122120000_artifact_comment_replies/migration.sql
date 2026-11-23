-- Private replies (plan 88, Ар53, 88.18б). Leave existing quote notes readable on rollback.
BEGIN;
CREATE TABLE "artifact_comment_replies" (
  "id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "author_user_id" UUID,
  "body" VARCHAR(2000) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_comment_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_comment_replies_body_check" CHECK (length(btrim("body")) > 0),
  CONSTRAINT "artifact_comment_replies_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "artifact_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_comment_replies_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_comment_replies_thread_id_request_id_key"
  ON "artifact_comment_replies"("thread_id", "request_id");
CREATE INDEX "artifact_comment_replies_author_user_id_idx"
  ON "artifact_comment_replies"("author_user_id");
COMMIT;
