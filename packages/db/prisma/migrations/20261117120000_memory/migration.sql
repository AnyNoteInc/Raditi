-- The memory of an account and of its projects (docs/plan/84-projects.md, ПР18, ПР28; slice 84.11):
-- notes of the client and of the agent — `memory_entries`, project_id NULL for the account's — the
-- changes the agent reserves in a turn for core to apply at its end — `memory_reservations` — and
-- the switch «Агент запоминает важное» of the user (`users.agent_memory`, on by default). Adds only:
-- a column with a default and two new tables, so nothing stops and nothing is carried over.
--
-- One transaction: nothing here raises, and a half-applied memory must not stay behind.
BEGIN;

ALTER TABLE "users" ADD COLUMN     "agent_memory" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "memory_entries" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_id" UUID,
    "kind" VARCHAR(12) NOT NULL,
    "text" VARCHAR(400) NOT NULL,
    "status" VARCHAR(10) NOT NULL,
    "author" VARCHAR(8) NOT NULL,
    "source_task_id" UUID,
    "source_turn" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmed_at" TIMESTAMPTZ(6),
    "pending_action" VARCHAR(8),
    "pending_text" VARCHAR(400),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_reservations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "entry_id" UUID,
    "payload" JSONB NOT NULL,
    "outcome" VARCHAR(8),
    "reason" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "memory_reservations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_entries_user_id_project_id_status_idx" ON "memory_entries"("user_id", "project_id", "status");

CREATE INDEX "memory_entries_workspace_id_idx" ON "memory_entries"("workspace_id");

CREATE INDEX "memory_entries_project_id_idx" ON "memory_entries"("project_id");

CREATE INDEX "memory_entries_source_task_id_idx" ON "memory_entries"("source_task_id");

CREATE INDEX "memory_reservations_open_idx" ON "memory_reservations"("task_id", "turn_no") WHERE (outcome IS NULL);

CREATE INDEX "memory_reservations_stale_idx" ON "memory_reservations"("created_at") WHERE (outcome IS NULL);

CREATE INDEX "memory_reservations_workspace_id_idx" ON "memory_reservations"("workspace_id");

CREATE INDEX "memory_reservations_entry_id_idx" ON "memory_reservations"("entry_id");

ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_source_task_id_fkey" FOREIGN KEY ("source_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "memory_reservations" ADD CONSTRAINT "memory_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_reservations" ADD CONSTRAINT "memory_reservations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_reservations" ADD CONSTRAINT "memory_reservations_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "memory_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs), as memoryKinds, memoryStatuses,
-- memoryAuthors, memoryPendingActions, memoryChangeKinds and memoryLimits of @repo/domain: a text of
-- 1 to 400 characters after trimming; a proposal over an entry only on an active one, and the new
-- text exactly with an update.
ALTER TABLE "memory_entries"
  ADD CONSTRAINT "memory_entries_kind_check" CHECK ("kind" IN ('preference', 'fact', 'decision', 'reference')),
  ADD CONSTRAINT "memory_entries_text_check" CHECK (char_length(btrim("text")) BETWEEN 1 AND 400),
  ADD CONSTRAINT "memory_entries_status_check" CHECK ("status" IN ('active', 'proposed')),
  ADD CONSTRAINT "memory_entries_author_check" CHECK ("author" IN ('agent', 'client')),
  ADD CONSTRAINT "memory_entries_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "memory_entries_pending_action_check" CHECK ("pending_action" IS NULL OR "pending_action" IN ('update', 'forget')),
  ADD CONSTRAINT "memory_entries_pending_text_check" CHECK (("pending_action" = 'update') = ("pending_text" IS NOT NULL) AND ("pending_text" IS NULL OR char_length(btrim("pending_text")) BETWEEN 1 AND 400)),
  ADD CONSTRAINT "memory_entries_pending_active_check" CHECK ("pending_action" IS NULL OR "status" = 'active');

ALTER TABLE "memory_reservations"
  ADD CONSTRAINT "memory_reservations_kind_check" CHECK ("kind" IN ('save', 'update', 'forget')),
  ADD CONSTRAINT "memory_reservations_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('done', 'refused', 'failed')),
  ADD CONSTRAINT "memory_reservations_closed_check" CHECK (("outcome" IS NULL) = ("closed_at" IS NULL));

COMMIT;
