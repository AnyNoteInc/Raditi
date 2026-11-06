-- Chats on the first place (docs/plan/61-chats-first.md, §5.1, К7, К12, К14): a task may have no
-- site at all. A task with a site may need the repository and the browser together (К10). The
-- scope of the lease of a task without a site is the task itself (`leaseScopeOf`), so `site_id`
-- of `site_leases` and `turn_assignments` is no longer always a site.

BEGIN;

ALTER TABLE "tasks" ALTER COLUMN "site_id" DROP NOT NULL;
ALTER TABLE "attachments" ALTER COLUMN "site_id" DROP NOT NULL;
ALTER TABLE "browser_sessions" ALTER COLUMN "site_id" DROP NOT NULL;

ALTER TABLE "tasks" DROP CONSTRAINT "tasks_requirements_check";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requirements_check" CHECK (
  ("site_id" IS NULL AND NOT "needs_repository")
  OR ("site_id" IS NOT NULL AND ("needs_repository" OR "needs_browser"))
);

-- A chat without a project leases by its own id, which the browser invents: only version 7,
-- never the version 8 of a site's id, or it could take the lease of someone else's site.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_id_check" CHECK (
  "site_id" IS NOT NULL OR substring("id"::text, 15, 1) = '7'
);

DROP TRIGGER "tasks_requirements_fixed" ON "tasks";
CREATE TRIGGER "tasks_requirements_fixed" BEFORE UPDATE ON "tasks"
  FOR EACH ROW
  WHEN (OLD."needs_repository" IS DISTINCT FROM NEW."needs_repository"
     OR OLD."needs_browser" IS DISTINCT FROM NEW."needs_browser"
     OR OLD."site_id" IS DISTINCT FROM NEW."site_id")
  EXECUTE FUNCTION "raditi_tasks_requirements_fixed"();

-- site_id of these two is the scope of the lease now: the site, or the task without one.
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_site_id_fkey";
ALTER TABLE "turn_assignments" DROP CONSTRAINT "turn_assignments_site_id_fkey";

ALTER TABLE "browser_sessions" ADD COLUMN "last_wrote_at" TIMESTAMPTZ(6);
ALTER TABLE "tasks" ADD COLUMN "web_masks_purged_at" TIMESTAMPTZ(6);

CREATE INDEX "tasks_workspace_updated_idx"
  ON "tasks" ("workspace_id", "updated_at" DESC, "id" DESC);

COMMIT;
