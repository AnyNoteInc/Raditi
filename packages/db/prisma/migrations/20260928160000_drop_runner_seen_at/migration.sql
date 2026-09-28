-- Nothing read it: a runner's liveness is its poll, kept in core's memory (spec §8).
-- AlterTable
ALTER TABLE "turn_assignments" DROP COLUMN "runner_seen_at";
