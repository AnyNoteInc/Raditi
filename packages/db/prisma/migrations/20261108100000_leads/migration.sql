-- Leads of the landing (docs/plan/65-landing-platforms-leads.md): a new table, nothing else changes.
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "site" VARCHAR(253) NOT NULL,
    "about" TEXT NOT NULL,
    "consent_version" VARCHAR(32) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "ip_hash" CHAR(64) NOT NULL,
    "telegram_message_id" BIGINT,
    "sent_at" TIMESTAMPTZ(6),
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leads_phone_check" CHECK ("phone" ~ '^\+[0-9]{10,15}$'),
    CONSTRAINT "leads_about_check" CHECK (char_length("about") BETWEEN 10 AND 2000),
    CONSTRAINT "leads_ip_hash_check" CHECK ("ip_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "leads_processed_check" CHECK ("processed_at" IS NULL OR "sent_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "leads_number_key" ON "leads"("number");

CREATE INDEX "leads_ip_hash_created_at_idx" ON "leads"("ip_hash", "created_at");
