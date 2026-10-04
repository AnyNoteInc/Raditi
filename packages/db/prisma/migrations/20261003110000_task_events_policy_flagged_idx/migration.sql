-- The subscription gateway asks on every key lookup and admission, and core on every key issue,
-- whether the task was refused for content: EXISTS on task_events with
-- type = 'llm.policy_flagged' (spec §9). Only the (task_id, id) index existed, so each check
-- read every event of the task, thousands for a long one. A task has at most one such event:
-- the partial index stays a few pages whatever the size of task_events. No row is changed.
CREATE INDEX "task_events_llm_policy_flagged_idx" ON "task_events"("task_id") WHERE "type" = 'llm.policy_flagged';
