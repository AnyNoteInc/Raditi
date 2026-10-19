# Releases of a site and its previews (docs/plan/53-chat-preview-release.md, Р13, Р24, Р29,
# Р35). Read-only: the WordPress access a release writes the content plugin with, the client's
# variables of a site (`kv/sites/<siteId>/env/<NAME>`, written by web and never read back
# there), the token of the Gitea organization owner. The secrets of a preview are core's own.
path "kv/data/sites/+/wp" {
  capabilities = ["read"]
}

path "kv/data/sites/+/env/*" {
  capabilities = ["read"]
}

path "kv/data/platform/gitea-org-owner" {
  capabilities = ["read"]
}

path "kv/data/previews/*" {
  capabilities = ["create", "read", "update", "delete"]
}

# Version for CAS, the leftovers of a destroyed preview, and every version of a removed secret.
# A write-once secret (kvCreateOnce) may attach recovery metadata, never weaken retention.
path "kv/metadata/previews/*" {
  capabilities = ["read", "update", "list", "delete"]
  allowed_parameters = {
    "custom_metadata" = []
  }
}

# The credentials of one release attempt reach its deploy job only as a single-use wrapping:
# core wraps, sees whether it was opened and revokes it by accessor. Nothing here creates a
# token or writes a policy at runtime (Р29).
path "sys/wrapping/wrap" {
  capabilities = ["update"]
}

path "sys/wrapping/lookup" {
  capabilities = ["update"]
}

path "auth/token/revoke-accessor" {
  capabilities = ["update"]
}
