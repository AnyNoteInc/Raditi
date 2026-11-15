-- Sites of pages on a tariff and the own name of a site (docs/plan/73-pages-sites.md, Дер32,
-- Дер36; the owner's answers of 14.11.2026 to В3 and В5): «Старт» — 2 sites, «Бизнес» — 10,
-- «Агентство» — 20; the own name `<name>.pages.raditi.ru` on «Бизнес» and above.
--
-- Added columns and data only, no stop. The code before this release reads none of them. A plan
-- of another slug or kind, and an empty table, are left alone: in a new database the seed creates
-- the plans with these terms. This is the deliberate migration the seed asks for when a plan term
-- changes (prisma/seed/apply.ts): it runs before the seed. A pack has no sites (NULL); no tariff
-- loses a site a workspace has — the limit stops a new site only (Дер36).

BEGIN;

ALTER TABLE "plans"
  ADD COLUMN "page_sites" integer NULL,
  ADD COLUMN "page_custom_names" boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT "plans_page_sites_check" CHECK ("page_sites" IS NULL OR "page_sites" >= 0);

UPDATE "plans" SET "page_sites" = 2, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota';
UPDATE "plans" SET "page_sites" = 10, "page_custom_names" = true, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota';
UPDATE "plans" SET "page_sites" = 20, "page_custom_names" = true, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota';

COMMIT;
