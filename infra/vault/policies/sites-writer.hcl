# A trusted connection step stores site access with CAS and cannot read it back.
path "kv/data/sites/*" {
  capabilities = ["create", "update"]
}

# The version for CAS. `+/` keeps the rule of a variable below the more specific one.
path "kv/metadata/sites/+/*" {
  capabilities = ["read"]
}

# A variable of a site keeps one version (docs/plan/53-chat-preview-release.md, Р13): web sets
# that on the key before each write, so a replaced or removed value is gone from Vault. Nothing
# else of the metadata — `max_versions` = "1" alone, as a string (a number matches no list).
path "kv/metadata/sites/+/env/*" {
  capabilities = ["create", "update", "read"]
  allowed_parameters = {
    "max_versions" = ["1"]
  }
}
