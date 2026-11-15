# Variables of a workspace for the agent's commands (docs/plan/83-remove-projects.md, БП4):
# written by web and never read back there, read here only.
path "kv/data/workspaces/+/env/*" {
  capabilities = ["read"]
}
