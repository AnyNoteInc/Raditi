-- The message of the work of the agent in Telegram (docs/plan/80-telegram.md): the bot edits one
-- message every few seconds while a pass goes on and deletes it when the answer comes.
ALTER TABLE "chat_sessions"
  ADD COLUMN "telegram_progress_id" INTEGER,
  ADD COLUMN "telegram_progress_chain" UUID;
