-- The tokens of a git connection of a workspace (docs/plan/84-projects.md, ПР10, §4.1, §4.2): the
-- kind `git_connection` of a reference to kv/workspaces/<workspace>/git/<connectionId>. A value
-- added to an enum cannot be used in the transaction that adds it (55P04): this migration holds
-- nothing else; the CHECK that names it is in the next one (the precedent of plan 83).
ALTER TYPE "CredentialKind" ADD VALUE IF NOT EXISTS 'git_connection';
