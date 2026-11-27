-- The skills of an account (docs/plan/97-skills.md, Нв1–Нв4, Нв7): folders with SKILL.md of a
-- user, their versions, and the marketplaces they read skills from.
BEGIN;

CREATE TABLE "account_skills" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "source_ref" JSONB NOT NULL,
    "version_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "update_commit" VARCHAR(64),
    "update_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_skills_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_skills_name_check" CHECK ("name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "account_skills_source_check" CHECK ("source" IN ('builtin', 'marketplace', 'git', 'upload', 'created')),
    -- A built-in skill has no version of its own (an install writes the skill, then its version).
    CONSTRAINT "account_skills_builtin_check" CHECK ("source" <> 'builtin' OR "version_id" IS NULL)
);

CREATE TABLE "account_skill_versions" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "commit" VARCHAR(64),
    "description" VARCHAR(1024) NOT NULL,
    "license" VARCHAR(128),
    "user_only" BOOLEAN NOT NULL DEFAULT false,
    "frontmatter" JSONB NOT NULL,
    "files" JSONB NOT NULL,
    "file_count" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_skill_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "account_skill_versions_files_check" CHECK ("file_count" BETWEEN 1 AND 100),
    CONSTRAINT "account_skill_versions_size_check" CHECK ("size_bytes" BETWEEN 1 AND 10485760)
);

CREATE TABLE "skill_marketplaces" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "host" VARCHAR(16) NOT NULL,
    "repo" VARCHAR(256) NOT NULL,
    "ref" VARCHAR(128),
    "name" VARCHAR(128),
    "listing" JSONB,
    "commit" VARCHAR(64),
    "fetched_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_marketplaces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_marketplaces_host_check" CHECK ("host" IN ('github', 'gitlab'))
);

CREATE UNIQUE INDEX "account_skills_version_id_key" ON "account_skills"("version_id");
CREATE UNIQUE INDEX "account_skills_user_id_name_key" ON "account_skills"("user_id", "name");
CREATE INDEX "account_skill_versions_skill_id_created_at_idx" ON "account_skill_versions"("skill_id", "created_at");
CREATE UNIQUE INDEX "skill_marketplaces_user_id_host_repo_key" ON "skill_marketplaces"("user_id", "host", "repo");
-- The platform's marketplaces: one row each, though NULLs are distinct for the key above.
CREATE UNIQUE INDEX "skill_marketplaces_platform_key" ON "skill_marketplaces"("host", "repo") WHERE "user_id" IS NULL;

ALTER TABLE "account_skills" ADD CONSTRAINT "account_skills_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_skills" ADD CONSTRAINT "account_skills_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "account_skill_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "account_skill_versions" ADD CONSTRAINT "account_skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "account_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "skill_marketplaces" ADD CONSTRAINT "skill_marketplaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
