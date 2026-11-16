# The tokens of the git connections of a workspace (docs/plan/84-projects.md, ПР10, §4.2): web
# writes them after the sign-in or the form and never reads them back; core reads them for a git
# operation and writes a renewed GitLab token by CAS. It never creates one nor reads metadata.
path "kv/data/workspaces/+/git/*" {
  capabilities = ["read", "update"]
}
