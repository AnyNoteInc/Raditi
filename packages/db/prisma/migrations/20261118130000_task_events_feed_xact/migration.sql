-- The transaction that wrote each row of task_events (spec §7, «Лента для клиента»; перенос
-- ускорений, docs/plan/86-speedups.md). A reader of the feed moves its cursor past the rows it saw;
-- a row with a smaller id that commits later would be missed — until now the page read the whole
-- feed again from its first row at every change of the status to find such rows. With the id of
-- the writing transaction the next read also takes the rows of every transaction its last read
-- could not see (`pg_snapshot_xmax`, `pg_snapshot_xip`), so the cursor never skips a row and the
-- page never reads from the start.
--
-- No rewrite and no long lock: the column comes without a default (the rows before it are of
-- transactions long committed and stay NULL; adding a nullable column changes only the catalog),
-- and the default then applies to new rows only. Each takes the ACCESS EXCLUSIVE lock of
-- task_events for a moment. The index is built in the same request: a SHARE lock, the writes of
-- task_events wait while it reads the rows of the feed — on production about 22 500 rows of
-- task_events in all and a few thousand of the feed, well under a second.
ALTER TABLE "task_events" ADD COLUMN "xact" xid8;
ALTER TABLE "task_events" ALTER COLUMN "xact" SET DEFAULT pg_current_xact_id();

-- The second half of a read of the feed: the rows of the task's feed by their transaction.
CREATE INDEX "task_events_feed_xact_idx" ON "task_events"("task_id", "xact") WHERE client_visible;
