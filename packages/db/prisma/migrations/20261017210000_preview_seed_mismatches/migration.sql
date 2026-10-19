-- Objects of a preview that are not editable (docs/plan/53-chat-preview-release.md, Р15, Р24):
-- after the seed, core compares the state of every copied object with production, and an
-- object whose hashes differ is written here. The mcp role refuses a content write into it, so
-- a release never replays a change made over a state production does not hold. core replaces
-- the rows of a preview in the transaction that records its seed.
CREATE TABLE "preview_seed_mismatches" (
    "preview_id" UUID NOT NULL,
    "object_ref" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_seed_mismatches_pkey" PRIMARY KEY ("preview_id", "object_ref"),
    -- The notation of preview_db_operations.object_ref: <type>:<id>.
    CONSTRAINT "preview_seed_mismatches_object_check"
      CHECK ("object_ref" ~ '^[a-z][a-z_]{0,31}:[1-9][0-9]{0,18}$')
);

ALTER TABLE "preview_seed_mismatches" ADD CONSTRAINT "preview_seed_mismatches_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "preview_environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
