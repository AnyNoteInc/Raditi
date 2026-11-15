# Site access of the content profile: the role reads the WordPress kind and never writes it.
path "kv/data/sites/+/wp" {
  capabilities = ["read"]
}

# The secret of an MCP server of a workspace's agent (docs/plan/81-mcp-server-credentials.md; per
# workspace since plan 83, БП11): the relay reads a header value or the tokens of an OAuth sign-in
# and adds them to the server's request, and writes renewed tokens back by CAS. Never a variable of
# the workspace; web alone creates the key (no `create`), and the version for CAS comes with the read.
path "kv/data/workspaces/+/mcp/*" {
  capabilities = ["read", "update"]
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
