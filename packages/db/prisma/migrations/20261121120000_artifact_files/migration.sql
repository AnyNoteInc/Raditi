-- The files of an artifact (docs/plan/88-artifacts.md, Ар12, §7.1; slice 88.12): a photo, a picture or
-- a font a mockup shows by `artifact-file:<id>`. A person uploads it in the cabinet; the agent
-- reserves one of its outbox (`artifact_file_put`) and core writes it at the end of the turn. The
-- bytes are in the artifacts bucket under `artifacts/<workspaceId>/<artifactId>/<fileId>`. Only adds
-- a table, no stop: the code before never reads it.
BEGIN;
CREATE TABLE "artifact_files" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "object_key" VARCHAR(255) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(64) NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" CHAR(64),
    "state" VARCHAR(10) NOT NULL,
    "created_by_user_id" UUID,
    "task_id" UUID,
    "turn_no" INTEGER,
    "file_name" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(6),

    CONSTRAINT "artifact_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_files_state_check" CHECK (
      ("state" IN ('uploading', 'reserved') AND "sha256" IS NULL AND "ready_at" IS NULL)
      OR ("state" = 'ready' AND "sha256" IS NOT NULL AND "ready_at" IS NOT NULL AND "bytes" >= 0)
    ),
    -- A person's upload, or a file of the outbox of one turn.
    CONSTRAINT "artifact_files_author_check" CHECK (
      ("task_id" IS NULL AND "turn_no" IS NULL AND "file_name" IS NULL AND "state" <> 'reserved')
      OR ("task_id" IS NOT NULL AND "turn_no" IS NOT NULL AND "file_name" IS NOT NULL AND "state" <> 'uploading')
    )
);
CREATE INDEX "artifact_files_artifact_id_created_at_idx" ON "artifact_files"("artifact_id", "created_at");
CREATE UNIQUE INDEX "artifact_files_task_id_turn_no_file_name_key"
  ON "artifact_files"("task_id", "turn_no", "file_name");
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "artifact_files" ADD CONSTRAINT "artifact_files_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- `artifact_import` (§7.5): a `.md`, `.html`, `.svg` or `.csv` of the outbox becomes a new artifact
-- (its id named now) or the new content of one the chat may write, at the end of the turn.
CREATE TABLE "artifact_imports" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "artifact_id" UUID NOT NULL,
    "into_existing" BOOLEAN NOT NULL,
    "title" VARCHAR(200),
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(10) NOT NULL DEFAULT 'reserved',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "artifact_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_imports_state_check" CHECK ("state" IN ('reserved', 'done', 'refused'))
);
CREATE UNIQUE INDEX "artifact_imports_task_id_turn_no_file_name_key"
  ON "artifact_imports"("task_id", "turn_no", "file_name");
ALTER TABLE "artifact_imports" ADD CONSTRAINT "artifact_imports_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
