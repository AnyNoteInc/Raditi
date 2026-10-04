# Site access of the content profile: the role reads the WordPress kind and never writes it.
path "kv/data/sites/+/wp" {
  capabilities = ["read"]
}

# Contact maps of tasks: written with CAS, read back, removed with every version.
path "kv/data/content-masks/*" {
  capabilities = ["create", "read", "update"]
}

path "kv/metadata/content-masks/*" {
  capabilities = ["delete"]
}

# Data keys of content snapshots under the workspace key; the key itself stays out of reach.
path "transit/datakey/plaintext/ws-*" {
  capabilities = ["update"]
}

path "transit/decrypt/ws-*" {
  capabilities = ["update"]
}
