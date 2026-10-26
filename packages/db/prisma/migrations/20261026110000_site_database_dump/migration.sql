-- A SQL dump on the site's file source as the source of a preview's database copy, for a site
-- whose database answers only on the hosting (owner's decision of 26.10.2026). Expand only: a new
-- table, no existing row changes.
--
-- One transaction: nothing here raises, and a half-applied file must not stay behind.
BEGIN;

CREATE TABLE "site_database_dumps" (
    "site_id" UUID NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_database_dumps_pkey" PRIMARY KEY ("site_id")
);

ALTER TABLE "site_database_dumps" ADD CONSTRAINT "site_database_dumps_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written constraints (Prisma does not see CHECKs): databaseDumpPathSchema of @repo/domain —
-- below the login folder, no `.` or `..` segment, a .sql or .sql.gz file.
ALTER TABLE "site_database_dumps"
  ADD CONSTRAINT "site_database_dumps_path_check" CHECK (
    "path" !~ '^/'
    AND "path" !~ '\\'
    AND "path" !~ '(^|/)\.{1,2}(/|$)'
    AND "path" !~ '//'
    AND "path" !~ '[[:cntrl:]]'
    AND "path" ~* '\.sql(\.gz)?$'
  );

COMMIT;
