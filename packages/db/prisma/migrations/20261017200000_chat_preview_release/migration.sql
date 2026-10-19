-- Chat → preview → /release (docs/plan/53-chat-preview-release.md, «Таблицы», «Перечисления»):
-- short aliases of sites and dialogs for preview addresses, the installed version of a site,
-- the head of a dialog and its feed, previews with their tickets, sessions and requests, the
-- database plan of a candidate, candidates and their checks, releases and their steps, and the
-- client's variables. Secrets stay in Vault; every column here is public, an id or a hash.
--
-- Expand only. Every existing row stays valid: the new columns are NULL or take their DEFAULT —
-- aliases are drawn per row by a volatile DEFAULT and redrawn where two collide — and each
-- replaced CHECK accepts everything its predecessor accepted.

-- A row of the journal marked visible, or a feed row hidden, would break the CHECK below; the
-- migration stops before its transaction (CLAUDE.md, «Как писать код»), so the message reaches
-- the operator. No writer has written feed rows yet, so this is not expected.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "task_events" WHERE "client_visible" IS DISTINCT FROM ("type" LIKE 'feed.%')
  ) THEN
    RAISE EXCEPTION 'task_events holds rows whose client_visible does not match the feed. prefix: fix them before applying 20261017200000_chat_preview_release';
  END IF;
END $$;

BEGIN;

-- ─── Enums ─────────────────────────────────────────────────────────────────────────────────────

CREATE TYPE "TaskMode" AS ENUM ('work', 'chat');
CREATE TYPE "TaskWaiting" AS ENUM ('agents', 'site');
CREATE TYPE "PreviewStatus" AS ENUM ('pending', 'building', 'ready', 'failed', 'unavailable', 'expired', 'destroyed');
CREATE TYPE "PreviewDbMode" AS ENUM ('copy', 'none');
CREATE TYPE "CandidateStatus" AS ENUM ('current', 'superseded', 'stale', 'released');
CREATE TYPE "CandidateCheckStatus" AS ENUM ('pending', 'passed', 'failed', 'stale');
CREATE TYPE "ReleaseStatus" AS ENUM ('approved', 'publishing', 'published', 'deploying', 'verifying', 'installed', 'rolling_back', 'rolled_back', 'failed', 'unknown');
CREATE TYPE "VersionBump" AS ENUM ('patch', 'minor', 'major');
CREATE TYPE "DbOperationKind" AS ENUM ('content_update');
-- Not used in this transaction (55P04 forbids that): no row and no CHECK below names them.
ALTER TYPE "DeployMethod" ADD VALUE 'sftp';
ALTER TYPE "DeployMethod" ADD VALUE 'ftp';

-- ─── Sites, tasks, the feed ────────────────────────────────────────────────────────────────────

ALTER TABLE "sites"
  ADD COLUMN "alias" VARCHAR(12) NOT NULL DEFAULT substr(md5(gen_random_uuid()::text), 1, 8),
  ADD COLUMN "installed_version" VARCHAR(32),
  ADD COLUMN "installed_sha" CHAR(40),
  ADD COLUMN "installed_at" TIMESTAMPTZ(6),
  ADD COLUMN "installed_release_id" UUID;

ALTER TABLE "tasks"
  ADD COLUMN "alias" VARCHAR(12) NOT NULL DEFAULT substr(md5(gen_random_uuid()::text), 1, 6),
  ADD COLUMN "title" VARCHAR(120),
  ADD COLUMN "mode" "TaskMode" NOT NULL DEFAULT 'work',
  ADD COLUMN "waiting" "TaskWaiting";

-- Eight hex characters per site and six per dialog of a site: a collision is unlikely, never
-- impossible. Redraw the later row of every pair until none is left, then make them unique.
DO $$
BEGIN
  LOOP
    UPDATE "sites" SET "alias" = substr(md5(gen_random_uuid()::text), 1, 8)
    WHERE "id" IN (
      SELECT "id" FROM (
        SELECT "id", row_number() OVER (PARTITION BY "alias" ORDER BY "id") AS "n" FROM "sites"
      ) AS "ranked" WHERE "n" > 1
    );
    EXIT WHEN NOT FOUND;
  END LOOP;
  LOOP
    UPDATE "tasks" SET "alias" = substr(md5(gen_random_uuid()::text), 1, 6)
    WHERE "id" IN (
      SELECT "id" FROM (
        SELECT "id", row_number() OVER (PARTITION BY "site_id", "alias" ORDER BY "id") AS "n" FROM "tasks"
      ) AS "ranked" WHERE "n" > 1
    );
    EXIT WHEN NOT FOUND;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "sites_alias_key" ON "sites"("alias");
CREATE UNIQUE INDEX "tasks_site_id_alias_key" ON "tasks"("site_id", "alias");

-- An alias is the database's own (Р17): the DEFAULT draws it, and an insert whose alias is taken
-- draws again until it is free — a site's across the platform, a dialog's within its site — so
-- no writer meets the UNIQUE index by chance. Two inserts that draw the same free alias at the
-- same instant still meet it; at 16^8 and 16^6 that is not a case to design for.
CREATE FUNCTION "raditi_sites_free_alias"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  WHILE EXISTS (SELECT 1 FROM "sites" WHERE "alias" = NEW."alias") LOOP
    NEW."alias" := substr(md5(gen_random_uuid()::text), 1, 8);
  END LOOP;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "sites_free_alias" BEFORE INSERT ON "sites"
  FOR EACH ROW EXECUTE FUNCTION "raditi_sites_free_alias"();

CREATE FUNCTION "raditi_tasks_free_alias"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  WHILE EXISTS (
    SELECT 1 FROM "tasks" WHERE "site_id" = NEW."site_id" AND "alias" = NEW."alias"
  ) LOOP
    NEW."alias" := substr(md5(gen_random_uuid()::text), 1, 6);
  END LOOP;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "tasks_free_alias" BEFORE INSERT ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION "raditi_tasks_free_alias"();
CREATE INDEX "tasks_site_updated_idx" ON "tasks"("site_id", "updated_at" DESC);
-- What a reader of the feed reads; the journal of a turn stays off its path.
CREATE INDEX "task_events_feed_idx" ON "task_events"("task_id", "id") WHERE client_visible;

ALTER TABLE "site_leases" ADD COLUMN "inflight_release_id" UUID;
CREATE UNIQUE INDEX "site_leases_inflight_release_id_key" ON "site_leases"("inflight_release_id");

-- A deploy of a release has no environment row: the hosting is the site's own access.
ALTER TABLE "deployments"
  ALTER COLUMN "environment_id" DROP NOT NULL,
  ADD COLUMN "release_id" UUID,
  ADD COLUMN "tag" VARCHAR(32),
  ADD COLUMN "version" VARCHAR(32);
CREATE UNIQUE INDEX "deployments_release_id_key" ON "deployments"("release_id");

-- ─── Previews ──────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "preview_environments" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "status" "PreviewStatus" NOT NULL DEFAULT 'pending',
    "db_mode" "PreviewDbMode" NOT NULL DEFAULT 'none',
    "unavailable_reason" VARCHAR(32),
    "hostname" VARCHAR(253) NOT NULL,
    "candidate_id" UUID,
    "files_sha" CHAR(40),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    "runtime" JSONB,
    "upstream_host" VARCHAR(253),
    "upstream_port" INTEGER,
    "access_epoch" INTEGER NOT NULL DEFAULT 0,
    "write_epoch" INTEGER NOT NULL DEFAULT 0,
    "seed_object_key" VARCHAR(1024),
    "seed_sha256" CHAR(64),
    "seed_release_id" UUID,
    "lease_epoch" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMPTZ(6),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "enqueues" INTEGER NOT NULL DEFAULT 1,
    "error_code" VARCHAR(48),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_viewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "preview_environments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "preview_tickets" (
    "id" UUID NOT NULL,
    "preview_id" UUID NOT NULL,
    "user_id" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "preview_sessions" (
    "id" UUID NOT NULL,
    "preview_id" UUID NOT NULL,
    "user_id" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "access_epoch" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "preview_sync_requests" (
    "id" UUID NOT NULL,
    "preview_id" UUID NOT NULL,
    "assignment_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "files_digest" CHAR(64),
    "error_code" VARCHAR(48),

    CONSTRAINT "preview_sync_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "preview_browser_requests" (
    "id" UUID NOT NULL,
    "preview_id" UUID NOT NULL,
    "assignment_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(6),
    "stopped_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(48),

    CONSTRAINT "preview_browser_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "preview_db_operations" (
    "id" BIGSERIAL NOT NULL,
    "task_id" UUID NOT NULL,
    "preview_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "mcp_call_id" UUID NOT NULL,
    "kind" "DbOperationKind" NOT NULL,
    "object_ref" VARCHAR(128) NOT NULL,
    "fields" TEXT[] NOT NULL,
    "before_hash" CHAR(64) NOT NULL,
    "after_hash" CHAR(64) NOT NULL,
    "after_object_key" VARCHAR(1024) NOT NULL,
    "after_sha256" CHAR(64) NOT NULL,
    "after_bytes" INTEGER NOT NULL,
    "before_object_key" VARCHAR(1024) NOT NULL,
    "before_sha256" CHAR(64) NOT NULL,
    "before_bytes" INTEGER NOT NULL,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_db_operations_pkey" PRIMARY KEY ("id")
);

-- The content journal gets a target besides the production site: a preview (Р24).
ALTER TABLE "mcp_calls"
  ADD COLUMN "preview_id" UUID,
  ADD COLUMN "preview_write_epoch" INTEGER;
ALTER TABLE "snapshots" ADD COLUMN "preview_id" UUID;

-- ─── Candidates and releases ───────────────────────────────────────────────────────────────────

CREATE TABLE "task_candidates" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "status" "CandidateStatus" NOT NULL DEFAULT 'current',
    "base_sha" CHAR(40) NOT NULL,
    "base_tree" CHAR(40) NOT NULL,
    "base_version" VARCHAR(32),
    "head_sha" CHAR(40) NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "media" JSONB NOT NULL DEFAULT '[]',
    "db_plan" JSONB NOT NULL DEFAULT '[]',
    "db_plan_sha256" CHAR(64) NOT NULL,
    "proposed_bump" "VersionBump" NOT NULL,
    "proposed_version" VARCHAR(32) NOT NULL,
    "facts" JSONB NOT NULL,
    "preview_revision" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "candidate_checks" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "status" "CandidateCheckStatus" NOT NULL DEFAULT 'pending',
    "summary" JSONB,
    "artifact_key" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "candidate_checks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_releases" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "candidate_revision" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "release_key" CHAR(64) NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "tag" VARCHAR(32) NOT NULL,
    "bump" "VersionBump" NOT NULL,
    "main_before_sha" CHAR(40) NOT NULL,
    "installed_before_sha" CHAR(40),
    "approved_sha" CHAR(40),
    "committed_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'approved',
    "step" VARCHAR(32),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6) NOT NULL,
    "deployment_id" UUID,
    "deploy_attempt" INTEGER NOT NULL DEFAULT 0,
    "deploy_token_hash" CHAR(64),
    "deploy_token_expires_at" TIMESTAMPTZ(6),
    "wrap_accessor" VARCHAR(128),
    "access_issued_at" TIMESTAMPTZ(6),
    "backup_object_key" VARCHAR(1024),
    "backup_sha256" CHAR(64),
    "backup_bytes" BIGINT,
    "backup_verified_at" TIMESTAMPTZ(6),
    "main_pushed_at" TIMESTAMPTZ(6),
    "revert_sha" CHAR(40),
    "lease_epoch" INTEGER NOT NULL DEFAULT 0,
    "enqueues" INTEGER NOT NULL DEFAULT 1,
    "error_code" VARCHAR(48),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "release_steps" (
    "id" BIGSERIAL NOT NULL,
    "release_id" UUID NOT NULL,
    "deploy_attempt" INTEGER NOT NULL,
    "step" VARCHAR(32) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "report_key" VARCHAR(128) NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "site_env_vars" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "hosts" JSONB NOT NULL DEFAULT '[]',
    "to_agent" BOOLEAN NOT NULL DEFAULT false,
    "to_preview" BOOLEAN NOT NULL DEFAULT true,
    "agent_consent_at" TIMESTAMPTZ(6),
    "agent_consent_by" UUID,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_env_vars_pkey" PRIMARY KEY ("id")
);

-- ─── Indexes ───────────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "preview_environments_task_id_key" ON "preview_environments"("task_id");
CREATE UNIQUE INDEX "preview_environments_hostname_key" ON "preview_environments"("hostname");
CREATE INDEX "preview_environments_site_id_idx" ON "preview_environments"("site_id");
CREATE INDEX "preview_environments_candidate_id_idx" ON "preview_environments"("candidate_id");
CREATE INDEX "preview_environments_seed_release_id_idx" ON "preview_environments"("seed_release_id");
CREATE INDEX "preview_environments_status_expires_at_idx" ON "preview_environments"("status", "expires_at");
CREATE UNIQUE INDEX "preview_tickets_token_hash_key" ON "preview_tickets"("token_hash");
CREATE INDEX "preview_tickets_preview_id_idx" ON "preview_tickets"("preview_id");
CREATE INDEX "preview_tickets_user_id_idx" ON "preview_tickets"("user_id");
CREATE INDEX "preview_tickets_expires_at_idx" ON "preview_tickets"("expires_at");
CREATE INDEX "preview_sessions_preview_id_idx" ON "preview_sessions"("preview_id");
CREATE INDEX "preview_sessions_user_id_idx" ON "preview_sessions"("user_id");
CREATE INDEX "preview_sessions_expires_at_idx" ON "preview_sessions"("expires_at");
CREATE INDEX "preview_sync_requests_preview_id_idx" ON "preview_sync_requests"("preview_id");
CREATE INDEX "preview_sync_requests_assignment_id_idx" ON "preview_sync_requests"("assignment_id");
CREATE INDEX "preview_browser_requests_preview_id_idx" ON "preview_browser_requests"("preview_id");
CREATE INDEX "preview_browser_requests_assignment_id_idx" ON "preview_browser_requests"("assignment_id");
CREATE UNIQUE INDEX "preview_db_operations_task_id_mcp_call_id_key" ON "preview_db_operations"("task_id", "mcp_call_id");
CREATE INDEX "preview_db_operations_preview_id_id_idx" ON "preview_db_operations"("preview_id", "id");
CREATE INDEX "preview_db_operations_mcp_call_id_idx" ON "preview_db_operations"("mcp_call_id");
CREATE INDEX "mcp_calls_preview_id_idx" ON "mcp_calls"("preview_id");
CREATE INDEX "snapshots_preview_id_idx" ON "snapshots"("preview_id");
CREATE UNIQUE INDEX "task_candidates_task_id_revision_key" ON "task_candidates"("task_id", "revision");
-- One current candidate per dialog.
CREATE UNIQUE INDEX "task_candidates_current_key" ON "task_candidates"("task_id") WHERE status = 'current'::"CandidateStatus";
CREATE INDEX "candidate_checks_candidate_id_kind_idx" ON "candidate_checks"("candidate_id", "kind");
CREATE UNIQUE INDEX "site_releases_release_key_key" ON "site_releases"("release_key");
CREATE UNIQUE INDEX "site_releases_site_id_version_key" ON "site_releases"("site_id", "version");
CREATE UNIQUE INDEX "site_releases_candidate_id_attempt_key" ON "site_releases"("candidate_id", "attempt");
CREATE UNIQUE INDEX "site_releases_deployment_id_key" ON "site_releases"("deployment_id");
-- One release of a candidate in work at a time (`unknown` counts as in work).
CREATE UNIQUE INDEX "site_releases_candidate_open_key" ON "site_releases"("candidate_id") WHERE status <> ALL (ARRAY['failed'::"ReleaseStatus", 'rolled_back'::"ReleaseStatus", 'installed'::"ReleaseStatus"]);
CREATE INDEX "site_releases_site_id_created_at_idx" ON "site_releases"("site_id", "created_at" DESC);
CREATE INDEX "site_releases_task_id_idx" ON "site_releases"("task_id");
CREATE INDEX "site_releases_approved_by_idx" ON "site_releases"("approved_by");
CREATE INDEX "site_releases_status_updated_at_idx" ON "site_releases"("status", "updated_at");
CREATE UNIQUE INDEX "release_steps_release_id_report_key_key" ON "release_steps"("release_id", "report_key");
CREATE UNIQUE INDEX "site_env_vars_site_id_name_key" ON "site_env_vars"("site_id", "name");
CREATE INDEX "site_env_vars_agent_consent_by_idx" ON "site_env_vars"("agent_consent_by");
CREATE INDEX "site_env_vars_created_by_idx" ON "site_env_vars"("created_by");
CREATE INDEX "sites_installed_release_id_idx" ON "sites"("installed_release_id");

-- ─── Foreign keys ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE "sites" ADD CONSTRAINT "sites_installed_release_id_fkey" FOREIGN KEY ("installed_release_id") REFERENCES "site_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_inflight_release_id_fkey" FOREIGN KEY ("inflight_release_id") REFERENCES "site_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "site_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "preview_environments" ADD CONSTRAINT "preview_environments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "preview_environments" ADD CONSTRAINT "preview_environments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_environments" ADD CONSTRAINT "preview_environments_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "task_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "preview_environments" ADD CONSTRAINT "preview_environments_seed_release_id_fkey" FOREIGN KEY ("seed_release_id") REFERENCES "site_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "preview_tickets" ADD CONSTRAINT "preview_tickets_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_tickets" ADD CONSTRAINT "preview_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_sessions" ADD CONSTRAINT "preview_sessions_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_sessions" ADD CONSTRAINT "preview_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_sync_requests" ADD CONSTRAINT "preview_sync_requests_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_sync_requests" ADD CONSTRAINT "preview_sync_requests_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "turn_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "preview_browser_requests" ADD CONSTRAINT "preview_browser_requests_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_browser_requests" ADD CONSTRAINT "preview_browser_requests_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "turn_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "preview_db_operations" ADD CONSTRAINT "preview_db_operations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_db_operations" ADD CONSTRAINT "preview_db_operations_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "preview_db_operations" ADD CONSTRAINT "preview_db_operations_mcp_call_id_fkey" FOREIGN KEY ("mcp_call_id") REFERENCES "mcp_calls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_candidates" ADD CONSTRAINT "task_candidates_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "candidate_checks" ADD CONSTRAINT "candidate_checks_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "task_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_releases" ADD CONSTRAINT "site_releases_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_releases" ADD CONSTRAINT "site_releases_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_releases" ADD CONSTRAINT "site_releases_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "task_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_releases" ADD CONSTRAINT "site_releases_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "site_releases" ADD CONSTRAINT "site_releases_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "release_steps" ADD CONSTRAINT "release_steps_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "site_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_env_vars" ADD CONSTRAINT "site_env_vars_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_env_vars" ADD CONSTRAINT "site_env_vars_agent_consent_by_fkey" FOREIGN KEY ("agent_consent_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "site_env_vars" ADD CONSTRAINT "site_env_vars_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Hand-written constraints (Prisma does not see CHECKs) ─────────────────────────────────────

ALTER TABLE "sites"
  ADD CONSTRAINT "sites_alias_check" CHECK ("alias" ~ '^[0-9a-z]{4,12}$'),
  -- The installed version is a version, its commit and its time together; a release is optional
  -- (the version of the import has none).
  ADD CONSTRAINT "sites_installed_check" CHECK (
    ("installed_version" IS NULL AND "installed_sha" IS NULL AND "installed_at" IS NULL AND "installed_release_id" IS NULL)
    OR ("installed_version" IS NOT NULL AND "installed_version" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$'
      AND "installed_sha" IS NOT NULL AND "installed_sha" ~ '^[0-9a-f]{40}$'
      AND "installed_at" IS NOT NULL)
  );

ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_alias_check" CHECK ("alias" ~ '^[0-9a-z]{4,12}$'),
  -- Why a task waits in the queue: cleared when it leaves `queued`.
  ADD CONSTRAINT "tasks_waiting_check" CHECK ("waiting" IS NULL OR "status" = 'queued');

-- A journal row is never visible, a feed row never hidden.
ALTER TABLE "task_events"
  ADD CONSTRAINT "task_events_feed_visible_check" CHECK ("client_visible" = ("type" LIKE 'feed.%'));

-- The release barrier stands only under the lease of a deploy; acquire, release and free leave a
-- lease with a barrier alone (PostgresSiteLeaseStore), so they never meet this CHECK.
ALTER TABLE "site_leases"
  ADD CONSTRAINT "site_leases_release_barrier_check" CHECK (
    "inflight_release_id" IS NULL OR ("holder_task_id" IS NOT NULL AND "operation" IS NOT NULL
      AND "operation" = 'deploy'::"LeaseOperation")
  );

ALTER TABLE "deployments"
  -- A deploy of a release needs no environment row; any other deploy keeps one.
  ADD CONSTRAINT "deployments_target_check" CHECK ("environment_id" IS NOT NULL OR "release_id" IS NOT NULL),
  ADD CONSTRAINT "deployments_version_check" CHECK (
    ("tag" IS NULL OR "tag" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$')
    AND ("version" IS NULL OR "version" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$')
  );

-- Four shapes of a journal row, and nothing between them: the three of 20261004100000_mcp_host_undo,
-- each now without a preview, and a call of the agent that writes to a preview (Р24). Such a call
-- is admitted under the turn lease like any call of the agent; its write is fenced by the write
-- epoch of the preview, never by the site's barrier.
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_managed_binding_check";
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_managed_binding_check" CHECK (
  -- Written before the journal: no owner and no journal field.
  ("assignment_id" IS NULL AND "credential_key_id" IS NULL
    AND "host_task_id" IS NULL AND "host_operation" IS NULL
    AND "preview_id" IS NULL AND "preview_write_epoch" IS NULL
    AND "request_hash" IS NULL AND "lease_epoch" IS NULL AND "write_started_at" IS NULL)
  -- A call of the agent on the production site: its assignment and its turn key.
  OR ("assignment_id" IS NOT NULL AND "credential_key_id" IS NOT NULL
    AND "host_task_id" IS NULL AND "host_operation" IS NULL
    AND "preview_id" IS NULL AND "preview_write_epoch" IS NULL
    AND "request_hash" IS NOT NULL AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "lease_epoch" IS NOT NULL AND "lease_epoch" > 0
    AND "snapshot_id" IS NOT NULL AND "object_ref" IS NOT NULL)
  -- A call of the trusted host: the holder of the site lease and its operation, only a restore.
  OR ("assignment_id" IS NULL AND "credential_key_id" IS NULL
    AND "host_task_id" IS NOT NULL AND "host_operation" IS NOT NULL
    AND "host_operation" IN ('turn'::"LeaseOperation", 'revert'::"LeaseOperation")
    AND "preview_id" IS NULL AND "preview_write_epoch" IS NULL
    AND "tool" = 'restore' AND "restores_snapshot_id" IS NOT NULL
    AND "request_hash" IS NOT NULL AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "lease_epoch" IS NOT NULL AND "lease_epoch" > 0
    AND "snapshot_id" IS NOT NULL AND "object_ref" IS NOT NULL)
  -- A call of the agent on its dialog's preview: the assignment, the key, the preview and its
  -- write epoch.
  OR ("assignment_id" IS NOT NULL AND "credential_key_id" IS NOT NULL
    AND "host_task_id" IS NULL AND "host_operation" IS NULL
    AND "preview_id" IS NOT NULL AND "preview_write_epoch" IS NOT NULL AND "preview_write_epoch" >= 0
    AND "request_hash" IS NOT NULL AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "lease_epoch" IS NOT NULL AND "lease_epoch" > 0
    AND "snapshot_id" IS NOT NULL AND "object_ref" IS NOT NULL)
);

ALTER TABLE "preview_environments"
  ADD CONSTRAINT "preview_environments_hostname_check"
    CHECK ("hostname" ~ '^site-[0-9a-z]{4,12}-chat-[0-9a-z]{4,12}\.[a-z0-9.-]+$'),
  ADD CONSTRAINT "preview_environments_unavailable_check" CHECK (
    ("status" = 'unavailable') = ("unavailable_reason" IS NOT NULL)
    AND ("unavailable_reason" IS NULL OR "unavailable_reason" ~ '^[a-z][a-z_]{1,31}$')
  ),
  ADD CONSTRAINT "preview_environments_error_check" CHECK (
    ("status" = 'failed') = ("error_code" IS NOT NULL)
    AND ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z0-9_]{1,47}$')
  ),
  ADD CONSTRAINT "preview_environments_files_sha_check"
    CHECK ("files_sha" IS NULL OR "files_sha" ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT "preview_environments_counters_check" CHECK (
    "revision" >= 0 AND "access_epoch" >= 0 AND "write_epoch" >= 0 AND "lease_epoch" >= 0
    AND "attempt" >= 1 AND "enqueues" >= 1
  ),
  ADD CONSTRAINT "preview_environments_upstream_check" CHECK (
    ("upstream_host" IS NULL AND "upstream_port" IS NULL)
    OR ("upstream_host" IS NOT NULL AND "upstream_port" IS NOT NULL AND "upstream_port" BETWEEN 1 AND 65535)
  ),
  ADD CONSTRAINT "preview_environments_seed_check" CHECK (
    ("seed_object_key" IS NULL AND "seed_sha256" IS NULL)
    OR ("seed_object_key" IS NOT NULL AND "seed_sha256" IS NOT NULL AND "seed_sha256" ~ '^[0-9a-f]{64}$')
  ),
  -- Handles of containers and networks, never a secret.
  ADD CONSTRAINT "preview_environments_runtime_check" CHECK (
    "runtime" IS NULL OR (jsonb_typeof("runtime") = 'object' AND octet_length("runtime"::text) <= 8192)
  );

ALTER TABLE "preview_tickets"
  ADD CONSTRAINT "preview_tickets_kind_check" CHECK (
    ("kind" = 'user' AND "user_id" IS NOT NULL) OR ("kind" = 'browser' AND "user_id" IS NULL)
  ),
  ADD CONSTRAINT "preview_tickets_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "preview_sessions"
  ADD CONSTRAINT "preview_sessions_kind_check" CHECK (
    ("kind" = 'user' AND "user_id" IS NOT NULL) OR ("kind" = 'browser' AND "user_id" IS NULL)
  ),
  ADD CONSTRAINT "preview_sessions_access_epoch_check" CHECK ("access_epoch" >= 0);

ALTER TABLE "preview_sync_requests"
  ADD CONSTRAINT "preview_sync_requests_result_check" CHECK (
    ("files_digest" IS NULL OR "files_digest" ~ '^[0-9a-f]{64}$')
    AND ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z0-9_]{1,47}$')
    AND ("completed_at" IS NOT NULL OR ("files_digest" IS NULL AND "error_code" IS NULL))
  );

ALTER TABLE "preview_browser_requests"
  ADD CONSTRAINT "preview_browser_requests_error_check"
    CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z0-9_]{1,47}$');

ALTER TABLE "preview_db_operations"
  ADD CONSTRAINT "preview_db_operations_object_check" CHECK (
    "turn_no" >= 1
    AND "object_ref" ~ '^[a-z][a-z_]{0,31}:[1-9][0-9]{0,18}$'
    AND "before_hash" ~ '^[0-9a-f]{64}$' AND "after_hash" ~ '^[0-9a-f]{64}$'
  ),
  -- The fields of `content_update`, each once, in the one order (orderDbContentFields).
  ADD CONSTRAINT "preview_db_operations_fields_check" CHECK (
    "fields" IN (
      '{title}'::text[], '{content}'::text[], '{excerpt}'::text[],
      '{title,content}'::text[], '{title,excerpt}'::text[], '{content,excerpt}'::text[],
      '{title,content,excerpt}'::text[]
    )
  ),
  -- Each side is an encrypted object of at most twice a 32 KiB state (dbValueRefSchema).
  ADD CONSTRAINT "preview_db_operations_values_check" CHECK (
    "before_sha256" ~ '^[0-9a-f]{64}$' AND "after_sha256" ~ '^[0-9a-f]{64}$'
    AND "before_bytes" BETWEEN 1 AND 65536 AND "after_bytes" BETWEEN 1 AND 65536
  );

ALTER TABLE "task_candidates"
  ADD CONSTRAINT "task_candidates_counters_check" CHECK (
    "revision" >= 1 AND "turn_no" >= 1 AND ("preview_revision" IS NULL OR "preview_revision" >= 0)
  ),
  ADD CONSTRAINT "task_candidates_sha_check" CHECK (
    "base_sha" ~ '^[0-9a-f]{40}$' AND "base_tree" ~ '^[0-9a-f]{40}$' AND "head_sha" ~ '^[0-9a-f]{40}$'
    AND "db_plan_sha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "task_candidates_version_check" CHECK (
    "proposed_version" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$'
    AND ("base_version" IS NULL OR "base_version" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$')
  ),
  ADD CONSTRAINT "task_candidates_json_check" CHECK (
    jsonb_typeof("files") = 'array' AND jsonb_typeof("media") = 'array'
    AND jsonb_typeof("db_plan") = 'array' AND jsonb_typeof("facts") = 'object'
    AND octet_length("files"::text) <= 4194304 AND octet_length("media"::text) <= 1048576
    AND octet_length("db_plan"::text) <= 1048576 AND octet_length("facts"::text) <= 4096
  ),
  ADD CONSTRAINT "task_candidates_superseded_check"
    CHECK (("status" = 'superseded') = ("superseded_at" IS NOT NULL));

ALTER TABLE "candidate_checks"
  ADD CONSTRAINT "candidate_checks_kind_check"
    CHECK ("kind" IN ('php_lint', 'preview_smoke', 'agent_browser')),
  ADD CONSTRAINT "candidate_checks_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "candidate_checks_finished_check"
    CHECK ("status" NOT IN ('passed', 'failed') OR "finished_at" IS NOT NULL),
  -- Counts and codes only; never a path, a host or a message.
  ADD CONSTRAINT "candidate_checks_summary_check" CHECK (
    "summary" IS NULL OR (jsonb_typeof("summary") = 'object' AND octet_length("summary"::text) <= 4096)
  );

ALTER TABLE "site_releases"
  ADD CONSTRAINT "site_releases_counters_check" CHECK (
    "candidate_revision" >= 1 AND "attempt" >= 1 AND "deploy_attempt" >= 0 AND "lease_epoch" >= 0
    AND "enqueues" >= 1 AND ("backup_bytes" IS NULL OR "backup_bytes" >= 0)
  ),
  ADD CONSTRAINT "site_releases_version_check" CHECK (
    "version" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$' AND "tag" ~ '^v\d{1,9}\.\d{1,9}\.\d{1,9}$'
  ),
  ADD CONSTRAINT "site_releases_hash_check" CHECK (
    "release_key" ~ '^[0-9a-f]{64}$'
    AND "main_before_sha" ~ '^[0-9a-f]{40}$'
    AND ("installed_before_sha" IS NULL OR "installed_before_sha" ~ '^[0-9a-f]{40}$')
    AND ("approved_sha" IS NULL OR "approved_sha" ~ '^[0-9a-f]{40}$')
    AND ("revert_sha" IS NULL OR "revert_sha" ~ '^[0-9a-f]{40}$')
    AND ("deploy_token_hash" IS NULL OR "deploy_token_hash" ~ '^[0-9a-f]{64}$')
    AND ("backup_sha256" IS NULL OR "backup_sha256" ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "site_releases_step_check" CHECK (
    "step" IS NULL OR "step" IN ('conflicts', 'backup', 'files', 'db', 'verify', 'rollback', 'reverify')
  ),
  ADD CONSTRAINT "site_releases_error_code_check"
    CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z0-9_]{1,47}$'),
  -- The commit of a release exists from `published` on.
  ADD CONSTRAINT "site_releases_approved_sha_check" CHECK (
    "approved_sha" IS NOT NULL OR "status" IN ('approved', 'publishing', 'failed')
  ),
  -- Whether the release commit reached `main` decides `failed` from `refused` (releaseOutcomeOf):
  -- unknown while publishing, set from `published` on, never before the commit exists; only a
  -- release on `main` gets a revert commit.
  ADD CONSTRAINT "site_releases_main_pushed_check" CHECK (
    ("main_pushed_at" IS NULL OR "approved_sha" IS NOT NULL)
    AND ("main_pushed_at" IS NULL OR "status" <> 'approved')
    AND ("main_pushed_at" IS NOT NULL OR "status" IN ('approved', 'publishing', 'failed'))
    AND ("revert_sha" IS NULL OR "main_pushed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "site_releases_deploy_token_check"
    CHECK (("deploy_token_hash" IS NULL) = ("deploy_token_expires_at" IS NULL)),
  ADD CONSTRAINT "site_releases_backup_check" CHECK (
    ("backup_object_key" IS NULL AND "backup_sha256" IS NULL AND "backup_bytes" IS NULL AND "backup_verified_at" IS NULL)
    OR ("backup_object_key" IS NOT NULL AND "backup_sha256" IS NOT NULL AND "backup_bytes" IS NOT NULL)
  );

ALTER TABLE "release_steps"
  ADD CONSTRAINT "release_steps_step_check"
    CHECK ("step" IN ('conflicts', 'backup', 'files', 'db', 'verify', 'rollback', 'reverify')),
  ADD CONSTRAINT "release_steps_state_check"
    CHECK ("state" IN ('started', 'succeeded', 'failed', 'unknown')),
  ADD CONSTRAINT "release_steps_attempt_check" CHECK ("deploy_attempt" >= 1),
  ADD CONSTRAINT "release_steps_report_key_check" CHECK ("report_key" ~ '^[A-Za-z0-9:_-]{1,128}$'),
  -- Counts and a code only (releaseStepDetailSchema).
  ADD CONSTRAINT "release_steps_detail_check"
    CHECK (jsonb_typeof("detail") = 'object' AND octet_length("detail"::text) <= 2048);

ALTER TABLE "site_env_vars"
  -- The allow pattern and the names the shell, the runtime or the platform reads
  -- (envVarNameProblem in @repo/domain): the form refuses them, the table as well.
  ADD CONSTRAINT "site_env_vars_name_check" CHECK (
    "name" ~ '^[A-Z][A-Z0-9_]{1,63}$'
    AND "name" !~ '^(LD_|DYLD_|NODE_|BUN_|OPENCODE_|RADITI_|GIT_|SSL_|PHP_|WP_|DB_|HTTP_|HTTPS_|XDG_|AUTH_|SECURE_|LOGGED_IN_|NONCE_)'
    AND "name" !~ '_PROXY$'
    AND "name" NOT IN ('NO_PROXY', 'PATH', 'HOME', 'SHELL', 'TMPDIR', 'BASH_ENV', 'ENV')
  ),
  -- CASE: AND does not promise to test the type first, and the length of a non-array throws.
  ADD CONSTRAINT "site_env_vars_hosts_check" CHECK (
    CASE WHEN jsonb_typeof("hosts") = 'array' THEN jsonb_array_length("hosts") <= 16 ELSE false END
  ),
  -- The agent gets a variable only with the recorded consent.
  ADD CONSTRAINT "site_env_vars_agent_check" CHECK (NOT "to_agent" OR "agent_consent_at" IS NOT NULL),
  ADD CONSTRAINT "site_env_vars_key_version_check" CHECK ("key_version" >= 1);

COMMIT;
