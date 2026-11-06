-- A chat has no mode any more: the way it works follows from its project
-- (docs/plan/61-chats-first.md, К1). `needs_repository` and `needs_browser` carry all of it.
-- Applied with `web`, `core` and `mcp` stopped: each reads whole rows of `tasks`, and a tree
-- without this migration does not work with the database after it.
BEGIN;
ALTER TABLE "tasks" DROP COLUMN "mode";
DROP TYPE "TaskMode";
COMMIT;
