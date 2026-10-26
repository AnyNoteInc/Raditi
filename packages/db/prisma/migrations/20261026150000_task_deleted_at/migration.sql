-- «Удалить диалог» (owner's request of 26.10.2026): a dialog the client deleted keeps its row —
-- its turns, events, credit holds, ledger, releases and LLM calls point at it and stay — and is
-- marked `deleted_at`. The cabinet no longer finds it; what it set aside was given back and its
-- preview went with the cancel before the mark. A new column, empty for every row there is.
ALTER TABLE "tasks" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
