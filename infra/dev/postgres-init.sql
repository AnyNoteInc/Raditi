-- Local PostgreSQL uses the image's single application login, raditi.
-- The init hook runs only on an empty volume. To upgrade an existing local volume:
--   docker compose -f infra/dev/docker-compose.yml exec -T postgres \
--     psql -U raditi -d raditi -v ON_ERROR_STOP=1 < infra/dev/postgres-init.sql

BEGIN;
REVOKE CONNECT, TEMPORARY ON DATABASE raditi FROM PUBLIC;

-- Exporter and applications now use raditi. Remove legacy grants without deleting data.
DO $legacy_roles$
DECLARE
  legacy_name TEXT;
  legacy_oid OID;
  database_oid OID := (SELECT oid FROM pg_database WHERE datname = current_database());
BEGIN
  FOREACH legacy_name IN ARRAY ARRAY['raditi_web', 'raditi_core', 'raditi_llm', 'raditi_app', 'postgres_exporter']
  LOOP
    SELECT oid INTO legacy_oid FROM pg_roles WHERE rolname = legacy_name;
    IF legacy_oid IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT FROM pg_shdepend
      WHERE refclassid = 'pg_authid'::regclass AND refobjid = legacy_oid AND deptype = 'o'
        AND classid <> 'pg_default_acl'::regclass
    ) THEN
      RAISE EXCEPTION 'Legacy role % owns objects; review ownership before rerunning bootstrap', legacy_name;
    END IF;
    IF EXISTS (
      SELECT FROM pg_shdepend
      WHERE refclassid = 'pg_authid'::regclass AND refobjid = legacy_oid
        AND (
          (dbid <> 0 AND dbid <> database_oid)
          OR (dbid = 0 AND classid = 'pg_database'::regclass AND objid <> database_oid)
        )
    ) THEN
      RAISE EXCEPTION 'Legacy role % has dependencies in another database; review them before rerunning bootstrap', legacy_name;
    END IF;
    -- Only grants and default ACL settings remain after the ownership guard.
    EXECUTE format('DROP OWNED BY %I RESTRICT', legacy_name);
    EXECUTE format('DROP ROLE %I', legacy_name);
  END LOOP;
END;
$legacy_roles$;
COMMIT;
