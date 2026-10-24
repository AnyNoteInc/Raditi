# A trusted provisioning step creates the Transit key of a workspace; it cannot read, export,
# delete, rotate, configure, trim or restore one. Transit takes a new key as an update, and only
# the key type may be sent. `+` is the key itself and nothing under it: a deny for the paths under
# a `ws-*` glob cannot work, since OpenBao prefers the rule whose first wildcard comes later and
# reads a `*` inside a path literally. The name (`ws-<uuid>`) is checked by the client; a key of
# another name serves no role, whose policies name `ws-*` keys only.
path "transit/keys/+" {
  capabilities = ["update"]
  allowed_parameters = {
    "type" = ["aes256-gcm96"]
  }
}
