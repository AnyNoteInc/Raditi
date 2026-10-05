# A trusted provisioning step creates the Transit key of a workspace; it cannot read, export
# or delete one. Transit takes a new key as an update, and the glob also covers the paths under
# a key: only the key type may be sent, so its configuration cannot be changed here.
path "transit/keys/ws-*" {
  capabilities = ["update"]
  allowed_parameters = {
    "type" = ["aes256-gcm96"]
  }
}
