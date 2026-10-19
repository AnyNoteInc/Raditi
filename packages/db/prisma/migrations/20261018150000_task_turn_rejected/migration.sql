-- «Попробовать ещё» (docs/plan/53-chat-preview-release.md, «Попробовать ещё (18.10)»): a pass
-- whose turn the platform refused — the turn failed, or completed with a result the platform could
-- not take (no readable words, a change too large or refused) — is marked with the moment the
-- failure was written. A dialog that kept its candidate goes on after such a turn: the planner
-- replaces it instead of continuing from it, «Обновить» does not carry its head, and its model
-- calls are not charged to the client (`taskRawCredits`), as the calls of a `lost` turn are not.
-- A new column, empty for every row there is: nothing to stop and nothing to move.
ALTER TABLE "task_turns" ADD COLUMN "rejected_at" TIMESTAMPTZ(6);
