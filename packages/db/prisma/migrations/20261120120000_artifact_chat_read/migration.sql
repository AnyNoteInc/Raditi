-- A chat that read an artifact it did not make keeps where it read up to (docs/plan/88-artifacts.md,
-- Ар21, slice 88.6): `artifact_chats.how = 'read'`. Such a row opens nothing by itself (Ар23). Only
-- widens the CHECK, no stop: the code before never writes the new value.
BEGIN;
ALTER TABLE "artifact_chats" DROP CONSTRAINT "artifact_chats_check";
ALTER TABLE "artifact_chats" ADD CONSTRAINT "artifact_chats_check" CHECK (
  "how" IN ('created', 'attached', 'mentioned', 'edited', 'read') AND "read_seq" >= 0
);
COMMIT;
