-- The secret of an MCP server of a site's agent — a header value or the tokens of an OAuth sign-in
-- (docs/plan/81-mcp-server-credentials.md): a reference of its own kind. A value added to an enum
-- cannot be used in the transaction that adds it (55P04): this migration holds nothing else. The
-- CHECK that names the value is in the next one.
ALTER TYPE "CredentialKind" ADD VALUE 'mcp_server';
