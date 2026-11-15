-- The own name of a site of pages (docs/plan/73-pages-sites.md, Дер32, Дер33; the owner's answer
-- to В3 of 14.11.2026: «свой читаемый slug можно задавать, только на тарифе бизнес и выше»):
-- `https://<name>.pages.raditi.ru/` beside its random slug. Every name ever given is kept in
-- page_tree_names with its site, so a name leads to that site for ever — 308 to its current
-- name — and no other workspace ever gets it: a site that is removed, with its workspace too,
-- leaves its names behind without a site (tree_id NULL), taken for ever. Added table and column
-- only.

BEGIN;

ALTER TABLE "page_trees" ADD COLUMN "name" VARCHAR(25);
ALTER TABLE "page_trees" ADD CONSTRAINT "page_trees_name_check" CHECK (
  "name" IS NULL OR ("name" ~ '^[a-z0-9]([a-z0-9]|-[a-z0-9])*$' AND char_length("name") BETWEEN 3 AND 25)
);
CREATE UNIQUE INDEX "page_trees_name_key" ON "page_trees"("name");

CREATE TABLE "page_tree_names" (
    "name" VARCHAR(25) NOT NULL,
    "tree_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_tree_names_pkey" PRIMARY KEY ("name")
);
CREATE INDEX "page_tree_names_tree_id_idx" ON "page_tree_names"("tree_id");
ALTER TABLE "page_tree_names" ADD CONSTRAINT "page_tree_names_tree_id_fkey" FOREIGN KEY ("tree_id")
  REFERENCES "page_trees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
