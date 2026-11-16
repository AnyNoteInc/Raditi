-- The branches of the agent, the merge requests, the proposals of the agent and the presses of the
-- client of a project repository (docs/plan/84-projects.md, ПР13–ПР15, §4.1; slice 84.19). A
-- branch reaches the client only by a button: a row of `repo_actions` is written by the press and
-- holds the token of its card, which core checks again before it calls the provider. Adds only new
-- tables, so nothing stops and nothing is carried over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "project_repo_branches" (
    "task_id" UUID NOT NULL,
    "project_repository_id" UUID NOT NULL,
    "branch" VARCHAR(255) NOT NULL,
    "base_sha" CHAR(40) NOT NULL,
    "mirror_sha" CHAR(40),
    "remote_sha" CHAR(40),
    "diffstat" JSONB,
    "ci_diff_sha256" CHAR(64),
    "ci_confirmed_sha256" CHAR(64),
    "ci_lint" JSONB,
    "state" VARCHAR(8) NOT NULL DEFAULT 'local',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_repo_branches_pkey" PRIMARY KEY ("task_id")
);

CREATE TABLE "project_merge_requests" (
    "id" UUID NOT NULL,
    "project_repository_id" UUID NOT NULL,
    "task_id" UUID,
    "number" INTEGER NOT NULL,
    "source_branch" VARCHAR(255) NOT NULL,
    "target_branch" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "state" VARCHAR(8) NOT NULL,
    "head_sha" CHAR(40) NOT NULL,
    "merge_sha" CHAR(40),
    "checks" VARCHAR(8) NOT NULL DEFAULT 'none',
    "auto_merge" BOOLEAN NOT NULL DEFAULT false,
    "web_url" VARCHAR(500) NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_merge_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repo_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" VARCHAR(8),
    "reason" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "repo_reservations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repo_actions" (
    "id" UUID NOT NULL,
    "project_repository_id" UUID NOT NULL,
    "task_id" UUID,
    "created_by_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "args" JSONB NOT NULL,
    "token_sha256" CHAR(64) NOT NULL,
    "state" VARCHAR(8) NOT NULL DEFAULT 'queued',
    "error" VARCHAR(40),
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "repo_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_repo_branches_project_repository_id_branch_key" ON "project_repo_branches"("project_repository_id", "branch");

CREATE INDEX "project_merge_requests_task_id_idx" ON "project_merge_requests"("task_id");

CREATE UNIQUE INDEX "project_merge_requests_project_repository_id_number_key" ON "project_merge_requests"("project_repository_id", "number");

CREATE INDEX "repo_reservations_open_idx" ON "repo_reservations"("task_id", "turn_no") WHERE (outcome IS NULL);

CREATE INDEX "repo_reservations_workspace_id_idx" ON "repo_reservations"("workspace_id");

CREATE UNIQUE INDEX "repo_actions_token_sha256_key" ON "repo_actions"("token_sha256");

CREATE INDEX "repo_actions_project_repository_id_created_at_idx" ON "repo_actions"("project_repository_id", "created_at");

CREATE INDEX "repo_actions_task_id_idx" ON "repo_actions"("task_id");

ALTER TABLE "project_repo_branches" ADD CONSTRAINT "project_repo_branches_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_repo_branches" ADD CONSTRAINT "project_repo_branches_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_merge_requests" ADD CONSTRAINT "project_merge_requests_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_merge_requests" ADD CONSTRAINT "project_merge_requests_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repo_reservations" ADD CONSTRAINT "repo_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repo_reservations" ADD CONSTRAINT "repo_reservations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repo_actions" ADD CONSTRAINT "repo_actions_project_repository_id_fkey" FOREIGN KEY ("project_repository_id") REFERENCES "project_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repo_actions" ADD CONSTRAINT "repo_actions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repo_actions" ADD CONSTRAINT "repo_actions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as repoBranchStates, pullRequestStates,
-- checksStates, repoActionKinds and repoActionStates of @repo/domain. A branch of the agent is
-- `raditi/…` (isAgentBranch); SHAs are 40 lower-case hex digits.
ALTER TABLE "project_repo_branches"
  ADD CONSTRAINT "project_repo_branches_state_check"
    CHECK ("state" IN ('local', 'pushed', 'merged', 'closed')),
  ADD CONSTRAINT "project_repo_branches_branch_check"
    CHECK ("branch" ~ '^raditi/[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "project_repo_branches_sha_check" CHECK (
    "base_sha" ~ '^[0-9a-f]{40}$'
    AND ("mirror_sha" IS NULL OR "mirror_sha" ~ '^[0-9a-f]{40}$')
    AND ("remote_sha" IS NULL OR "remote_sha" ~ '^[0-9a-f]{40}$')
  ),
  -- Sent once — both heads; never sent — neither.
  ADD CONSTRAINT "project_repo_branches_pushed_check"
    CHECK (("mirror_sha" IS NULL) = ("remote_sha" IS NULL)),
  ADD CONSTRAINT "project_repo_branches_ci_check" CHECK (
    ("ci_diff_sha256" IS NULL OR "ci_diff_sha256" ~ '^[0-9a-f]{64}$')
    AND ("ci_confirmed_sha256" IS NULL OR "ci_confirmed_sha256" ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE "project_merge_requests"
  ADD CONSTRAINT "project_merge_requests_state_check"
    CHECK ("state" IN ('open', 'draft', 'merged', 'closed')),
  ADD CONSTRAINT "project_merge_requests_checks_check"
    CHECK ("checks" IN ('none', 'pending', 'success', 'failure')),
  ADD CONSTRAINT "project_merge_requests_number_check" CHECK ("number" > 0),
  ADD CONSTRAINT "project_merge_requests_sha_check" CHECK (
    "head_sha" ~ '^[0-9a-f]{40}$' AND ("merge_sha" IS NULL OR "merge_sha" ~ '^[0-9a-f]{40}$')
  ),
  ADD CONSTRAINT "project_merge_requests_web_url_check" CHECK (starts_with("web_url", 'https://'));

ALTER TABLE "repo_reservations"
  ADD CONSTRAINT "repo_reservations_kind_check" CHECK ("kind" IN ('request_merge')),
  ADD CONSTRAINT "repo_reservations_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('done', 'refused', 'failed')),
  ADD CONSTRAINT "repo_reservations_closed_check" CHECK (("outcome" IS NULL) = ("closed_at" IS NULL));

ALTER TABLE "repo_actions"
  ADD CONSTRAINT "repo_actions_kind_check"
    CHECK ("kind" IN ('push', 'open_mr', 'merge', 'deploy', 'ci_push')),
  ADD CONSTRAINT "repo_actions_state_check"
    CHECK ("state" IN ('queued', 'waiting', 'running', 'done', 'failed')),
  ADD CONSTRAINT "repo_actions_token_check" CHECK ("token_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "repo_actions_error_check"
    CHECK ("error" IS NULL OR "error" ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  ADD CONSTRAINT "repo_actions_finished_check"
    CHECK (("state" IN ('done', 'failed')) = ("finished_at" IS NOT NULL));

COMMIT;
