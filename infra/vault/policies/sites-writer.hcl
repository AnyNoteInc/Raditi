# A trusted connection step stores site access with CAS and cannot read it back.
path "kv/data/sites/*" {
  capabilities = ["create", "update"]
}

# The version for CAS, and one thing of the metadata of a key of a site: that it keeps one
# version. A variable of a site keeps one version (docs/plan/53-chat-preview-release.md, Р13), and
# «Удалить проект» (25.10.2026) overwrites each access and variable with a version without a value
# that alone is kept, so a replaced or removed value is gone from Vault. Nothing else of the
# metadata — `max_versions` = "1" alone, as a string (a number matches no list).
path "kv/metadata/sites/+/*" {
  capabilities = ["create", "update", "read"]
  allowed_parameters = {
    "max_versions" = ["1"]
  }
}
