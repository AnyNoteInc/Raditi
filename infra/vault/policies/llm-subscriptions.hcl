# The gateway reads the credentials of its accounts and writes none: a key enters and is
# replaced by the operator command alone.
path "subs/data/*" {
  capabilities = ["read"]
}

# The key of the web search lives in subs/ beside the account keys, but it is the mcp role's.
path "subs/data/search/*" {
  capabilities = ["deny"]
}
