-- The numbers of the credits model (docs/plan/37-billing-plan.md, «Числа»; spec §17): a tariff
-- gives ten times the credits it gave — 300, 800 and 2 500 a month — and the pack holds 100.
-- The slug of the pack no longer carries a number: 'pack'. Prices, the tasks a day and the
-- sites of a tariff stay as they are.
--
-- Data only, and only the plans that still hold the terms published before: a plan whose term
-- was changed by hand, a plan of another slug and an empty table are left alone — in a new
-- database the seed creates the plans with the new numbers. This is the deliberate migration
-- the seed asks for when a plan term changes (prisma/seed/apply.ts): it runs before the seed,
-- which then finds the terms it carries and changes nothing.
--
-- Plan terms are all that is multiplied. Where credits were already granted, set aside or
-- charged — a developer's database with test purchases; no production database exists — the
-- balances and the journal would stay in the old scale under plans of the new one. The
-- migration stops there and changes nothing: such a database is recreated, not multiplied.
-- A wallet in roubles (unit 'rub') is not counted in credits and does not stop it.
--
-- The stop stands before BEGIN on purpose. `prisma migrate deploy` sends this file as one
-- query: a statement that fails inside the file's own transaction leaves the session in an
-- aborted transaction block, Prisma then cannot record the failure and prints «current
-- transaction is aborted» in place of the reason. Raised before BEGIN, the exception ends the
-- query with nothing open, and its message is what the operator reads. When the file is sent
-- as one query the check and the changes are still one transaction: BEGIN turns the implicit
-- transaction of the query into an explicit one.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "billing_accounts" WHERE "unit" IN ('credit_tariff', 'credit_pack')) THEN
    RAISE EXCEPTION 'billing_accounts holds credit accounts: plan terms are multiplied by ten, balances are not; recreate this database';
  END IF;
  IF EXISTS (SELECT 1 FROM "credit_holds" WHERE "unit" IN ('credit_tariff', 'credit_pack')) THEN
    RAISE EXCEPTION 'credit_holds holds reserves of credits: plan terms are multiplied by ten, reserves are not; recreate this database';
  END IF;
  IF EXISTS (SELECT 1 FROM "credit_ledger" WHERE "unit" IN ('credit_tariff', 'credit_pack')) THEN
    RAISE EXCEPTION 'credit_ledger holds entries in credits: plan terms are multiplied by ten, the journal is not; recreate this database';
  END IF;
END $$;

-- One transaction for the changes: a database must never be left with one half of the numbers,
-- however the statements of this file are sent.
BEGIN;

UPDATE "plans" SET "credits_per_month" = 300, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'start' AND "kind" = 'quota' AND "credits_per_month" = 30;
UPDATE "plans" SET "credits_per_month" = 800, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'business' AND "kind" = 'quota' AND "credits_per_month" = 80;
UPDATE "plans" SET "credits_per_month" = 2500, "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'agency' AND "kind" = 'quota' AND "credits_per_month" = 250;

-- The name says what the pack holds, so it changes with the number; an order keeps its plan by
-- id, not by slug.
UPDATE "plans"
  SET "slug" = 'pack', "name" = 'Пакет из 100 кредитов', "pack_credits" = 100,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "slug" = 'pack-10' AND "kind" = 'pack' AND "pack_credits" = 10;

COMMIT;
