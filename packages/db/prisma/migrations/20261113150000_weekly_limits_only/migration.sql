-- Only the weekly limits stay (owner's answer of 13.11.2026: «давай оставим только недельные лимиты
-- и все, уберем 5-и часовые»; docs/plan/71-usage-limits.md). The window of 5 hours of a workspace is
-- switched off by NULL, as the code reads it; the code and the column stay, the week is as it was.
-- Data only and in place: the three tariffs that still hold the windows of 20, 70 and 200.
BEGIN;

UPDATE "plans" SET "credits_per_5h" = NULL, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota' AND "credits_per_5h" = 20;
UPDATE "plans" SET "credits_per_5h" = NULL, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota' AND "credits_per_5h" = 70;
UPDATE "plans" SET "credits_per_5h" = NULL, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota' AND "credits_per_5h" = 200;

COMMIT;
