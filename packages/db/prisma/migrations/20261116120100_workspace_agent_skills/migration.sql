-- The skills of a workspace's agent (docs/plan/83-remove-projects.md, БП11; owner's answer of
-- 15.11.2026: «перенести в пространство»): the MCP servers every chat of the workspace connects to
-- besides the platform's own, with the authorization of plan 81. The table of a site's skills went
-- with the sites (20261116110000_remove_projects); nothing is carried over. A workspace without rows
-- has the platform's two skills on. The secret of a server lives at
-- `kv/workspaces/<workspace>/mcp/<name>` with a `credential_refs` row of kind `mcp_server`.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "workspace_agent_skills" (
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "url" VARCHAR(512),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "auth_kind" "AgentSkillAuthKind" NOT NULL DEFAULT 'none',
    "header_name" VARCHAR(64),
    "auth_state" "AgentSkillAuthState" NOT NULL DEFAULT 'ok',
    "auth_checked_at" TIMESTAMPTZ(6),
    "auth_error" VARCHAR(64),
    "oauth" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspace_agent_skills_pkey" PRIMARY KEY ("workspace_id","name")
);

ALTER TABLE "workspace_agent_skills" ADD CONSTRAINT "workspace_agent_skills_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as agentSkillNameSchema,
-- parseAgentSkillUrl and agentSkillHeaderNameSchema of @repo/domain — the same as the table of a
-- site's skills had (20261026130000_site_agent_skills, 20261116100100_site_agent_skill_auth).
ALTER TABLE "workspace_agent_skills"
  ADD CONSTRAINT "workspace_agent_skills_name_check" CHECK (
    "name" ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'
    AND "name" NOT LIKE 'raditi%'
  ),
  ADD CONSTRAINT "workspace_agent_skills_url_check" CHECK (
    CASE
      WHEN "name" IN ('context7', 'playwright') THEN "url" IS NULL
      ELSE "url" IS NOT NULL
        AND "url" ~ '^https://[a-z0-9.-]+(:8443)?(/[^?#{}[:space:]\\]*)?$'
    END
  ),
  ADD CONSTRAINT "workspace_agent_skills_auth_check" CHECK (
    CASE "auth_kind"
      WHEN 'none' THEN "header_name" IS NULL AND "oauth" IS NULL AND "auth_state" = 'ok'
      WHEN 'header' THEN "header_name" IS NOT NULL AND "oauth" IS NULL
        AND "header_name" ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'
        AND "name" NOT IN ('context7', 'playwright')
      -- IS NOT NULL first: jsonb_typeof(NULL) is NULL, and a CHECK lets NULL through.
      ELSE "header_name" IS NULL AND "oauth" IS NOT NULL AND jsonb_typeof("oauth") = 'object'
        AND octet_length("oauth"::text) <= 8192
        AND "name" NOT IN ('context7', 'playwright')
    END
  ),
  ADD CONSTRAINT "workspace_agent_skills_auth_error_check"
    CHECK ("auth_error" IS NULL OR "auth_error" ~ '^[a-z][a-z0-9_]{0,63}$');

-- The secret of a server belongs to a workspace; every other reference is the platform's.
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_platform_scope_check";
ALTER TABLE "credential_refs" ADD CONSTRAINT "credential_refs_platform_scope_check"
  CHECK (("kind" = 'mcp_server') = ("workspace_id" IS NOT NULL));

COMMIT;
