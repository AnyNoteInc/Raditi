-- The built-in MCP servers of a workspace and its VK communities (docs/plan/99-vk-community.md,
-- ВК15, §3, §4): the switches of «Настройки → Встроенные MCP», the communities connected by their
-- keys, the proposals of the agent and the presses of the client. A post reaches VK only by a
-- button: a row of `vk_actions` is written by the press and holds the token of its card, which core
-- checks again before it calls VK. Adds only new tables, so nothing stops and nothing is carried
-- over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "workspace_builtin_mcp" (
    "workspace_id" UUID NOT NULL,
    "server" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_builtin_mcp_pkey" PRIMARY KEY ("workspace_id","server")
);

CREATE TABLE "vk_communities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "group_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "screen_name" VARCHAR(100) NOT NULL,
    "is_closed" BOOLEAN NOT NULL,
    "permissions" VARCHAR(32)[],
    "credential_ref_id" UUID,
    "state" VARCHAR(8) NOT NULL DEFAULT 'ok',
    "state_reason" VARCHAR(40),
    "callback_server_id" INTEGER,
    "callback_code" VARCHAR(64),
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vk_communities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vk_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "community_id" UUID NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "payload" JSONB NOT NULL,
    "outcome" VARCHAR(8),
    "reason" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "vk_reservations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vk_actions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID,
    "community_id" UUID,
    "reservation_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "args" JSONB NOT NULL,
    "token_sha256" CHAR(64) NOT NULL,
    "state" VARCHAR(8) NOT NULL DEFAULT 'queued',
    "error" VARCHAR(40),
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "vk_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vk_communities_credential_ref_id_key" ON "vk_communities"("credential_ref_id");

CREATE UNIQUE INDEX "vk_communities_workspace_id_group_id_key" ON "vk_communities"("workspace_id", "group_id");

CREATE INDEX "vk_reservations_open_idx" ON "vk_reservations"("task_id", "turn_no") WHERE (outcome IS NULL);

CREATE INDEX "vk_reservations_workspace_id_idx" ON "vk_reservations"("workspace_id");

CREATE INDEX "vk_reservations_community_id_idx" ON "vk_reservations"("community_id");

CREATE UNIQUE INDEX "vk_actions_reservation_id_key" ON "vk_actions"("reservation_id");

CREATE UNIQUE INDEX "vk_actions_token_sha256_key" ON "vk_actions"("token_sha256");

CREATE INDEX "vk_actions_workspace_id_created_at_idx" ON "vk_actions"("workspace_id", "created_at");

CREATE INDEX "vk_actions_task_id_idx" ON "vk_actions"("task_id");

CREATE INDEX "vk_actions_community_id_idx" ON "vk_actions"("community_id");

ALTER TABLE "workspace_builtin_mcp" ADD CONSTRAINT "workspace_builtin_mcp_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workspace_builtin_mcp" ADD CONSTRAINT "workspace_builtin_mcp_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vk_communities" ADD CONSTRAINT "vk_communities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vk_communities" ADD CONSTRAINT "vk_communities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vk_communities" ADD CONSTRAINT "vk_communities_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vk_reservations" ADD CONSTRAINT "vk_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vk_reservations" ADD CONSTRAINT "vk_reservations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vk_reservations" ADD CONSTRAINT "vk_reservations_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "vk_communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vk_actions" ADD CONSTRAINT "vk_actions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vk_actions" ADD CONSTRAINT "vk_actions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vk_actions" ADD CONSTRAINT "vk_actions_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "vk_communities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vk_actions" ADD CONSTRAINT "vk_actions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as builtinMcpServers and the kinds and
-- states of plan 99, §4.
ALTER TABLE "workspace_builtin_mcp"
  ADD CONSTRAINT "workspace_builtin_mcp_server_check" CHECK ("server" IN ('vk'));

ALTER TABLE "vk_communities"
  ADD CONSTRAINT "vk_communities_group_id_check" CHECK ("group_id" > 0),
  ADD CONSTRAINT "vk_communities_state_check" CHECK ("state" IN ('ok', 'refused')),
  ADD CONSTRAINT "vk_communities_reason_check"
    CHECK ("state_reason" IS NULL OR "state_reason" ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  ADD CONSTRAINT "vk_communities_callback_check"
    CHECK (("callback_server_id" IS NULL) = ("callback_code" IS NULL)
      AND ("callback_server_id" IS NULL OR "callback_server_id" > 0));

ALTER TABLE "vk_reservations"
  ADD CONSTRAINT "vk_reservations_kind_check" CHECK ("kind" IN ('post', 'reply')),
  ADD CONSTRAINT "vk_reservations_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('done', 'refused', 'failed')),
  ADD CONSTRAINT "vk_reservations_closed_check" CHECK (("outcome" IS NULL) = ("closed_at" IS NULL));

ALTER TABLE "vk_actions"
  ADD CONSTRAINT "vk_actions_kind_check" CHECK ("kind" IN ('post', 'reply')),
  ADD CONSTRAINT "vk_actions_state_check"
    CHECK ("state" IN ('queued', 'running', 'done', 'failed', 'lost')),
  ADD CONSTRAINT "vk_actions_token_check" CHECK ("token_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "vk_actions_error_check"
    CHECK ("error" IS NULL OR "error" ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  ADD CONSTRAINT "vk_actions_finished_check"
    CHECK (("state" IN ('done', 'failed', 'lost')) = ("finished_at" IS NOT NULL));

-- The key of a VK community belongs to a workspace, as the secret of an MCP server and the tokens of
-- a git connection; every other reference is the platform's.
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_platform_scope_check";
ALTER TABLE "credential_refs" ADD CONSTRAINT "credential_refs_platform_scope_check"
  CHECK (("kind" IN ('mcp_server', 'git_connection', 'vk_community')) = ("workspace_id" IS NOT NULL));

COMMIT;
