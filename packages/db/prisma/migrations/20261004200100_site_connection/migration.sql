-- Site connection wizard (spec §12): where a site's files and database are, and the two stages
-- that follow «Добавить сайт». Secrets stay in Vault (kv/sites/<siteId>/<kind>); every column
-- here is public or an id.
-- Expand only: the new columns of "sites" are NULL in every existing row, and the replaced CHECK
-- accepts everything its predecessor accepted.
--
-- One transaction: Prisma sends a migration statement by statement, and a constraint dropped
-- here must never be left without the one that replaces it.
BEGIN;

CREATE TYPE "SiteSourceKind" AS ENUM ('ftp', 'sftp', 'git');
CREATE TYPE "DatabaseEngine" AS ENUM ('mysql', 'postgres');
CREATE TYPE "ConnectionTls" AS ENUM ('verified', 'unverified', 'plain');
CREATE TYPE "ProvisioningStage" AS ENUM ('code_import', 'database_schema');
CREATE TYPE "ProvisioningStageStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

ALTER TABLE "sites"
  ADD COLUMN "description" VARCHAR(2000),
  ADD COLUMN "healthcheck_url" VARCHAR(1024);

CREATE TABLE "site_code_sources" (
    "site_id" UUID NOT NULL,
    "kind" "SiteSourceKind" NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "root_path" VARCHAR(1024),
    "repository_url" VARCHAR(1024),
    "branch" VARCHAR(255),
    "tls" "ConnectionTls",
    "host_key" VARCHAR(128),
    "credential_ref_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_code_sources_pkey" PRIMARY KEY ("site_id")
);

CREATE TABLE "site_databases" (
    "site_id" UUID NOT NULL,
    "engine" "DatabaseEngine" NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "database_name" VARCHAR(128) NOT NULL,
    "tls" "ConnectionTls" NOT NULL,
    "credential_ref_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_databases_pkey" PRIMARY KEY ("site_id")
);

CREATE TABLE "site_provisioning_stages" (
    "site_id" UUID NOT NULL,
    "stage" "ProvisioningStage" NOT NULL,
    "status" "ProvisioningStageStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "enqueues" INTEGER NOT NULL DEFAULT 1,
    "lease_epoch" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(64),
    "summary" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_provisioning_stages_pkey" PRIMARY KEY ("site_id", "stage")
);

CREATE TABLE "site_database_schemas" (
    "site_id" UUID NOT NULL,
    "engine" "DatabaseEngine" NOT NULL,
    "server_version" VARCHAR(64),
    "tables_count" INTEGER NOT NULL,
    "columns_count" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "schema" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_database_schemas_pkey" PRIMARY KEY ("site_id")
);

CREATE INDEX "site_code_sources_credential_ref_id_idx" ON "site_code_sources"("credential_ref_id");
CREATE INDEX "site_databases_credential_ref_id_idx" ON "site_databases"("credential_ref_id");
-- What the recovery sweep reads; the predicate is written as PostgreSQL stores it.
CREATE INDEX "site_provisioning_stages_unfinished_idx" ON "site_provisioning_stages"("updated_at") WHERE finished_at IS NULL;

ALTER TABLE "site_code_sources" ADD CONSTRAINT "site_code_sources_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_code_sources" ADD CONSTRAINT "site_code_sources_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_databases" ADD CONSTRAINT "site_databases_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_databases" ADD CONSTRAINT "site_databases_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_provisioning_stages" ADD CONSTRAINT "site_provisioning_stages_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_database_schemas" ADD CONSTRAINT "site_database_schemas_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs).
ALTER TABLE "sites"
  ADD CONSTRAINT "sites_healthcheck_url_check"
    CHECK ("healthcheck_url" IS NULL OR "healthcheck_url" ~ '^https?://');

ALTER TABLE "site_code_sources"
  ADD CONSTRAINT "site_code_sources_port_check" CHECK ("port" BETWEEN 1 AND 65535),
  -- A repository has an address and no folder; a server has a folder and no repository.
  ADD CONSTRAINT "site_code_sources_shape_check" CHECK (
    ("kind" = 'git' AND "repository_url" IS NOT NULL AND "repository_url" ~ '^https://' AND "root_path" IS NULL)
    OR ("kind" <> 'git' AND "root_path" IS NOT NULL AND "repository_url" IS NULL AND "branch" IS NULL)
  ),
  -- Only FTP has a choice of protection; git is always verified HTTPS, SSH has its host key.
  ADD CONSTRAINT "site_code_sources_tls_check" CHECK (("kind" = 'ftp') = ("tls" IS NOT NULL)),
  ADD CONSTRAINT "site_code_sources_host_key_check" CHECK (("kind" = 'sftp') = ("host_key" IS NOT NULL));

ALTER TABLE "site_databases"
  ADD CONSTRAINT "site_databases_port_check" CHECK ("port" BETWEEN 1 AND 65535);

ALTER TABLE "site_provisioning_stages"
  ADD CONSTRAINT "site_provisioning_stages_counters_check"
    CHECK ("attempt" >= 1 AND "enqueues" >= 1 AND "lease_epoch" >= 0),
  -- finished_at is the one sign of a terminal stage: the partial index relies on it.
  ADD CONSTRAINT "site_provisioning_stages_finished_check"
    CHECK (("status" IN ('succeeded', 'failed')) = ("finished_at" IS NOT NULL)),
  ADD CONSTRAINT "site_provisioning_stages_error_check"
    CHECK (("status" = 'failed') = ("error_code" IS NOT NULL)),
  ADD CONSTRAINT "site_provisioning_stages_error_code_check"
    CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z_]{1,63}$'),
  -- Counts and one flag only; never a path, a host or a message.
  ADD CONSTRAINT "site_provisioning_stages_summary_check"
    CHECK ("summary" IS NULL OR (jsonb_typeof("summary") = 'object' AND octet_length("summary"::text) <= 2048));

ALTER TABLE "site_database_schemas"
  ADD CONSTRAINT "site_database_schemas_counts_check" CHECK ("tables_count" >= 0 AND "columns_count" >= 0),
  ADD CONSTRAINT "site_database_schemas_schema_check"
    CHECK (jsonb_typeof("schema") = 'object' AND octet_length("schema"::text) <= 2097152);

-- The database access of a site is a site access like the other four. 'git' stays outside: a
-- workspace-level git credential (P8) may have no site, and the old CHECK accepted it.
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_site_scope_check";
ALTER TABLE "credential_refs"
  ADD CONSTRAINT "credential_refs_site_scope_check"
    CHECK ("kind" NOT IN ('ssh', 'ftp', 'wp', 'browser', 'db') OR "site_id" IS NOT NULL);

COMMIT;
