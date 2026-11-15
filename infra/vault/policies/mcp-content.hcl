# The secret of an MCP server of a workspace's agent (docs/plan/81-mcp-server-credentials.md; per
# workspace since plan 83, БП11): the relay reads a header value or the tokens of an OAuth sign-in
# and adds them to the server's request, and writes renewed tokens back by CAS. Never a variable of
# the workspace; web alone creates the key (no `create`), and the version for CAS comes with the read.
path "kv/data/workspaces/+/mcp/*" {
  capabilities = ["read", "update"]
}

# Contact maps of chats: written with CAS, read back, removed with every version.
path "kv/data/content-masks/*" {
  capabilities = ["create", "read", "update"]
}

path "kv/metadata/content-masks/*" {
  capabilities = ["delete"]
}

# The key of the agent's web search (raditi_search_web, spec §20, «Веб-поиск агента»): kept where
# the keys of the model are, put there by the operator command alone. Only this one path of subs/.
path "subs/data/search/yandex" {
  capabilities = ["read"]
}
