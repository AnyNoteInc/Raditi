#!/bin/sh
# Roles of the platform database (spec §15). The image's superuser runs only this script; the
# schema belongs to raditi (migrate, seed); web and core get DML through raditi_app, except on
# the migration history. Idempotent: run it again after the first migration and after a password
# rotation (README.md). superuser-password serves the first initdb
# only: the script drops it, so the superuser has the socket and nothing over the network.
set -eu
psql -v ON_ERROR_STOP=1 --username postgres --dbname raditi <<'SQL'
\set owner_pw `cat /run/raditi/owner-password`
\set web_pw `cat /run/raditi/web-password`
\set core_pw `cat /run/raditi/core-password`
SELECT 'CREATE ROLE raditi LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi') \gexec
SELECT 'CREATE ROLE raditi_app NOLOGIN'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi_app') \gexec
SELECT 'CREATE ROLE raditi_web LOGIN IN ROLE raditi_app'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi_web') \gexec
SELECT 'CREATE ROLE raditi_core LOGIN IN ROLE raditi_app'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'raditi_core') \gexec
ALTER ROLE raditi PASSWORD :'owner_pw';
ALTER ROLE raditi_web PASSWORD :'web_pw';
ALTER ROLE raditi_core PASSWORD :'core_pw';
ALTER ROLE postgres PASSWORD NULL;
ALTER DATABASE raditi OWNER TO raditi;
ALTER SCHEMA public OWNER TO raditi;
REVOKE ALL ON DATABASE raditi FROM PUBLIC;
GRANT CONNECT ON DATABASE raditi TO raditi, raditi_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO raditi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE raditi IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO raditi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE raditi IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO raditi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO raditi_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO raditi_app;
-- After the grants, so that no run gives it back: the history decides which DDL migrate runs.
SELECT 'REVOKE ALL ON TABLE public._prisma_migrations FROM raditi_app'
  WHERE to_regclass('public._prisma_migrations') IS NOT NULL \gexec
SQL
