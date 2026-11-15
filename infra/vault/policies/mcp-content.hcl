# Site access of the content profile: the role reads the WordPress kind and never writes it.
path "kv/data/sites/+/wp" {
  capabilities = ["read"]
}

# The secret of an MCP server of a site's agent (docs/plan/80-mcp-server-credentials.md): the
# relay reads a header value and adds it to the server's request. Never another kind of a site's
# secret, and no write: web alone writes the key. Renewed tokens of an OAuth sign-in (slice 80.6)
# will need `update` here, granted with it.
path "kv/data/sites/+/mcp/*" {
  capabilities = ["read"]
}

# The application password of a preview's WordPress and the secret path of its browser
# (plan 53, Р21, Р24): core writes both, the role reads them. Never the variables of a site.
path "kv/data/previews/+/wp" {
  capabilities = ["read"]
}

path "kv/data/previews/+/browser" {
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

# The key of the agent's web search (raditi_search_web, spec §20, «Веб-поиск агента»): kept where
# the keys of the model are, put there by the operator command alone. Only this one path of subs/.
path "subs/data/search/yandex" {
  capabilities = ["read"]
}
