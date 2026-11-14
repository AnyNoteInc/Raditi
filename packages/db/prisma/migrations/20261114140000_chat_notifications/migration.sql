-- Notifications of a chat that waits for its client (docs/plan/75-chat-input-output.md, ВВ6–ВВ11):
-- the client's choice of channels, the browsers that take Web Push, where the client looks now,
-- and what was sent. New tables only.

-- «Уведомления» of the settings: Web Push off until the client turns it on in a browser, letters
-- on (ВВ10). A user without a row has the defaults.
CREATE TABLE "notification_settings" (
    "user_id" UUID NOT NULL,
    "push" BOOLEAN NOT NULL DEFAULT false,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A browser of the user that takes Web Push (ВВ8): its endpoint and the keys of RFC 8291 the
-- browser gave. The payload names only a notification of `chat_notifications`.
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_endpoint_check"
  CHECK (endpoint LIKE 'https://%' AND char_length(endpoint) <= 2048);

-- The client looks at the chat (ВВ7): the feed marks it as it reads, at most every 30 seconds.
CREATE TABLE "task_presence" (
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_presence_pkey" PRIMARY KEY ("user_id", "task_id")
);
ALTER TABLE "task_presence" ADD CONSTRAINT "task_presence_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_presence" ADD CONSTRAINT "task_presence_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What was sent of a chat (ВВ8, ВВ9): the service worker reads its words by the id the push
-- carried, and a letter goes at most once in 30 minutes per chat.
CREATE TABLE "chat_notifications" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "emailed" BOOLEAN NOT NULL DEFAULT false,
    "pushed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_notifications_task_id_user_id_created_at_idx"
  ON "chat_notifications"("task_id", "user_id", "created_at");
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_notifications" ADD CONSTRAINT "chat_notifications_kind_check"
  CHECK (kind IN ('answered', 'question', 'ready', 'failed', 'limit'));
