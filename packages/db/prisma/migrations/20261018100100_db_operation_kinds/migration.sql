-- The rows of the new kinds of a database plan (docs/plan/53-chat-preview-release.md, «Операции
-- БД и миграции»), and the description of a plan a candidate keeps for the client. No row is
-- changed: every row of the journal is a `content_update` of a record, which the new checks take
-- as the old ones did, and a candidate recorded before has no description.
--
-- A row of `preview_db_operations` keeps both sides of every kind: an absent record or table is
-- a state too, sealed like any other, so the sides stay NOT NULL.
--
-- One transaction: Prisma sends a migration file in one request, and a constraint dropped here
-- must never be left without the one that replaces it.
BEGIN;

ALTER TABLE "preview_db_operations"
  DROP CONSTRAINT "preview_db_operations_object_check",
  -- The reference of the object by its kind (`db-objects.ts`): a setting `option:<name>`, a table
  -- of the platform `table:<name>`, a record `<type>:<id>` of no reserved type — and a record a
  -- plan created (ten digits, from 1 000 000 000) for a creation and its trash.
  ADD CONSTRAINT "preview_db_operations_object_check" CHECK (
    "turn_no" >= 1
    AND "before_hash" ~ '^[0-9a-f]{64}$' AND "after_hash" ~ '^[0-9a-f]{64}$'
    AND CASE "kind"
      WHEN 'option_update' THEN "object_ref" ~ '^option:[a-z][a-z0-9_]{0,63}$'
      WHEN 'schema_migration' THEN "object_ref" ~ '^table:[a-z][a-z0-9_]{0,29}$'
      WHEN 'post_create' THEN "object_ref" ~ '^[a-z][a-z_]{0,31}:[1-9][0-9]{9}$'
        AND split_part("object_ref", ':', 1) NOT IN ('option', 'table')
      WHEN 'post_trash' THEN "object_ref" ~ '^[a-z][a-z_]{0,31}:[1-9][0-9]{9}$'
        AND split_part("object_ref", ':', 1) NOT IN ('option', 'table')
      ELSE "object_ref" ~ '^[a-z][a-z_]{0,31}:[1-9][0-9]{0,18}$'
        AND split_part("object_ref", ':', 1) NOT IN ('option', 'table')
    END
  ),
  DROP CONSTRAINT "preview_db_operations_fields_check",
  -- The fields of each kind in their one order (`dbKindFields`; for `content_update`
  -- orderDbContentFields, as before).
  ADD CONSTRAINT "preview_db_operations_fields_check" CHECK (
    CASE "kind"
      WHEN 'content_update' THEN "fields" IN (
        '{title}'::text[], '{content}'::text[], '{excerpt}'::text[],
        '{title,content}'::text[], '{title,excerpt}'::text[], '{content,excerpt}'::text[],
        '{title,content,excerpt}'::text[]
      )
      WHEN 'option_update' THEN "fields" = '{value}'::text[]
      WHEN 'post_create' THEN "fields" = '{title,content,excerpt}'::text[]
      WHEN 'post_trash' THEN "fields" = '{}'::text[]
      WHEN 'schema_migration' THEN "fields" = '{definition}'::text[]
      ELSE false
    END
  );

-- Objects of a preview whose seed differs from production: records and now the settings of the
-- list too. Tables are not compared: a release checks their precondition itself.
ALTER TABLE "preview_seed_mismatches"
  DROP CONSTRAINT "preview_seed_mismatches_object_check",
  ADD CONSTRAINT "preview_seed_mismatches_object_check" CHECK (
    ("object_ref" ~ '^[a-z][a-z_]{0,31}:[1-9][0-9]{0,18}$'
      AND split_part("object_ref", ':', 1) NOT IN ('option', 'table'))
    OR "object_ref" ~ '^option:[a-z][a-z0-9_]{0,63}$'
  );

-- What the client reads of the plan before `/release` (`dbPlanViewSchema`): built by core with
-- the revision and kept with it, never changed after; a superseded revision drops it. The rule
-- «a plan that is not empty has a description» is the code's (recordCandidate, the readiness of
-- a release): candidates recorded before have none.
ALTER TABLE "task_candidates"
  ADD COLUMN "db_view" JSONB,
  ADD COLUMN "db_view_sha256" CHAR(64),
  ADD CONSTRAINT "task_candidates_db_view_check" CHECK (
    ("db_view" IS NULL) = ("db_view_sha256" IS NULL)
    AND ("db_view" IS NULL OR (
      jsonb_typeof("db_view") = 'object' AND octet_length("db_view"::text) <= 524288
      AND "db_view_sha256" ~ '^[0-9a-f]{64}$'
    ))
  );

COMMIT;
