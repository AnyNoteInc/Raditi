-- The wake of the outbox relay (перенос ускорений, docs/plan/86-speedups.md): a statement that
-- adds rows to outbox_events says so on the channel raditi_outbox once its transaction commits,
-- and core runs a pass of its relay at once instead of at its next poll (every second, still the
-- fallback). A trigger only: no row is read or written.
CREATE FUNCTION "raditi_outbox_wake"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_notify('raditi_outbox', '');
  RETURN NULL;
END $fn$;

CREATE TRIGGER "outbox_events_wake" AFTER INSERT ON "outbox_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "raditi_outbox_wake"();
