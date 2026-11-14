-- Dictation in the field of a chat (docs/plan/75-chat-input-output.md, ВВ16–ВВ19): one row per
-- recognition, for its limit per user and hour. The sound is never kept: no column holds it.
CREATE TABLE "speech_calls" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "seconds" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speech_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "speech_calls_user_id_created_at_idx" ON "speech_calls"("user_id", "created_at");
ALTER TABLE "speech_calls" ADD CONSTRAINT "speech_calls_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speech_calls" ADD CONSTRAINT "speech_calls_seconds_check" CHECK (seconds BETWEEN 0 AND 30);
ALTER TABLE "speech_calls" ADD CONSTRAINT "speech_calls_outcome_check"
  CHECK (outcome IN ('recognized', 'empty', 'failed'));
