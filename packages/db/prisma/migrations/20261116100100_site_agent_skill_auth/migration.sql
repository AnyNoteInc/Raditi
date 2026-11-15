-- Authorization of an added MCP server of a site's agent (owner's request of 15.11.2026,
-- docs/plan/81-mcp-server-credentials.md): none, a header whose value is in Vault, or an OAuth
-- sign-in whose tokens are in Vault. The secret lives at `kv/sites/<site>/mcp/<name>` with a
-- `credential_refs` row of kind `mcp_server`; this table keeps the header's name, the state of the
-- authorization and what of an OAuth sign-in is not secret. Expand only: every row stays `none`
-- and `ok`, as it worked before.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TYPE "AgentSkillAuthKind" AS ENUM ('none', 'header', 'oauth');
CREATE TYPE "AgentSkillAuthState" AS ENUM ('ok', 'needs_login', 'failed');

ALTER TABLE "site_agent_skills"
  ADD COLUMN "auth_kind" "AgentSkillAuthKind" NOT NULL DEFAULT 'none',
  ADD COLUMN "header_name" VARCHAR(64),
  ADD COLUMN "auth_state" "AgentSkillAuthState" NOT NULL DEFAULT 'ok',
  ADD COLUMN "auth_checked_at" TIMESTAMPTZ(6),
  ADD COLUMN "auth_error" VARCHAR(64),
  ADD COLUMN "oauth" JSONB;

-- As agentSkillHeaderNameSchema of @repo/domain (the reserved names are the code's to refuse): an
-- HTTP token. A header has a name and no OAuth; an OAuth sign-in has its metadata and no header;
-- a server without authorization has neither, and the platform's own skills never have any.
ALTER TABLE "site_agent_skills"
  ADD CONSTRAINT "site_agent_skills_auth_check" CHECK (
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
  ADD CONSTRAINT "site_agent_skills_auth_error_check"
    CHECK ("auth_error" IS NULL OR "auth_error" ~ '^[a-z][a-z0-9_]{0,63}$');

-- The secret of a server belongs to a site, like its accesses.
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_site_scope_check";
ALTER TABLE "credential_refs"
  ADD CONSTRAINT "credential_refs_site_scope_check"
    CHECK ("kind" NOT IN ('ssh', 'ftp', 'wp', 'browser', 'db', 'mcp_server') OR "site_id" IS NOT NULL);

COMMIT;
