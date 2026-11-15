-- The client's own instructions to the agent, in every chat (docs/plan/76-agent-instructions.md,
-- И1): «отвечайте коротко», «мы — кофейня у метро». One row per user; none — no instructions.
CREATE TABLE "agent_instructions" (
    "user_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_instructions_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "agent_instructions" ADD CONSTRAINT "agent_instructions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_instructions" ADD CONSTRAINT "agent_instructions_text_check"
  CHECK (char_length(text) BETWEEN 1 AND 2000);
