-- The new pricing of 06.11.2026 (docs/plan/63-new-pricing.md, decisions Ц1–Ц6 and Ц15): the
-- tariffs cost less and give fewer credits, and no tariff limits the credits of a day.
-- «Старт» 4 900 ₽ and 300 credits a month → 1 990 ₽ and 150; «Бизнес» 12 900 ₽ and 800 →
-- 6 990 ₽ and 600; «Агентство» 39 900 ₽ and 2 500 → 19 990 ₽ and 2 000; the pack of 100
-- credits 1 990 ₽ → 1 490 ₽. `plans.credits_per_day` becomes NULL on the three tariffs: no daily
-- cap. The sites of a tariff, the credits of the pack, the names and the order stay as they are.
--
-- Data only, and only the plans that still hold every term published before that this file
-- changes — the price, the credits of the month and of the day, or the price and the credits of
-- the pack —, as billing_credit_amounts and billing_daily_credits did: a plan whose term was
-- changed by hand, a plan of another slug or kind and an empty table are left alone, and in a
-- new database the seed creates the plans with the new terms. This is the deliberate migration
-- the seed asks for when a plan term changes (prisma/seed/apply.ts): it runs before the seed,
-- which then finds the terms it carries and changes nothing.
--
-- The plans change in place, so no stop is asked for: there is no production database (Ц15).
-- A subscription of a developer's database on the old terms keeps its plan by id and renews
-- on the new ones — the renewal reads the price and the credits of its plan when it charges,
-- and a notice that named the old amount is outdated and written again before the charge
-- (renewal.ts, `notice_outdated`). Orders keep the amount they were paid with (`orders.amount`),
-- and the journal keeps the credits each grant gave. Credits already granted, set aside or
-- charged are not touched.
--
-- The daily limit stays in the code for a plan that sets one; its checks hold with NULL.

-- One transaction for the changes: a database must never be left with one half of the new
-- terms, however the statements of this file are sent.
BEGIN;

UPDATE "plans"
  SET "price" = 1990.00, "credits_per_month" = 150, "credits_per_day" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota'
    AND "price" = 4900.00 AND "credits_per_month" = 300 AND "credits_per_day" = 50;
UPDATE "plans"
  SET "price" = 6990.00, "credits_per_month" = 600, "credits_per_day" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota'
    AND "price" = 12900.00 AND "credits_per_month" = 800 AND "credits_per_day" = 100;
UPDATE "plans"
  SET "price" = 19990.00, "credits_per_month" = 2000, "credits_per_day" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota'
    AND "price" = 39900.00 AND "credits_per_month" = 2500 AND "credits_per_day" = 300;

UPDATE "plans" SET "price" = 1490.00, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'pack' AND "kind" = 'pack' AND "price" = 1990.00 AND "pack_credits" = 100;

COMMIT;
