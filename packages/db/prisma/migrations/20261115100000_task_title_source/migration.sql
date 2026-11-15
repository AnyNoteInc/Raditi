-- Who named a dialog (owner's request of 15.11.2026): the agent gives a chat its title on the
-- first pass, unless the client has renamed it. Existing dialogs keep their titles: a renamed
-- one cannot be told from the rest, so all start as `request` and no agent renames them — the
-- agent is asked for a title only on the first pass of a chat.
CREATE TYPE "TaskTitleSource" AS ENUM ('request', 'agent', 'client');

ALTER TABLE "tasks" ADD COLUMN "title_source" "TaskTitleSource" NOT NULL DEFAULT 'request';
