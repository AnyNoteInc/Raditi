-- The tariffs of 13.11.2026 (docs/plan/72-pricing-api-margin.md, decisions ЦА1–ЦА5): more
-- credits, priced for a margin of 10 % with every call of the model on the Z.ai API.
-- «Старт» 1 990 ₽ and 150 credits a month → 1 990 ₽ and 200, its week 55 → 73.
-- «Бизнес» 6 990 ₽ and 600 → 9 990 ₽ and 1 000, its week 210 → 350. «Агентство», the pack, the
-- sites of a tariff, the names and the order stay as they are. It runs after weekly_limits_only:
-- no tariff has a window of 5 hours, and this file gives none.
--
-- Data only, and only the plans that still hold every term this file changes — the price, the
-- credits of the month and of the week — and no window of 5 hours, as billing_pricing_2026_11
-- did: a plan changed by hand, a plan of another slug or kind and an empty table are left alone,
-- and in a new database the seed creates the plans with the new terms. This is the deliberate
-- migration the seed asks for when a plan term changes (prisma/seed/apply.ts): it runs before
-- the seed.
--
-- No stop: a subscription keeps its plan by id and renews on the new terms — the renewal reads
-- the price and the credits of its plan when it charges, and a notice that named the old amount
-- is outdated and written again before the charge (renewal.ts, `notice_outdated`). Orders keep
-- the amount they were paid with, the journal keeps what each grant gave (ЦА6, the owner's
-- decision of 13.11.2026).

BEGIN;

UPDATE "plans"
  SET "credits_per_month" = 200, "credits_per_week" = 73, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota' AND "price" = 1990.00
    AND "credits_per_month" = 150 AND "credits_per_5h" IS NULL AND "credits_per_week" = 55;
UPDATE "plans"
  SET "price" = 9990.00, "credits_per_month" = 1000, "credits_per_week" = 350,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota' AND "price" = 6990.00
    AND "credits_per_month" = 600 AND "credits_per_5h" IS NULL AND "credits_per_week" = 210;

COMMIT;
