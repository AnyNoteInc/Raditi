# Per-turn credentials are created once; deleting their metadata is final cleanup.
path "turns/data/*" {
  capabilities = ["create", "read", "delete"]
}

path "turns/metadata/*" {
  capabilities = ["read", "update", "list", "delete"]
  # Runtime may attach recovery metadata, but cannot weaken key-level retention.
  allowed_parameters = {
    "custom_metadata" = []
  }
}

path "turns/metadata" {
  capabilities = ["list"]
}

path "turns/undelete/*" {
  capabilities = ["deny"]
}

path "turns/destroy/*" {
  capabilities = ["deny"]
}

# Variables of a workspace for the agent's commands (docs/plan/83-remove-projects.md, БП4).
path "kv/data/workspaces/+/env/*" {
  capabilities = ["read"]
}
