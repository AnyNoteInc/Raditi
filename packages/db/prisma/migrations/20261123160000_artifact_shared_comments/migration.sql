-- Threads other people see (plan 88, Ар53, Э10а, slice 88.17а); additive: every existing note stays
-- the owner's private one.
ALTER TABLE "artifact_comments" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
