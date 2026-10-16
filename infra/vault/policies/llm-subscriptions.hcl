# The gateway reads the credentials of its accounts and writes none: a key enters and is
# replaced by the operator command alone.
path "subs/data/*" {
  capabilities = ["read"]
}
