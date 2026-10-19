-- Initial import of a connected site (docs/plan/39-site-connection-wizard.md): what a running
-- stage is doing, the first version the site's repository got, and the claim that keeps two
-- identical «Добавить проект» from writing Vault at once. Expand only: every existing row
-- passes the new checks with the new column NULL.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

ALTER TABLE "site_provisioning_stages" ADD COLUMN "step" VARCHAR(32);

CREATE TABLE "site_initial_versions" (
    "site_id" UUID NOT NULL,
    "git_repository_id" UUID NOT NULL,
    "commit_sha" CHAR(40) NOT NULL,
    "tag" VARCHAR(64) NOT NULL,
    "files" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "lease_epoch" INTEGER NOT NULL,
    "imported_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_initial_versions_pkey" PRIMARY KEY ("site_id")
);

CREATE TABLE "site_creation_claims" (
    "site_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_creation_claims_pkey" PRIMARY KEY ("site_id")
);

CREATE INDEX "site_initial_versions_git_repository_id_idx" ON "site_initial_versions"("git_repository_id");
CREATE INDEX "site_creation_claims_user_id_idx" ON "site_creation_claims"("user_id");

ALTER TABLE "site_initial_versions" ADD CONSTRAINT "site_initial_versions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_initial_versions" ADD CONSTRAINT "site_initial_versions_git_repository_id_fkey" FOREIGN KEY ("git_repository_id") REFERENCES "git_repositories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "site_creation_claims" ADD CONSTRAINT "site_creation_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs).
ALTER TABLE "site_provisioning_stages"
  -- A step names what a running stage does; a queued or finished stage has none.
  ADD CONSTRAINT "site_provisioning_stages_step_check"
    CHECK ("step" IS NULL OR ("status" = 'running' AND "step" ~ '^[a-z][a-z_]{1,31}$'));

ALTER TABLE "site_initial_versions"
  ADD CONSTRAINT "site_initial_versions_commit_sha_check" CHECK ("commit_sha" ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT "site_initial_versions_tag_check" CHECK ("tag" ~ '^v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$'),
  ADD CONSTRAINT "site_initial_versions_counts_check"
    CHECK ("files" >= 0 AND "bytes" >= 0 AND "lease_epoch" >= 1);

COMMIT;
