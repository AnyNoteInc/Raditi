-- More sites of pages on a tariff (the owner's request of 16.11.2026): «Старт» 2 → 20,
-- «Бизнес» 10 → 100, «Агентство» 20 → 200. The own name, the prices, the credits and the order
-- stay as they are.
--
-- Data only, no stop, and only the plans that still hold the number of plans_page_sites: a plan
-- changed by hand, a plan of another slug or kind and an empty table are left alone, and in a new
-- database the seed creates the plans with the new numbers. This is the deliberate migration the
-- seed asks for when a plan term changes (prisma/seed/apply.ts): it runs before the seed. The
-- limit stops a new site only (Дер36), so a larger number takes nothing from a workspace.

BEGIN;

UPDATE "plans" SET "page_sites" = 20, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota' AND "page_sites" = 2;
UPDATE "plans" SET "page_sites" = 100, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota' AND "page_sites" = 10;
UPDATE "plans" SET "page_sites" = 200, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota' AND "page_sites" = 20;

COMMIT;
