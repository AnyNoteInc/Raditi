-- Scheduled tasks and the notice of a finished run (docs/plan/82-scheduled-tasks.md, §4.2): the
-- agent runs the client's instructions by itself on a schedule, each run a new chat (Зп17). A
-- task with its schedules in the zone of the client (Зп11–Зп16, Зп25), its runs with a snapshot of
-- its fields (Зп14, Зп19–Зп24), the changes the agent reserved in a turn (Зп33); the zone of the
-- client's browser (Зп12), the VAPID key a browser subscribed under (Зп41), and notices of a
-- scheduled task — of a pass without its client and of the task itself, which may have no chat
-- (Зп38–Зп41): one notice of a kind per pass of a chat and per run. A task is of its creator's
-- personal workspace (Зп44, Зп63).
--
-- The value lists of the CHECKs are the arrays of @repo/domain (prisma/scheduled-tasks.test.ts
-- holds them equal): scheduledRunTriggers, scheduledRunStatuses, scheduledRunReasons,
-- schedulePausedReasons, scheduleCreatedVia, reasoningEfforts, scheduleLeftActions (the kinds of
-- a reservation) and notificationKinds.
--
-- Added tables and columns, one transaction; no stop is needed. One deletion of data: the
-- Web Push subscriptions of the clients who had turned push off (Зп37, below). The code before this release
-- writes chat_notifications with a chat and one of the five kinds of a pass, which the new
-- constraints accept, and reads none of the new columns; the rows it wrote keep a NULL attempt and
-- turn_no, which no unique index counts.

BEGIN;

ALTER TABLE "users" ADD COLUMN "timezone" VARCHAR(64);
ALTER TABLE "users" ADD CONSTRAINT "users_timezone_check"
  CHECK ("timezone" IS NULL OR "timezone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$');

ALTER TABLE "push_subscriptions" ADD COLUMN "vapid_key" VARCHAR(128);

-- Push is switched on and off per browser now (Зп37): core no longer reads
-- notification_settings.push and pushes to every subscription of the user. A browser the client
-- turned off under the old switch lost only its own row; the other browsers of that client kept
-- theirs and stayed silent by the flag alone. They are given up here, so every browser of such a
-- client says «off», as the client last chose, until they turn push on in it again.
DELETE FROM "push_subscriptions" p
USING "notification_settings" s
WHERE s."user_id" = p."user_id" AND s."push" = false;

-- A scheduled task: of its creator's personal workspace.
CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "instructions" TEXT NOT NULL,
    "effort" VARCHAR(8) NOT NULL,
    "triggers" JSONB NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(6),
    "last_run_at" TIMESTAMPTZ(6),
    "paused_reason" VARCHAR(16),
    "refusal_streak" INTEGER NOT NULL DEFAULT 0,
    "last_refusal_reason" VARCHAR(24),
    "last_notified_at" TIMESTAMPTZ(6),
    "created_via" VARCHAR(16) NOT NULL,
    "template_slug" VARCHAR(40),
    "source_task_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_tasks_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "scheduled_tasks_instructions_check"
      CHECK (char_length("instructions") BETWEEN 1 AND 4000),
    CONSTRAINT "scheduled_tasks_effort_check" CHECK ("effort" IN ('low', 'high', 'max')),
    -- 0–5 schedules; their shapes are scheduleTriggersSchema's, checked by every writer.
    CONSTRAINT "scheduled_tasks_triggers_check"
      CHECK (jsonb_typeof("triggers") = 'array' AND jsonb_array_length("triggers") <= 5),
    CONSTRAINT "scheduled_tasks_timezone_check"
      CHECK ("timezone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
    CONSTRAINT "scheduled_tasks_paused_reason_check" CHECK (
      "paused_reason" IS NULL
      OR "paused_reason" IN ('completed', 'not_accepted', 'refused')
    ),
    CONSTRAINT "scheduled_tasks_last_refusal_reason_check" CHECK (
      "last_refusal_reason" IS NULL
      OR "last_refusal_reason" IN ('no_credits', 'needs_tariff', 'credits_held', 'weekly_limit',
        'daily_limit', 'consent', 'text_refused', 'previous_running', 'missed', 'paused',
        'platform')
    ),
    CONSTRAINT "scheduled_tasks_refusal_streak_check" CHECK ("refusal_streak" >= 0),
    -- A template names its slug, a chat its source; neither the other way round.
    CONSTRAINT "scheduled_tasks_created_via_check" CHECK (
      "created_via" IN ('manual', 'template', 'chat')
      AND ("template_slug" IS NULL OR "created_via" = 'template')
      AND ("source_task_id" IS NULL OR "created_via" = 'chat')
    ),
    -- A task off has no due moment (Зп13); one stopped by itself is off; a deleted one is off.
    CONSTRAINT "scheduled_tasks_next_run_check" CHECK ("enabled" OR "next_run_at" IS NULL),
    CONSTRAINT "scheduled_tasks_paused_check" CHECK ("paused_reason" IS NULL OR NOT "enabled"),
    CONSTRAINT "scheduled_tasks_deleted_check" CHECK ("deleted_at" IS NULL OR NOT "enabled")
);

-- What the tick of core reads every minute (Зп19).
CREATE INDEX "scheduled_tasks_due_idx" ON "scheduled_tasks"("next_run_at")
  WHERE (enabled AND (deleted_at IS NULL) AND (next_run_at IS NOT NULL));
CREATE INDEX "scheduled_tasks_workspace_id_idx" ON "scheduled_tasks"("workspace_id");
CREATE INDEX "scheduled_tasks_created_by_id_workspace_id_idx"
  ON "scheduled_tasks"("created_by_id", "workspace_id");
CREATE INDEX "scheduled_tasks_source_task_id_idx" ON "scheduled_tasks"("source_task_id");

ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_source_task_id_fkey"
  FOREIGN KEY ("source_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A run: `pending` until web answers, then started with its chat, refused or skipped.
CREATE TABLE "scheduled_runs" (
    "id" UUID NOT NULL,
    "scheduled_task_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "trigger" VARCHAR(8) NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'pending',
    "reason" VARCHAR(24),
    "task_id" UUID,
    "name" VARCHAR(80) NOT NULL,
    "instructions" TEXT NOT NULL,
    "effort" VARCHAR(8) NOT NULL,
    "missed_count" INTEGER NOT NULL DEFAULT 0,
    "missed_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),

    CONSTRAINT "scheduled_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
    CONSTRAINT "scheduled_runs_status_check"
      CHECK ("status" IN ('pending', 'started', 'refused', 'skipped')),
    CONSTRAINT "scheduled_runs_reason_check" CHECK (
      "reason" IS NULL
      OR "reason" IN ('no_credits', 'needs_tariff', 'credits_held', 'weekly_limit', 'daily_limit',
        'consent', 'text_refused', 'previous_running', 'missed', 'paused', 'platform')
    ),
    -- A chat and its start exactly when started; a reason exactly when refused or skipped.
    CONSTRAINT "scheduled_runs_task_check" CHECK (
      ("status" = 'started') = ("task_id" IS NOT NULL)
      AND ("status" = 'started') = ("started_at" IS NOT NULL)
    ),
    CONSTRAINT "scheduled_runs_outcome_check"
      CHECK (("status" IN ('refused', 'skipped')) = ("reason" IS NOT NULL)),
    CONSTRAINT "scheduled_runs_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "scheduled_runs_instructions_check"
      CHECK (char_length("instructions") BETWEEN 1 AND 4000),
    CONSTRAINT "scheduled_runs_effort_check" CHECK ("effort" IN ('low', 'high', 'max')),
    -- The due moments a row of «Пропущено» stands for; none on any other row. NOT DISTINCT: a
    -- NULL reason must not pass the CHECK as unknown.
    CONSTRAINT "scheduled_runs_missed_count_check" CHECK (
      "missed_count" >= 0 AND ("missed_count" = 0 OR "reason" IS NOT DISTINCT FROM 'missed')
    ),
    -- The end of the gap a row of «Пропущено» stands for: only on such a row, never before its start.
    CONSTRAINT "scheduled_runs_missed_until_check" CHECK (
      "missed_until" IS NULL
      OR ("reason" IS NOT DISTINCT FROM 'missed' AND "missed_until" >= "due_at")
    ),
    CONSTRAINT "scheduled_runs_attempts_check" CHECK ("attempts" >= 0)
);

-- One row per due moment of a task and its kind: a second claim or a second press writes nothing.
CREATE UNIQUE INDEX "scheduled_runs_scheduled_task_id_due_at_trigger_key"
  ON "scheduled_runs"("scheduled_task_id", "due_at", "trigger");
CREATE UNIQUE INDEX "scheduled_runs_task_id_key" ON "scheduled_runs"("task_id");
CREATE INDEX "scheduled_runs_scheduled_task_id_created_at_idx"
  ON "scheduled_runs"("scheduled_task_id", "created_at");
-- The runs the tick closes when web never answered (Зп21).
CREATE INDEX "scheduled_runs_pending_idx" ON "scheduled_runs"("status", "created_at")
  WHERE ((status)::text = 'pending'::text);

ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_scheduled_task_id_fkey"
  FOREIGN KEY ("scheduled_task_id") REFERENCES "scheduled_tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A change of the tasks the agent reserved in a turn, applied by core when the turn ended (Зп33).
CREATE TABLE "schedule_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "schedule_id" UUID,
    "payload" JSONB NOT NULL,
    "outcome" VARCHAR(8),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "schedule_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "schedule_reservations_kind_check" CHECK ("kind" IN ('create', 'update', 'delete')),
    CONSTRAINT "schedule_reservations_outcome_check" CHECK (
      ("outcome" IS NULL OR "outcome" IN ('done', 'refused', 'failed'))
      AND ("outcome" IS NULL) = ("closed_at" IS NULL)
    ),
    -- A change of a task names it; a creation names the task it made, once done.
    CONSTRAINT "schedule_reservations_schedule_check" CHECK (
      ("kind" = 'create' AND ("schedule_id" IS NULL OR "outcome" IS NOT DISTINCT FROM 'done'))
      OR ("kind" <> 'create' AND "schedule_id" IS NOT NULL)
    ),
    CONSTRAINT "schedule_reservations_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "schedule_reservations_turn_no_check" CHECK ("turn_no" >= 1)
);

CREATE INDEX "schedule_reservations_open_idx" ON "schedule_reservations"("task_id", "turn_no")
  WHERE (outcome IS NULL);
CREATE INDEX "schedule_reservations_workspace_id_idx" ON "schedule_reservations"("workspace_id");
CREATE INDEX "schedule_reservations_schedule_id_idx" ON "schedule_reservations"("schedule_id");

ALTER TABLE "schedule_reservations" ADD CONSTRAINT "schedule_reservations_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schedule_reservations" ADD CONSTRAINT "schedule_reservations_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "schedule_reservations" ADD CONSTRAINT "schedule_reservations_schedule_id_fkey"
  FOREIGN KEY ("schedule_id") REFERENCES "scheduled_tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Notices of a scheduled task (Зп38–Зп41): of a pass of its run's chat, or of the task itself.
ALTER TABLE "chat_notifications"
  ADD COLUMN "scheduled_task_id" UUID,
  ADD COLUMN "scheduled_run_id" UUID,
  ADD COLUMN "attempt" INTEGER,
  ADD COLUMN "turn_no" INTEGER,
  ALTER COLUMN "task_id" DROP NOT NULL;

ALTER TABLE "chat_notifications" DROP CONSTRAINT "chat_notifications_kind_check";
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_kind_check" CHECK (
  "kind" IN ('answered', 'question', 'ready', 'failed', 'limit', 'not_started', 'paused', 'missed')
);
-- A pass of a chat has its chat; only a notice of the task itself may have none.
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_target_check" CHECK (
  "task_id" IS NOT NULL
  OR ("scheduled_task_id" IS NOT NULL AND "kind" IN ('not_started', 'paused', 'missed'))
);
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_run_check"
  CHECK ("scheduled_run_id" IS NULL OR "scheduled_task_id" IS NOT NULL);
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_pass_check" CHECK (
  ("attempt" IS NULL) = ("turn_no" IS NULL)
  AND ("attempt" IS NULL OR "attempt" >= 1)
  AND ("turn_no" IS NULL OR "turn_no" >= 0)
);

-- One notice of a kind per pass and per run: `INSERT … ON CONFLICT DO NOTHING` sends nothing twice.
CREATE UNIQUE INDEX "chat_notifications_pass_key"
  ON "chat_notifications"("task_id", "kind", "attempt", "turn_no") WHERE (task_id IS NOT NULL);
CREATE UNIQUE INDEX "chat_notifications_run_key"
  ON "chat_notifications"("scheduled_run_id", "kind") WHERE (scheduled_run_id IS NOT NULL);
CREATE INDEX "chat_notifications_scheduled_task_id_created_at_idx"
  ON "chat_notifications"("scheduled_task_id", "created_at");

ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_scheduled_task_id_fkey"
  FOREIGN KEY ("scheduled_task_id") REFERENCES "scheduled_tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_scheduled_run_id_fkey"
  FOREIGN KEY ("scheduled_run_id") REFERENCES "scheduled_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
