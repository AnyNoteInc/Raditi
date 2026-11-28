-- The key of a VK community of a workspace (docs/plan/99-vk-community.md, §4): the kind
-- `vk_community` of a reference to kv/workspaces/<workspace>/vk/<communityId>. A value added to an
-- enum cannot be used in the transaction that adds it (55P04): this migration holds nothing else;
-- the CHECK that names it is in the next one (the precedent of plan 84).
ALTER TYPE "CredentialKind" ADD VALUE IF NOT EXISTS 'vk_community';
