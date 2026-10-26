-- The skills of a site's agent (owner's request of 26.10.2026: «установи для агента по умолчанию
-- следующие скилы и сделай возможность добавлять — context7, playwright»): MCP servers the CLI of
-- a turn connects to besides the platform's own. Expand only: a new table, no existing row
-- changes; a site without rows has the platform's two skills on.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "site_agent_skills" (
    "site_id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "url" VARCHAR(512),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_agent_skills_pkey" PRIMARY KEY ("site_id","name")
);

ALTER TABLE "site_agent_skills" ADD CONSTRAINT "site_agent_skills_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as agentSkillNameSchema and
-- parseAgentSkillUrl of @repo/domain: a name of lower-case letters, digits and inner hyphens,
-- none the platform's MCP server could share a prefix with; the platform's own skills have no
-- address, an added one an https address without credentials, query, fragment or brace.
ALTER TABLE "site_agent_skills"
  ADD CONSTRAINT "site_agent_skills_name_check" CHECK (
    "name" ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'
    AND "name" NOT LIKE 'raditi%'
  ),
  ADD CONSTRAINT "site_agent_skills_url_check" CHECK (
    CASE
      WHEN "name" IN ('context7', 'playwright') THEN "url" IS NULL
      ELSE "url" IS NOT NULL
        AND "url" ~ '^https://[a-z0-9.-]+(:8443)?(/[^?#{}[:space:]\\]*)?$'
    END
  );

COMMIT;
