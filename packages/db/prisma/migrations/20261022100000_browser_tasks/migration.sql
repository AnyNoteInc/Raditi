-- Tasks in the cloud browser without a code base (docs/plan/57-browser-tasks.md, Б2, Б8, Б26):
-- what the environment of a task needs, the hints a client writes for the agent of a site, and
-- files a client attaches to a message.
--
-- `tasks`: two new columns with a DEFAULT. Every task there is was made for the site's
-- repository, which is what the defaults say — `{ repository: true, browser: false }`, the
-- requirements a turn plan without its own field reads as (`requirementsOf`). The CHECK holds
-- for every such row, and the trigger only refuses later changes.
-- `sites`: a new column, empty for every row there is: nothing to stop and nothing to move.
-- `attachments`: the table exists since the first migration, but nothing in the product has ever
-- written it; its new columns are NOT NULL without a value an old row could take, so the
-- migration stops when it finds a row, before its transaction (CLAUDE.md, «Как писать код»).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "attachments") THEN
    RAISE EXCEPTION 'attachments holds rows, though nothing in the product writes them: delete them before applying 20261022100000_browser_tasks';
  END IF;
END $$;

BEGIN;

-- ─── What a task needs (Б2) ─────────────────────────────────────────────────────────────────────

ALTER TABLE "tasks"
  ADD COLUMN "needs_repository" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "needs_browser" BOOLEAN NOT NULL DEFAULT false,
  -- A task needs the repository, the browser or both.
  ADD CONSTRAINT "tasks_requirements_check" CHECK ("needs_repository" OR "needs_browser");

-- Fixed when the task is created: its turns, snapshots and settlement all follow them, and a
-- task whose turns mixed a repository and none would leave a completed turn without a head.
CREATE FUNCTION "raditi_tasks_requirements_fixed"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'the requirements of a task are fixed when it is created'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'tasks_requirements_fixed';
END
$fn$;
CREATE TRIGGER "tasks_requirements_fixed" BEFORE UPDATE ON "tasks"
  FOR EACH ROW
  WHEN (OLD."needs_repository" IS DISTINCT FROM NEW."needs_repository"
     OR OLD."needs_browser" IS DISTINCT FROM NEW."needs_browser")
  EXECUTE FUNCTION "raditi_tasks_requirements_fixed"();

-- ─── Hints of a site for the agent (Б8) ─────────────────────────────────────────────────────────

ALTER TABLE "sites" ADD COLUMN "agent_notes" VARCHAR(2000);

-- ─── Attachments (Б26) ──────────────────────────────────────────────────────────────────────────

CREATE TYPE "AttachmentStatus" AS ENUM ('uploading', 'ready', 'bound', 'deleted');

ALTER TABLE "attachments"
  -- A file is uploaded before the message that sends it exists.
  ALTER COLUMN "task_id" DROP NOT NULL,
  ADD COLUMN "workspace_id" UUID NOT NULL,
  ADD COLUMN "site_id" UUID NOT NULL,
  ADD COLUMN "status" "AttachmentStatus" NOT NULL DEFAULT 'uploading',
  -- Until when a file nobody sent is kept.
  ADD COLUMN "expires_at" TIMESTAMPTZ(6) NOT NULL,
  ADD COLUMN "bound_at" TIMESTAMPTZ(6),
  -- A file belongs to a task exactly while it is bound, from the moment it was; a removed one
  -- was never sent.
  ADD CONSTRAINT "attachments_bound_check" CHECK (
    ("task_id" IS NULL) = ("bound_at" IS NULL) AND ("status" = 'bound') = ("task_id" IS NOT NULL)
  ),
  -- The object lies where attachmentKey() (@repo/domain) puts it: no writer names another.
  ADD CONSTRAINT "attachments_key_check" CHECK (
    "s3_key" = 'inbox/' || "workspace_id"::text || '/' || "id"::text
  );

-- The uploads of a person by status (what may be sent or removed); the collector of files
-- nobody sent; the foreign keys.
DROP INDEX "attachments_uploaded_by_id_idx";
CREATE INDEX "attachments_uploaded_by_id_status_idx" ON "attachments"("uploaded_by_id", "status");
CREATE INDEX "attachments_status_expires_at_idx" ON "attachments"("status", "expires_at");
CREATE INDEX "attachments_workspace_id_idx" ON "attachments"("workspace_id");
CREATE INDEX "attachments_site_id_idx" ON "attachments"("site_id");

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
