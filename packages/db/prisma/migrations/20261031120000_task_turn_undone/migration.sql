-- `/undo` of a chat (docs/plan/61-chats-first.md, §5.14): the client took the turn back. Not
-- `rejected_at`, which takes the money off the turn: an undone turn stays paid.
ALTER TABLE "task_turns" ADD COLUMN "undone_at" TIMESTAMPTZ(6);
