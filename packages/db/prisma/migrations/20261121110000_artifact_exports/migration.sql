-- «Скачать → Excel» of a table (docs/plan/88-artifacts.md, §7.7, §7.13, question 26; slice 88.14):
-- core builds the workbook (`write-excel-file/node`) and puts it into the artifacts bucket under the
-- artifact's prefix; web serves it to the person who asked. One row a request; only adds a table,
-- no stop: the code before never reads it.
BEGIN;
CREATE TABLE "artifact_exports" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "state" VARCHAR(8) NOT NULL DEFAULT 'pending',
    "object_key" VARCHAR(255),
    "bytes" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(6),

    CONSTRAINT "artifact_exports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_exports_format_check" CHECK ("format" IN ('xlsx')),
    CONSTRAINT "artifact_exports_state_check" CHECK (
      ("state" = 'pending' AND "object_key" IS NULL)
      OR ("state" = 'ready' AND "object_key" IS NOT NULL AND "bytes" >= 0 AND "ready_at" IS NOT NULL)
      OR ("state" = 'failed' AND "object_key" IS NULL)
    )
);
CREATE INDEX "artifact_exports_artifact_id_created_at_idx" ON "artifact_exports"("artifact_id", "created_at");
ALTER TABLE "artifact_exports" ADD CONSTRAINT "artifact_exports_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_exports" ADD CONSTRAINT "artifact_exports_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
