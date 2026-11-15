-- Projects of a workspace (docs/plan/84-projects.md, ПР1, ПР2, ПР20; slice 84.3): a new table, not
-- the sites of before (they went with 20261116110000_remove_projects), and the project of a chat.
-- Adds only: a new table and a NULL column of tasks, so nothing stops and nothing is carried over.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "goal" VARCHAR(500),
    "instructions" TEXT,
    "use_account_memory" BOOLEAN NOT NULL DEFAULT true,
    "starred_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "purge_after" TIMESTAMPTZ(6),
    "activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "projects_owner_activity_idx" ON "projects"("workspace_id", "created_by_id", "activity_at" DESC) WHERE (deleted_at IS NULL);

CREATE INDEX "projects_purge_idx" ON "projects"("purge_after") WHERE (deleted_at IS NOT NULL);

ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as projectLimits and projectNameOf of
-- @repo/domain: the id is of version 7 (it comes from the browser, ПР1), the name is one line of
-- 1–80 characters after trimming, the instructions are at most 8000 characters, and a project in
-- the trash has the day it is purged and only then.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_id_check" CHECK ("substring"(("id")::text, 15, 1) = '7'),
  ADD CONSTRAINT "projects_name_check" CHECK (
    char_length(btrim("name")) BETWEEN 1 AND 80
    AND "name" !~ '[\r\n]'
  ),
  ADD CONSTRAINT "projects_goal_check" CHECK ("goal" IS NULL OR char_length(btrim("goal")) BETWEEN 1 AND 500),
  ADD CONSTRAINT "projects_instructions_check" CHECK (
    "instructions" IS NULL OR char_length("instructions") BETWEEN 1 AND 8000
  ),
  ADD CONSTRAINT "projects_trash_check" CHECK (("deleted_at" IS NULL) = ("purge_after" IS NULL));

-- The project of a chat (ПР2): NULL — a chat without one. Purging a project makes its chats
-- deleted first (ПР20), so SET NULL meets only deleted chats.
ALTER TABLE "tasks" ADD COLUMN "project_id" UUID;

CREATE INDEX "tasks_project_updated_idx" ON "tasks"("project_id", "updated_at" DESC, "id" DESC) WHERE (project_id IS NOT NULL AND deleted_at IS NULL);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A chat goes only into a project of its own workspace that is not in the trash: the procedures
-- check it, and this is the line no bug of theirs crosses. FOR SHARE: a project being put into
-- the trash at the same moment waits for the chat, or the chat sees it deleted.
CREATE FUNCTION "raditi_tasks_project_workspace"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."project_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "projects" p
    WHERE p."id" = NEW."project_id"
      AND p."workspace_id" = NEW."workspace_id"
      AND p."deleted_at" IS NULL
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'a chat goes only into a live project of its own workspace'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_project_workspace';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "tasks_project_workspace" BEFORE INSERT OR UPDATE OF "project_id", "workspace_id" ON "tasks"
  FOR EACH ROW
  WHEN (NEW."project_id" IS NOT NULL)
  EXECUTE FUNCTION "raditi_tasks_project_workspace"();

COMMIT;
