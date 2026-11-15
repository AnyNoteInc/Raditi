-- The files and texts of the context of a project (docs/plan/84-projects.md, ПР8; slice 84.8): a
-- file comes before its project, as an attachment before its chat — announced without a project
-- and with a day to be taken (`expires_at`), stored in raditi-inbox under
-- projects/<workspace_id>/<id>, then bound to a project, which keeps it while it lives. Adds only a
-- new table, so nothing stops and nothing is carried over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "project_files" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "uploaded_by_id" UUID,
    "kind" VARCHAR(8) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "media_type" VARCHAR(127) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64),
    "status" VARCHAR(10) NOT NULL DEFAULT 'uploading',
    "s3_key" VARCHAR(200) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_files_project_id_name_key" ON "project_files"("project_id", "name");

CREATE INDEX "project_files_workspace_id_idx" ON "project_files"("workspace_id");

CREATE INDEX "project_files_unbound_idx" ON "project_files"("expires_at") WHERE (project_id IS NULL);

ALTER TABLE "project_files" ADD CONSTRAINT "project_files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_files" ADD CONSTRAINT "project_files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as projectLimits, projectFilePath and
-- projectFileKey of @repo/domain: a file of 1 byte to 20 MiB; a path without `..`, without a slash
-- at its ends or a control character, at most eight parts; the key of its workspace and id; a file
-- without a project has its day to be taken, and only a stored one goes into a project.
ALTER TABLE "project_files"
  ADD CONSTRAINT "project_files_kind_check" CHECK ("kind" IN ('file', 'text')),
  ADD CONSTRAINT "project_files_status_check" CHECK ("status" IN ('uploading', 'ready')),
  ADD CONSTRAINT "project_files_size_check" CHECK ("size_bytes" BETWEEN 1 AND 20971520),
  ADD CONSTRAINT "project_files_sha256_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "project_files_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 255
    AND "name" !~ '(^|/)\.\.?(/|$)'
    AND "name" !~ '^/|/$|//'
    AND "name" !~ '[[:cntrl:]]'
    AND array_length(string_to_array("name", '/'), 1) <= 8
  ),
  ADD CONSTRAINT "project_files_key_check" CHECK (
    "s3_key" = 'projects/' || "workspace_id"::text || '/' || "id"::text
  ),
  ADD CONSTRAINT "project_files_unbound_check" CHECK ("project_id" IS NOT NULL OR "expires_at" IS NOT NULL),
  ADD CONSTRAINT "project_files_bound_ready_check" CHECK ("project_id" IS NULL OR "status" = 'ready');

COMMIT;
