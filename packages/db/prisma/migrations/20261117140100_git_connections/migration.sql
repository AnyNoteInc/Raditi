-- The git connections of the users of a workspace, the repositories each of them sees, and the
-- repository of a project (docs/plan/84-projects.md, ПР9, ПР10, §4.1; slice 84.16). A connection
-- acts in the name of the one who made it: only `created_by_id` sees, binds and uses it. Its tokens
-- live at kv/workspaces/<workspace>/git/<connectionId> with a `credential_refs` row of kind
-- `git_connection` (a GitHub App connection has none: its installation token is issued per
-- operation). Adds only new tables and widens one CHECK, so nothing stops and nothing is carried
-- over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "git_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "account_login" VARCHAR(100) NOT NULL,
    "account_id" VARCHAR(40) NOT NULL,
    "installation_id" BIGINT,
    "github_user_id" VARCHAR(40),
    "credential_ref_id" UUID,
    "state" VARCHAR(16) NOT NULL DEFAULT 'checking',
    "state_reason" VARCHAR(40),
    "checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "git_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "git_connection_repositories" (
    "connection_id" UUID NOT NULL,
    "provider_repo_id" VARCHAR(40) NOT NULL,
    "path" VARCHAR(300) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "visibility" VARCHAR(10) NOT NULL,
    "default_branch" VARCHAR(255) NOT NULL,
    "branches" JSONB,
    "can_push" BOOLEAN NOT NULL,
    "can_hook" BOOLEAN NOT NULL,
    "pushed_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "git_connection_repositories_pkey" PRIMARY KEY ("connection_id","provider_repo_id")
);

CREATE TABLE "project_repositories" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID,
    "provider" VARCHAR(8) NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "provider_repo_id" VARCHAR(40),
    "path" VARCHAR(300) NOT NULL,
    "web_url" VARCHAR(500) NOT NULL,
    "default_branch" VARCHAR(255) NOT NULL,
    "mode" VARCHAR(5) NOT NULL,
    "mirror_state" VARCHAR(12) NOT NULL DEFAULT 'syncing',
    "last_fetched_sha" CHAR(40),
    "fetched_at" TIMESTAMPTZ(6),
    "secrets_found" JSONB,
    "ci_paths" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_repositories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "git_connections_credential_ref_id_key" ON "git_connections"("credential_ref_id");

CREATE INDEX "git_connections_created_by_id_idx" ON "git_connections"("created_by_id");

CREATE UNIQUE INDEX "git_connections_workspace_id_created_by_id_kind_host_accoun_key" ON "git_connections"("workspace_id", "created_by_id", "kind", "host", "account_id");

CREATE UNIQUE INDEX "project_repositories_project_id_key" ON "project_repositories"("project_id");

CREATE INDEX "project_repositories_workspace_id_idx" ON "project_repositories"("workspace_id");

CREATE INDEX "project_repositories_connection_id_idx" ON "project_repositories"("connection_id");

ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "git_connection_repositories" ADD CONSTRAINT "git_connection_repositories_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "git_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "git_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as gitConnectionKinds,
-- gitConnectionStates, gitRepoVisibilities, repoProviderKinds, repoModes and repoMirrorStates of
-- @repo/domain. A host is a lower-case DNS name; a GitHub App lives on github.com and the OAuth app
-- of Raditi on gitlab.com, the client's own GitLab server takes a token. Only a GitHub App
-- connection has an installation and the GitHub user who made it, and only it holds no token.
ALTER TABLE "git_connections"
  ADD CONSTRAINT "git_connections_kind_check"
    CHECK ("kind" IN ('github_app', 'gitlab_oauth', 'gitlab_token')),
  ADD CONSTRAINT "git_connections_state_check"
    CHECK ("state" IN ('checking', 'ok', 'reauth_needed', 'refused', 'suspended')),
  ADD CONSTRAINT "git_connections_state_reason_check"
    CHECK ("state_reason" IS NULL OR "state_reason" ~ '^[a-z][a-z0-9_]{0,39}$'),
  ADD CONSTRAINT "git_connections_host_check" CHECK (
    "host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND ("kind" <> 'github_app' OR "host" = 'github.com')
    AND ("kind" <> 'gitlab_oauth' OR "host" = 'gitlab.com')
  ),
  ADD CONSTRAINT "git_connections_account_check"
    CHECK (btrim("account_login") <> '' AND btrim("account_id") <> ''),
  ADD CONSTRAINT "git_connections_installation_check"
    CHECK (("kind" = 'github_app') = ("installation_id" IS NOT NULL)),
  ADD CONSTRAINT "git_connections_github_user_check"
    CHECK (("kind" = 'github_app') = ("github_user_id" IS NOT NULL)),
  ADD CONSTRAINT "git_connections_credential_check"
    CHECK (("kind" = 'github_app') = ("credential_ref_id" IS NULL));

ALTER TABLE "git_connection_repositories"
  ADD CONSTRAINT "git_connection_repositories_visibility_check"
    CHECK ("visibility" IN ('public', 'internal', 'private')),
  -- IS NULL first: jsonb_typeof(NULL) is NULL, and a CHECK lets NULL through anyway.
  ADD CONSTRAINT "git_connection_repositories_branches_check" CHECK (
    "branches" IS NULL
    OR (jsonb_typeof("branches") = 'array' AND jsonb_array_length("branches") <= 100)
  );

ALTER TABLE "project_repositories"
  ADD CONSTRAINT "project_repositories_provider_check" CHECK ("provider" IN ('github', 'gitlab')),
  ADD CONSTRAINT "project_repositories_mode_check" CHECK ("mode" IN ('read', 'write')),
  ADD CONSTRAINT "project_repositories_mirror_state_check"
    CHECK ("mirror_state" IN ('syncing', 'ready', 'too_large', 'unreachable', 'failed')),
  ADD CONSTRAINT "project_repositories_host_check" CHECK (
    "host" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND ("provider" <> 'github' OR "host" = 'github.com')
  ),
  -- A public link only reads (ПР9).
  ADD CONSTRAINT "project_repositories_connection_mode_check"
    CHECK ("connection_id" IS NOT NULL OR "mode" = 'read'),
  -- The address of the repository on its own host, never one from an answer of an API (§4.5).
  ADD CONSTRAINT "project_repositories_web_url_check"
    CHECK (starts_with("web_url", 'https://' || "host" || '/')),
  ADD CONSTRAINT "project_repositories_sha_check"
    CHECK ("last_fetched_sha" IS NULL OR "last_fetched_sha" ~ '^[0-9a-f]{40}$');

-- The tokens of a git connection belong to a workspace, as the secret of an MCP server; every
-- other reference is the platform's (the CHECK of 20261116120100_workspace_agent_skills would
-- refuse a `git_connection` reference with its workspace).
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_platform_scope_check";
ALTER TABLE "credential_refs" ADD CONSTRAINT "credential_refs_platform_scope_check"
  CHECK (("kind" IN ('mcp_server', 'git_connection')) = ("workspace_id" IS NOT NULL));

COMMIT;
