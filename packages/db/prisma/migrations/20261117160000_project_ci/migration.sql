-- The builds, the logs of their jobs and the deploy actions of a project repository
-- (docs/plan/84-projects.md, ПР15, ПР17, §4.1; slice 84.21). Core polls the provider (`git.poll`)
-- and keeps what it read: the newest runs with their jobs, the masked tail of a log for 24 hours,
-- the manual jobs of the head of the default branch. Web and `mcp` read these rows only. Adds a
-- nullable column and new tables, so nothing stops and nothing is carried over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

ALTER TABLE "project_repositories" ADD COLUMN "ci_polled_at" TIMESTAMPTZ(6);

CREATE TABLE "project_ci_runs" (
    "project_repository_id" UUID NOT NULL,
    "provider_run_id" VARCHAR(40) NOT NULL,
    "ref" VARCHAR(255) NOT NULL,
    "sha" CHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "event" VARCHAR(40),
    "status" VARCHAR(8) NOT NULL,
    "refusal" VARCHAR(24),
    "web_url" VARCHAR(500) NOT NULL,
    "jobs" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_ci_runs_pkey" PRIMARY KEY ("project_repository_id","provider_run_id")
);

CREATE TABLE "project_ci_logs" (
    "project_repository_id" UUID NOT NULL,
    "provider_job_id" VARCHAR(40) NOT NULL,
    "state" VARCHAR(8) NOT NULL,
    "text" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "fetched_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_ci_logs_pkey" PRIMARY KEY ("project_repository_id","provider_job_id")
);

CREATE TABLE "project_deploy_actions" (
    "project_repository_id" UUID NOT NULL,
    "ref" VARCHAR(255) NOT NULL,
    "sha" CHAR(40) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "provider_action_id" VARCHAR(200) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_deploy_actions_pkey" PRIMARY KEY ("project_repository_id","kind","provider_action_id")
);

CREATE INDEX "project_ci_runs_newest_idx" ON "project_ci_runs"("project_repository_id", "created_at" DESC);

CREATE INDEX "project_ci_logs_expires_at_idx" ON "project_ci_logs"("expires_at");

ALTER TABLE "project_ci_runs" ADD CONSTRAINT "project_ci_runs_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_ci_logs" ADD CONSTRAINT "project_ci_logs_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_deploy_actions" ADD CONSTRAINT "project_deploy_actions_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as ciStatuses, ciRefusals and
-- repoCiLogStates of @repo/domain; a kept log is at most REPO_CI_LOG_BYTES.
ALTER TABLE "project_ci_runs"
  ADD CONSTRAINT "project_ci_runs_status_check"
    CHECK ("status" IN ('pending', 'running', 'manual', 'success', 'failed', 'canceled', 'skipped')),
  ADD CONSTRAINT "project_ci_runs_refusal_check"
    CHECK ("refusal" IS NULL OR "refusal" IN ('account_unverified')),
  ADD CONSTRAINT "project_ci_runs_id_check" CHECK ("provider_run_id" ~ '^[1-9][0-9]{0,39}$'),
  ADD CONSTRAINT "project_ci_runs_sha_check" CHECK ("sha" ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT "project_ci_runs_web_url_check" CHECK (starts_with("web_url", 'https://')),
  ADD CONSTRAINT "project_ci_runs_jobs_check"
    CHECK ("jobs" IS NULL OR (jsonb_typeof("jobs") = 'array' AND jsonb_array_length("jobs") <= 100));

ALTER TABLE "project_ci_logs"
  ADD CONSTRAINT "project_ci_logs_state_check" CHECK ("state" IN ('loading', 'ready', 'failed')),
  ADD CONSTRAINT "project_ci_logs_id_check" CHECK ("provider_job_id" ~ '^[1-9][0-9]{0,39}$'),
  ADD CONSTRAINT "project_ci_logs_text_check"
    CHECK ("text" IS NULL OR octet_length("text") <= 65536),
  -- A ready log has its text and its time; a loading one neither.
  ADD CONSTRAINT "project_ci_logs_ready_check"
    CHECK (("state" = 'ready') = ("text" IS NOT NULL AND "fetched_at" IS NOT NULL));

ALTER TABLE "project_deploy_actions"
  ADD CONSTRAINT "project_deploy_actions_kind_check"
    CHECK ("kind" IN ('manual_job', 'workflow_dispatch')),
  ADD CONSTRAINT "project_deploy_actions_sha_check" CHECK ("sha" ~ '^[0-9a-f]{40}$');

COMMIT;
