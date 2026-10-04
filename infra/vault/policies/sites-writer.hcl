# A trusted connection step stores site access with CAS and cannot read it back.
path "kv/data/sites/*" {
  capabilities = ["create", "update"]
}

path "kv/metadata/sites/*" {
  capabilities = ["read"]
}
