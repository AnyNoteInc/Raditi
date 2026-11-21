-- Owner's private quote notes (plan 88, Ар53, slice 88.18а); additive.
BEGIN;
CREATE TABLE "artifact_comments" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "block_key" VARCHAR(40) NOT NULL,
    "anchor" JSONB NOT NULL,
    "author_user_id" UUID,
    "body" VARCHAR(2000) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_comments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_comments_body_check" CHECK (length(btrim("body")) > 0),
    CONSTRAINT "artifact_comments_artifact_id_fkey"
      FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "artifact_comments_author_user_id_fkey"
      FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "artifact_comments_artifact_id_created_at_id_idx"
  ON "artifact_comments"("artifact_id", "created_at", "id");
CREATE INDEX "artifact_comments_author_user_id_idx" ON "artifact_comments"("author_user_id");
COMMIT;
