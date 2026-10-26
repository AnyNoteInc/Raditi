-- The copy of the files of the first import in raditi-backups (owner's request of 26.10.2026):
-- a tar.gz of the commit `v0.0.0` at sites/<siteId>/initial/<commitSha>.tar.gz, made by core
-- after the import published it. All four columns together, or none: a copy not made yet.
ALTER TABLE "site_initial_versions"
  ADD COLUMN "backup_object_key" VARCHAR(1024),
  ADD COLUMN "backup_bytes" BIGINT,
  ADD COLUMN "backup_sha256" CHAR(64),
  ADD COLUMN "backup_saved_at" TIMESTAMPTZ(6);

ALTER TABLE "site_initial_versions"
  ADD CONSTRAINT "site_initial_versions_backup_check" CHECK (
    ("backup_object_key" IS NULL AND "backup_bytes" IS NULL AND "backup_sha256" IS NULL
      AND "backup_saved_at" IS NULL)
    OR ("backup_object_key" IS NOT NULL AND "backup_bytes" >= 0
      AND "backup_sha256" ~ '^[0-9a-f]{64}$' AND "backup_saved_at" IS NOT NULL
      AND "imported_at" IS NOT NULL)
  );
