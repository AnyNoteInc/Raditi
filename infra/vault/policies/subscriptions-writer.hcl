# Import can create or replace credentials, but cannot read them back.
path "subs/data/*" {
  capabilities = ["create", "update"]
}

path "subs/metadata/*" {
  capabilities = ["read"]
}
