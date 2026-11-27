-- Quick edits of artifact notes (docs/plan/98-quick-edits.md, БПр2–БПр4, БПр15): the service task
-- «Быстрые правки» of a person, the flag of model profiles only a quick edit takes, and the rows
-- of the edits themselves (no text: the notes are in artifact_comment_dispatches, the result in
-- the artifact).
BEGIN;

CREATE TYPE "TaskKind" AS ENUM ('chat', 'quick_edits');

ALTER TABLE "tasks" ADD COLUMN "kind" "TaskKind" NOT NULL DEFAULT 'chat';

-- A quick task is billed, has no chat session, project or browser and reverts nothing (БПр2).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK (
    "kind" = 'chat'
    OR ("billable" AND "chat_session_id" IS NULL AND "project_id" IS NULL
        AND NOT "needs_browser" AND "reverts_task_id" IS NULL)
);

-- One live quick task per person and workspace: two first clicks cannot make two.
CREATE UNIQUE INDEX "tasks_quick_edits_owner_key" ON "tasks" ("workspace_id", "created_by_id")
    WHERE "kind" = 'quick_edits' AND "deleted_at" IS NULL;

-- A profile only a quick edit takes; a turn of OpenCode never gets it (БПр3).
ALTER TABLE "llm_models" ADD COLUMN "quick" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_quick_check" CHECK (NOT ("quick" AND "vision"));

CREATE TYPE "ArtifactQuickEditState" AS ENUM ('queued', 'running', 'applied', 'unchanged', 'refused', 'failed');

CREATE TABLE "artifact_quick_edits" (
    "id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "state" "ArtifactQuickEditState" NOT NULL DEFAULT 'queued',
    "reason" VARCHAR(32),
    "calls" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "artifact_quick_edits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_quick_edits_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "artifact_quick_edits_calls_check" CHECK ("calls" BETWEEN 0 AND 2),
    CONSTRAINT "artifact_quick_edits_finished_check" CHECK (("state" IN ('queued', 'running')) = ("finished_at" IS NULL))
);

CREATE UNIQUE INDEX "artifact_quick_edits_user_id_request_id_key" ON "artifact_quick_edits" ("user_id", "request_id");
CREATE UNIQUE INDEX "artifact_quick_edits_task_id_attempt_key" ON "artifact_quick_edits" ("task_id", "attempt");
CREATE INDEX "artifact_quick_edits_artifact_idx" ON "artifact_quick_edits" ("artifact_id", "created_at" DESC);
CREATE INDEX "artifact_quick_edits_open_idx" ON "artifact_quick_edits" ("created_at") WHERE "finished_at" IS NULL;

ALTER TABLE "artifact_quick_edits" ADD CONSTRAINT "artifact_quick_edits_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "chat_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_quick_edits" ADD CONSTRAINT "artifact_quick_edits_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "artifact_quick_edits" ADD CONSTRAINT "artifact_quick_edits_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The page learns how an edit ended, with or without a change of the artifact.
CREATE FUNCTION "artifact_quick_edits_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('raditi_artifact', NEW."artifact_id"::text);
    RETURN NULL;
END;
$$;

CREATE TRIGGER "artifact_quick_edits_finished"
    AFTER UPDATE OF "finished_at" ON "artifact_quick_edits"
    FOR EACH ROW WHEN (OLD."finished_at" IS NULL AND NEW."finished_at" IS NOT NULL)
    EXECUTE FUNCTION "artifact_quick_edits_notify"();

COMMIT;
