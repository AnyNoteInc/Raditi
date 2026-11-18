-- Signals of a changed chat (spec §7, «Лента для клиента»; перенос ускорений,
-- docs/plan/86-speedups.md). A committed change of what the page of a chat reads — a row of its
-- feed, a batch of the agent's output, the task itself, its browser — sends `<task id>:<kind>` on
-- the channel raditi_task, `feed` or `activity`. PostgreSQL delivers a notification only once its
-- transaction has committed, and folds the same payload of one transaction into one. core relays
-- them to Redis, web to the page as a hint to read now: the page reads by its cursor all the same,
-- and a lost signal costs only the time of the next poll.
--
-- Triggers only: no row is read or written, and each CREATE TRIGGER takes the lock of its table
-- for a moment (SHARE ROW EXCLUSIVE: writes wait, reads go on).

CREATE FUNCTION "raditi_task_signal"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('raditi_task', NEW.task_id::text || ':' || TG_ARGV[0]);
  RETURN NULL;
END $fn$;

-- The task itself: its id is its own.
CREATE FUNCTION "raditi_task_row_signal"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('raditi_task', NEW.id::text || ':feed');
  RETURN NULL;
END $fn$;

CREATE TRIGGER "task_events_feed_signal" AFTER INSERT ON "task_events"
  FOR EACH ROW WHEN (NEW.client_visible) EXECUTE FUNCTION "raditi_task_signal"('feed');
CREATE TRIGGER "task_events_activity_signal" AFTER INSERT ON "task_events"
  FOR EACH ROW WHEN (NEW.type = 'turn.output') EXECUTE FUNCTION "raditi_task_signal"('activity');
CREATE TRIGGER "tasks_signal" AFTER UPDATE ON "tasks"
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION "raditi_task_row_signal"();
CREATE TRIGGER "browser_sessions_signal" AFTER INSERT OR UPDATE ON "browser_sessions"
  FOR EACH ROW EXECUTE FUNCTION "raditi_task_signal"('feed');
