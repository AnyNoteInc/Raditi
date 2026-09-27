-- CreateEnum
CREATE TYPE "TurnExecutorKind" AS ENUM ('local', 'runner');

-- CreateEnum
CREATE TYPE "TurnAssignmentOutcome" AS ENUM ('completed', 'failed', 'lost');

-- CreateTable
CREATE TABLE "turn_assignments" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "executor" "TurnExecutorKind" NOT NULL,
    "plan" JSONB NOT NULL,
    "first_epoch" INTEGER NOT NULL,
    "lease_epoch" INTEGER NOT NULL,
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "runner_id" VARCHAR(63),
    "runner_session" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "runner_seen_at" TIMESTAMPTZ(6),
    "container_id" VARCHAR(200),
    "recovery_attempts" INTEGER NOT NULL DEFAULT 0,
    "outcome" "TurnAssignmentOutcome",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "turn_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "turn_assignments_site_id_idx" ON "turn_assignments"("site_id");

-- CreateIndex
CREATE INDEX "turn_assignments_runner_id_runner_session_idx" ON "turn_assignments"("runner_id", "runner_session");

-- CreateIndex
CREATE UNIQUE INDEX "turn_assignments_active_turn_key" ON "turn_assignments"("task_id", "turn_no") WHERE (finished_at IS NULL);

-- AddForeignKey
ALTER TABLE "turn_assignments" ADD CONSTRAINT "turn_assignments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_assignments" ADD CONSTRAINT "turn_assignments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants Prisma cannot express (spec §8, §16); Prisma ignores CHECKs when diffing.
ALTER TABLE "turn_assignments"
  ADD CONSTRAINT "turn_assignments_turn_no_check" CHECK ("turn_no" > 0),
  ADD CONSTRAINT "turn_assignments_epochs_check"
    CHECK ("first_epoch" > 0 AND "lease_epoch" >= "first_epoch"),
  ADD CONSTRAINT "turn_assignments_recovery_attempts_check" CHECK ("recovery_attempts" >= 0),
  -- A runner session holds only runner turns, and a runner id never comes without its session.
  ADD CONSTRAINT "turn_assignments_runner_check"
    CHECK (("runner_id" IS NULL) = ("runner_session" IS NULL)
      AND ("runner_id" IS NULL OR "executor" = 'runner')
      AND ("runner_id" IS NULL) = ("claimed_at" IS NULL)),
  ADD CONSTRAINT "turn_assignments_outcome_check"
    CHECK (("finished_at" IS NULL) = ("outcome" IS NULL));
