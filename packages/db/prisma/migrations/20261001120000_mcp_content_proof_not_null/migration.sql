-- SQL CHECK accepts UNKNOWN; an unfinished call must never carry a completion proof.
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_content_proof_check";
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_content_proof_check" CHECK (
  "applied_state_hash" IS NULL OR
  ("applied_state_hash" ~ '^[a-f0-9]{64}$' AND "result" IS NOT NULL AND "result" = 'ok' AND "write_started_at" IS NOT NULL)
);
