-- What subscriptions through ЮKassa need from the database (docs/plan/37-billing-plan.md,
-- «Модель данных»; spec §16, §17): whole numbers on both edit accounts, one live subscription
-- per workspace, the day its periods are counted from, a scheduled plan change, the saved
-- payment method's display fields, and what the payment history shows about an order.
--
-- The schema only widens: every new column is NULL in existing rows except period_anchor,
-- which is filled from current_period_start. No code has written a billing row yet. Were there
-- a subscription whose period does not end after its start, two live subscriptions of one
-- workspace or two pending subscription orders of one workspace, the migration stops and
-- changes nothing.
--
-- One transaction: Prisma sends a migration statement by statement, and a constraint dropped
-- here must never be left without the one that replaces it.
BEGIN;

-- Purchased edits are counted in whole edits, like the edits of the tariff. Roubles keep kopecks.
ALTER TABLE "billing_accounts"
  DROP CONSTRAINT "billing_accounts_edit_whole_check",
  ADD CONSTRAINT "billing_accounts_edit_whole_check"
    CHECK ("unit" NOT IN ('edit', 'edit_pack') OR ("balance" = trunc("balance") AND "held" = trunc("held")));

ALTER TABLE "credit_holds"
  DROP CONSTRAINT "credit_holds_edit_whole_check",
  ADD CONSTRAINT "credit_holds_edit_whole_check"
    CHECK ("unit" NOT IN ('edit', 'edit_pack') OR "amount" = trunc("amount"));

ALTER TABLE "credit_ledger"
  DROP CONSTRAINT "credit_ledger_edit_whole_check",
  ADD CONSTRAINT "credit_ledger_edit_whole_check"
    CHECK ("unit" NOT IN ('edit', 'edit_pack') OR (
      "amount" = trunc("amount") AND "balance_after" = trunc("balance_after")
    ));

-- Subscriptions: the anchor of the periods, the plan of the next period, the overdue and
-- renewal-notice marks, how the saved payment method is shown and the one being bound.
ALTER TABLE "subscriptions"
  ADD COLUMN "period_anchor" TIMESTAMPTZ(6),
  ADD COLUMN "next_plan_id" UUID,
  ADD COLUMN "past_due_since" TIMESTAMPTZ(6),
  ADD COLUMN "renewal_notice_period_end" TIMESTAMPTZ(6),
  ADD COLUMN "payment_method_type" VARCHAR(32),
  ADD COLUMN "payment_method_card_type" VARCHAR(32),
  ADD COLUMN "payment_method_last4" VARCHAR(4),
  ADD COLUMN "pending_payment_method_id" VARCHAR(64);

UPDATE "subscriptions" SET "period_anchor" = "current_period_start";

ALTER TABLE "subscriptions"
  ALTER COLUMN "period_anchor" SET NOT NULL,
  ADD CONSTRAINT "subscriptions_period_check" CHECK ("current_period_end" > "current_period_start");

CREATE INDEX "subscriptions_next_plan_id_idx" ON "subscriptions"("next_plan_id");
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_next_plan_id_fkey"
  FOREIGN KEY ("next_plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One live subscription per workspace; ended ones (cancelled, expired) stay as history.
CREATE UNIQUE INDEX "subscriptions_workspace_live_key" ON "subscriptions"("workspace_id")
  WHERE "status" IN ('trial', 'active', 'past_due');

-- Orders: the period a subscription order pays for, why a payment failed and its refund.
-- A CHECK passes on UNKNOWN, so every comparison of a nullable column stands next to its
-- IS NULL or IS NOT NULL.
ALTER TABLE "orders"
  ADD COLUMN "period_start" TIMESTAMPTZ(6),
  ADD COLUMN "period_end" TIMESTAMPTZ(6),
  ADD COLUMN "failure_reason" VARCHAR(64),
  ADD COLUMN "yookassa_refund_id" VARCHAR(64),
  ADD COLUMN "refunded_amount" DECIMAL(12,2),
  ADD CONSTRAINT "orders_period_check" CHECK (
    ("period_start" IS NULL AND "period_end" IS NULL)
    OR ("period_start" IS NOT NULL AND "period_end" IS NOT NULL AND "period_end" > "period_start")
  ),
  ADD CONSTRAINT "orders_refunded_amount_check" CHECK (
    "refunded_amount" IS NULL OR ("refunded_amount" > 0 AND "refunded_amount" <= "amount")
  );

-- A refund is recorded once: the same ЮKassa refund never lands on two orders.
CREATE UNIQUE INDEX "orders_yookassa_refund_id_key" ON "orders"("yookassa_refund_id");

-- One unfinished subscription order per workspace: a second checkout returns its payment link.
CREATE UNIQUE INDEX "orders_workspace_pending_subscription_key" ON "orders"("workspace_id")
  WHERE "kind" = 'subscription' AND "status" = 'pending';

COMMIT;
