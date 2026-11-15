-- Telegram, the second channel of the chat (docs/plan/80-telegram.md). The link of an account by
-- a one-time code, the updates web took, the chat the words without a topic go to, and the switch
-- of the bot's notifications. channel_identities had no rows written by the product before.
ALTER TABLE "channel_identities"
  ADD COLUMN "current_task_id" UUID,
  ADD COLUMN "new_chat" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "new_chat_site_id" UUID;

CREATE UNIQUE INDEX "channel_identities_user_id_channel_key" ON "channel_identities"("user_id", "channel");
CREATE INDEX "channel_identities_current_task_id_idx" ON "channel_identities"("current_task_id");
CREATE INDEX "channel_identities_new_chat_site_id_idx" ON "channel_identities"("new_chat_site_id");

ALTER TABLE "channel_identities"
  ADD CONSTRAINT "channel_identities_current_task_id_fkey" FOREIGN KEY ("current_task_id")
    REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "channel_identities_new_chat_site_id_fkey" FOREIGN KEY ("new_chat_site_id")
    REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notification_settings" ADD COLUMN "telegram" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "telegram_link_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_link_codes_code_hash_key" ON "telegram_link_codes"("code_hash");
CREATE INDEX "telegram_link_codes_user_id_idx" ON "telegram_link_codes"("user_id");

ALTER TABLE "telegram_link_codes"
  ADD CONSTRAINT "telegram_link_codes_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "telegram_updates" (
    "update_id" BIGINT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_updates_pkey" PRIMARY KEY ("update_id")
);

CREATE INDEX "telegram_updates_received_at_idx" ON "telegram_updates"("received_at");
