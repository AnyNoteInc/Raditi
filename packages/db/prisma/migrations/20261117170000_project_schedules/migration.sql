-- Scheduled tasks bound to projects (docs/plan/84-projects.md, ПР19; slice 84.14): a task may be of
-- a project of its creator, and a run keeps the project it was written with — its chat starts in
-- it, with its instructions, context, memory and repository. «В архив» and «Удалить» of a project
-- stop its tasks (`project_gone`); a task the agent set up in a chat of a project with a
-- repository waits for the client (`unconfirmed`); a run of a project whose sign-in with GitLab has
-- to be renewed is refused (`project_unavailable`). A purged project leaves its tasks deleted, the
-- runs keep their rows without it (ON DELETE SET NULL).
--
-- The value lists of the CHECKs are the arrays of @repo/domain (prisma/scheduled-tasks.test.ts
-- holds them equal): scheduledRunReasons and schedulePausedReasons.
--
-- Nullable columns and wider CHECKs, one transaction; no stop is needed. The code before this
-- release writes none of the new values and reads none of the new columns.

BEGIN;

ALTER TABLE "scheduled_tasks" ADD COLUMN "project_id" UUID;
ALTER TABLE "scheduled_runs" ADD COLUMN "project_id" UUID;

CREATE INDEX "scheduled_tasks_project_id_idx" ON "scheduled_tasks"("project_id")
  WHERE ("project_id" IS NOT NULL);
CREATE INDEX "scheduled_runs_project_id_idx" ON "scheduled_runs"("project_id")
  WHERE ("project_id" IS NOT NULL);

ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "scheduled_tasks" DROP CONSTRAINT "scheduled_tasks_paused_reason_check";
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_paused_reason_check" CHECK (
  "paused_reason" IS NULL
  OR "paused_reason" IN ('completed', 'not_accepted', 'refused', 'project_gone', 'unconfirmed')
);

ALTER TABLE "scheduled_tasks" DROP CONSTRAINT "scheduled_tasks_last_refusal_reason_check";
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_last_refusal_reason_check" CHECK (
  "last_refusal_reason" IS NULL
  OR "last_refusal_reason" IN ('no_credits', 'needs_tariff', 'credits_held', 'weekly_limit',
    'daily_limit', 'consent', 'text_refused', 'previous_running', 'missed', 'paused',
    'platform', 'project_gone', 'project_unavailable')
);

ALTER TABLE "scheduled_runs" DROP CONSTRAINT "scheduled_runs_reason_check";
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_reason_check" CHECK (
  "reason" IS NULL
  OR "reason" IN ('no_credits', 'needs_tariff', 'credits_held', 'weekly_limit', 'daily_limit',
    'consent', 'text_refused', 'previous_running', 'missed', 'paused', 'platform',
    'project_gone', 'project_unavailable')
);

COMMIT;
