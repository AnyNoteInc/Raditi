-- The secret of an MCP server of a workspace's agent (docs/plan/83-remove-projects.md, БП11): the
-- kind `mcp_server` again, after 20261116110000_remove_projects left only the platform's kinds. A
-- value added to an enum cannot be used in the transaction that adds it (55P04): this migration
-- holds nothing else; the CHECK that names it is in the next one.
ALTER TYPE "CredentialKind" ADD VALUE IF NOT EXISTS 'mcp_server';
