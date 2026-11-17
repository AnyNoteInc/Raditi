-- Webhooks of the repositories of projects and the rest of the second queue
-- (docs/plan/84-projects.md, ПР15, ПР17, ПР24, §4.1; slice 84.26): the delivery ids web keeps
-- against a repeat for 7 days, the hook core creates on a GitLab project (its id, its nonce — the
-- hook's secrets are derived from REPO_CONFIRM_SECRET and it, never stored —, the id of the root
-- secret, whether GitLab signs its deliveries), the SHA whose paths core keeps for `@`, and three
-- kinds of a press: a rerun and a cancel of a build, a revert of a merge. Adds nullable columns, a
-- column with a default, a new table and a wider CHECK, so nothing stops and nothing is carried over.
--
-- One transaction: the CHECK of `repo_actions.kind` is dropped and added together.
BEGIN;

CREATE TABLE "git_webhook_deliveries" (
    "provider" VARCHAR(8) NOT NULL,
    "delivery_id" VARCHAR(100) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "git_webhook_deliveries_pkey" PRIMARY KEY ("provider","delivery_id"),
    CONSTRAINT "git_webhook_deliveries_provider_check" CHECK ("provider" IN ('github', 'gitlab')),
    CONSTRAINT "git_webhook_deliveries_delivery_id_check" CHECK (char_length("delivery_id") >= 1)
);

CREATE INDEX "git_webhook_deliveries_received_at_idx" ON "git_webhook_deliveries"("received_at");

ALTER TABLE "project_repositories"
  ADD COLUMN "hook_id" VARCHAR(40),
  ADD COLUMN "hook_state" VARCHAR(12),
  ADD COLUMN "hook_signed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hook_nonce" CHAR(32),
  ADD COLUMN "hook_key_id" CHAR(16),
  ADD COLUMN "hook_checked_at" TIMESTAMPTZ(6),
  ADD COLUMN "tree_sha" CHAR(40);

ALTER TABLE "project_repositories"
  ADD CONSTRAINT "project_repositories_hook_state_check"
    CHECK ("hook_state" IS NULL OR "hook_state" IN ('active', 'failed', 'not_allowed')),
  -- A hook core made has its id, its nonce and the id of its root secret; only it.
  ADD CONSTRAINT "project_repositories_hook_check" CHECK (
    ("hook_state" = 'active') = ("hook_id" IS NOT NULL)
    AND ("hook_id" IS NULL) = ("hook_nonce" IS NULL)
    AND ("hook_id" IS NULL) = ("hook_key_id" IS NULL)
    AND ("hook_id" IS NOT NULL OR NOT "hook_signed")
  ),
  ADD CONSTRAINT "project_repositories_hook_id_check"
    CHECK ("hook_id" IS NULL OR "hook_id" ~ '^[1-9][0-9]{0,19}$'),
  ADD CONSTRAINT "project_repositories_hook_nonce_check"
    CHECK ("hook_nonce" IS NULL OR "hook_nonce" ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT "project_repositories_hook_key_id_check"
    CHECK ("hook_key_id" IS NULL OR "hook_key_id" ~ '^[0-9a-f]{16}$'),
  ADD CONSTRAINT "project_repositories_tree_sha_check"
    CHECK ("tree_sha" IS NULL OR "tree_sha" ~ '^[0-9a-f]{40}$');

-- GitHub's deliveries name the repository by its id: web finds the rows of an event by it.
CREATE INDEX "project_repositories_provider_repo_idx"
  ON "project_repositories"("provider", "host", "provider_repo_id");

ALTER TABLE "repo_actions" DROP CONSTRAINT "repo_actions_kind_check";
ALTER TABLE "repo_actions"
  ADD CONSTRAINT "repo_actions_kind_check" CHECK (
    "kind" IN ('push', 'open_mr', 'merge', 'deploy', 'ci_push', 'rerun', 'cancel', 'revert')
  );

COMMIT;
