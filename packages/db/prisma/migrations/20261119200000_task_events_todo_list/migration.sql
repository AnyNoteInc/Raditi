-- The agent's plan of its work beside the chat (docs/plan/89-agent-todos.md, ТД4, §5.3). The list
-- has no state of its own: `task.todo` reads the last `todo_list` event the agent wrote in the
-- journal of its last counted turns — the newest row `turn.output` of a turn that holds one. Only
-- (turn_id) and (task_id, id) indexes existed, so each read would go through every journal row of
-- the turn, thousands for a long one; this partial index holds only the rows with a list, and the
-- read takes the newest of a turn from its end.
--
-- No row is changed. The predicate is written as PostgreSQL stores it (the casts of a varchar
-- column), and the read repeats it word for word, or the planner does not take the index. CREATE
-- INDEX reads task_events under a SHARE lock: its writes wait while it is built — on production
-- about 22 500 rows of task_events in all (61 MB) and none with a list yet; the partial index
-- task_events_feed_xact_idx on a database four times larger was built in 16.5 ms
-- (docs/plan/86-speedups.md, §6).
CREATE INDEX "task_events_todo_list_idx" ON "task_events"("turn_id", "id")
  WHERE type::text = 'turn.output'::text
    AND payload @> '{"events": [{"type": "todo_list"}]}'::jsonb;
