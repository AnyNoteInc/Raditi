#!/bin/sh
# One application login, raditi, owns the database and schema (spec §15).
# Run again after changing postgres/password or upgrading an older role layout.
# superuser-password serves the first initdb only; postgres keeps socket access
# for maintenance and has no password for network connections.
set -eu
[ -r /run/raditi/password ] && [ -s /run/raditi/password ] || {
  echo 'PostgreSQL bootstrap: /run/raditi/password is missing, unreadable or empty' >&2
  exit 1
}
psql -v ON_ERROR_STOP=1 --username postgres --dbname raditi <<'SQL'
\set app_pw `cat /run/raditi/password`
BEGIN;
SELECT 'CREATE ROLE raditi LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi') \gexec
ALTER ROLE raditi LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_pw';
ALTER ROLE postgres PASSWORD NULL;
ALTER DATABASE raditi OWNER TO raditi;
ALTER SCHEMA public OWNER TO raditi;
REVOKE ALL ON DATABASE raditi FROM PUBLIC;
GRANT CONNECT ON DATABASE raditi TO raditi;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Previous releases granted table, column and default privileges to these roles.
-- Remove only that known layout, atomically. Unexpected ownership or dependencies
-- in another database require manual review; never delete or reassign their data.
-- Historical migrations remain unchanged and skip grants when legacy roles are absent.
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
SQL
