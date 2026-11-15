-- «Сначала план» is removed (owner's request of 14.11.2026, docs/plan/76-agent-instructions.md, И7):
-- the queue of a chat keeps no mark of it. Words queued with it go as ordinary words.
ALTER TABLE "task_queued_messages" DROP COLUMN "plan";
