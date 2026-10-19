-- «Отменить выпуск» (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): within seven days of
-- its installation the release a site runs can be undone — a new row of `site_releases` of the
-- kind `undo` in the dialog of that release, with the plan core worked out and the client
-- confirmed (`release_undo_plans`), which the same skill, release API and deploy job carry to the
-- site. Every row there is a release: they keep their candidate.
--
-- One transaction: Prisma sends a migration file in one request.
BEGIN;

CREATE TYPE "ReleaseKind" AS ENUM ('release', 'undo');
CREATE TYPE "UndoPlanStatus" AS ENUM ('pending', 'ready', 'failed');

-- What an undo of a release would do, as core read it from git and from production: the files
-- (counts and up to 200 paths), each object of the release's plan with its verdict, and the writes
-- of the undo — references, hashes and fields; values never are here.
CREATE TABLE "release_undo_plans" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    -- The release the plan would undo.
    "release_id" UUID NOT NULL,
    "requested_by" UUID,
    "status" "UndoPlanStatus" NOT NULL DEFAULT 'pending',
    -- `sites.installed_sha` the plan was made against: the commit of the release.
    "installed_sha" CHAR(40) NOT NULL,
    -- The tree of the undo commit: the version before the release, and the media it added.
    "target_tree" CHAR(40),
    "files" JSONB NOT NULL DEFAULT '{}',
    "items" JSONB NOT NULL DEFAULT '[]',
    "db_plan" JSONB NOT NULL DEFAULT '[]',
    "nothing_to_undo" BOOLEAN NOT NULL DEFAULT false,
    "plan_sha256" CHAR(64),
    "error_code" VARCHAR(48),
    -- Raised with every enqueue of `release.undoPlan`, in its transaction: the `seq` of the job.
    "enqueues" INTEGER NOT NULL DEFAULT 1,
    "computed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "release_undo_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "release_undo_plans_release_id_created_at_idx"
  ON "release_undo_plans"("release_id", "created_at" DESC);
CREATE INDEX "release_undo_plans_site_id_idx" ON "release_undo_plans"("site_id");
CREATE INDEX "release_undo_plans_requested_by_idx" ON "release_undo_plans"("requested_by");
CREATE INDEX "release_undo_plans_status_updated_at_idx"
  ON "release_undo_plans"("status", "updated_at");
ALTER TABLE "release_undo_plans"
  ADD CONSTRAINT "release_undo_plans_site_id_fkey" FOREIGN KEY ("site_id")
    REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "release_undo_plans_release_id_fkey" FOREIGN KEY ("release_id")
    REFERENCES "site_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "release_undo_plans_requested_by_fkey" FOREIGN KEY ("requested_by")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "release_undo_plans_ready_check" CHECK (
    "status" <> 'ready'
    OR ("target_tree" IS NOT NULL AND "plan_sha256" IS NOT NULL AND "computed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "release_undo_plans_failed_check"
    CHECK (("status" = 'failed') = ("error_code" IS NOT NULL)),
  ADD CONSTRAINT "release_undo_plans_hash_check" CHECK (
    "installed_sha" ~ '^[0-9a-f]{40}$'
    AND ("target_tree" IS NULL OR "target_tree" ~ '^[0-9a-f]{40}$')
    AND ("plan_sha256" IS NULL OR "plan_sha256" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "release_undo_plans_shape_check" CHECK (
    jsonb_typeof("files") = 'object' AND jsonb_typeof("items") = 'array'
    AND jsonb_typeof("db_plan") = 'array'
    AND octet_length("files"::text) <= 131072 AND octet_length("items"::text) <= 131072
    AND octet_length("db_plan"::text) <= 262144 AND "enqueues" >= 1
  ),
  ADD CONSTRAINT "release_undo_plans_error_code_check"
    CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z0-9_]{1,47}$');

-- A row is a release of a candidate or the undo of a release of the same site: an undo has no
-- candidate, names the release it undoes and the plan the client confirmed, and is a patch.
ALTER TABLE "site_releases"
  ADD COLUMN "kind" "ReleaseKind" NOT NULL DEFAULT 'release',
  ADD COLUMN "undoes_release_id" UUID,
  ADD COLUMN "undo_plan_id" UUID,
  ADD COLUMN "undo_plan_sha256" CHAR(64),
  ALTER COLUMN "candidate_id" DROP NOT NULL,
  ALTER COLUMN "candidate_revision" DROP NOT NULL;
ALTER TABLE "site_releases"
  ADD CONSTRAINT "site_releases_undoes_release_id_fkey" FOREIGN KEY ("undoes_release_id")
    REFERENCES "site_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_releases_undo_plan_id_fkey" FOREIGN KEY ("undo_plan_id")
    REFERENCES "release_undo_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "site_releases_kind_check" CHECK (
    ("kind" = 'release' AND "candidate_id" IS NOT NULL AND "candidate_revision" IS NOT NULL
      AND "undoes_release_id" IS NULL AND "undo_plan_id" IS NULL AND "undo_plan_sha256" IS NULL)
    OR ("kind" = 'undo' AND "candidate_id" IS NULL AND "candidate_revision" IS NULL
      AND "undoes_release_id" IS NOT NULL AND "undoes_release_id" <> "id"
      AND "undo_plan_id" IS NOT NULL AND "undo_plan_sha256" ~ '^[0-9a-f]{64}$'
      AND "bump" = 'patch')
  );
-- One undo of a release under way at a time; the n-th undo of a release once.
CREATE UNIQUE INDEX "site_releases_undo_open_key" ON "site_releases"("undoes_release_id") WHERE kind = 'undo' AND status <> ALL (ARRAY['failed'::"ReleaseStatus", 'rolled_back'::"ReleaseStatus", 'installed'::"ReleaseStatus"]);
CREATE UNIQUE INDEX "site_releases_undoes_release_id_attempt_key"
  ON "site_releases"("undoes_release_id", "attempt");
CREATE INDEX "site_releases_undo_plan_id_idx" ON "site_releases"("undo_plan_id");

COMMIT;
