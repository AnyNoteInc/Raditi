-- Both per-turn credentials are admitted together and share expiry and revocation.
-- Old keys remain usable for LLM recovery, but have no MCP access.
ALTER TABLE "llm_keys" ADD COLUMN "mcp_token_hash" VARCHAR(64);
ALTER TABLE "llm_keys" ADD CONSTRAINT "llm_keys_mcp_hash_check"
  CHECK ("mcp_token_hash" IS NULL OR "mcp_token_hash" ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX "llm_keys_mcp_token_hash_key" ON "llm_keys"("mcp_token_hash");
