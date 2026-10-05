# Retirement can permanently remove all versions without reading credentials.
path "subs/metadata/*" {
  capabilities = ["delete"]
}

path "subs/destroy/*" {
  capabilities = ["update"]
}
