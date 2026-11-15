# Variables of a workspace (docs/plan/83-remove-projects.md, БП4): written by web, never read
# back; a removed one is overwritten by a version without a value.
path "kv/data/workspaces/+/env/*" {
  capabilities = ["create", "update"]
}

path "kv/metadata/workspaces/+/env/*" {
  capabilities = ["create", "update", "read"]
  allowed_parameters = {
    "max_versions" = ["1"]
  }
}

# The secrets of the MCP servers of a workspace's agent (docs/plan/81-mcp-server-credentials.md;
# plan 83, БП11): written by web after it checked the server, never read back; a removed server's
# key is overwritten by a version without a value.
path "kv/data/workspaces/+/mcp/*" {
  capabilities = ["create", "update"]
}

path "kv/metadata/workspaces/+/mcp/*" {
  capabilities = ["create", "update", "read"]
  allowed_parameters = {
    "max_versions" = ["1"]
  }
}
