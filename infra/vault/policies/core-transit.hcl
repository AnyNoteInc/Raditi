# Data keys of turn snapshots under the workspace key; no key management, export or encrypt.
path "transit/datakey/plaintext/ws-*" {
  capabilities = ["update"]
}

path "transit/decrypt/ws-*" {
  capabilities = ["update"]
}
