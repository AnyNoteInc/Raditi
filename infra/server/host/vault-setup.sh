#!/bin/sh
# AppRoles of the single server (infra/server/README.md), run as root after
# infra/vault/bootstrap.mjs, with the root token of /etc/raditi/openbao/root-token. Repeatable:
# it writes the same roles and policy again and never prints a secret.
#   web     sites-writer, workspace-provisioner
#   core    core-turns, core-transit, core-site-import, core-release
#   llm     llm-subscriptions
#   mcp     mcp-content
#   renderer  raditi-renderer: reads kv/platform/*, issues the SecretIDs of the roles above
# The renderer's own RoleID and SecretID go to /etc/raditi/openbao/renderer.json (root, 0400).
set -eu

addr=http://127.0.0.1:8200
token_file=/etc/raditi/openbao/root-token
# The token goes to curl as a header file on tmpfs, never in an argument (ps, /proc/*/cmdline)
header=$(mktemp -p /run)
trap 'rm -f "$header"' EXIT
chmod 0600 "$header"
printf 'X-Vault-Token: %s\n' "$(cat "$token_file")" >"$header"
api() { # <method> <path> [json on stdin]
  if [ $# -eq 3 ]; then
    printf '%s' "$3" | curl -sf -X "$1" -H "@$header" --data-binary @- "$addr/v1/$2"
  else
    curl -sf -X "$1" -H "@$header" "$addr/v1/$2"
  fi
}

api GET sys/auth | jq -e '.data["approle/"]' >/dev/null 2>&1 ||
  api POST sys/auth/approle '{"type":"approle"}' >/dev/null

renderer_policy='
path "kv/data/platform/*" { capabilities = ["read"] }
path "auth/approle/role/+/role-id" { capabilities = ["read"] }
path "auth/approle/role/+/secret-id" { capabilities = ["update"] }
path "auth/approle/role/+/secret-id-accessor/list" { capabilities = ["list"] }
path "auth/approle/role/+/secret-id-accessor/destroy" { capabilities = ["update"] }
'
api PUT sys/policies/acl/raditi-renderer "$(jq -nc --arg p "$renderer_policy" '{policy: $p}')" >/dev/null

role() { # <name> <policies,...> <token ttl>
  api POST "auth/approle/role/$1" "$(jq -nc --arg p "$2" --arg t "$3" '{
    token_policies: ($p | split(",")), token_ttl: $t, token_max_ttl: "24h",
    secret_id_ttl: "0", secret_id_num_uses: 0, token_no_default_policy: false }')" >/dev/null
  echo "vault-setup: role $1 ($2)"
}
role web sites-writer,workspace-provisioner 1h
role core core-turns,core-transit,core-site-import,core-release 1h
role llm llm-subscriptions 1h
role mcp mcp-content 1h
role renderer raditi-renderer 15m

umask 077
if [ ! -s /etc/raditi/openbao/renderer.json ]; then
  role_id=$(api GET auth/approle/role/renderer/role-id | jq -r .data.role_id)
  secret_id=$(api POST auth/approle/role/renderer/secret-id | jq -r .data.secret_id)
  # The SecretID through the environment of jq, not its arguments
  ROLE_ID=$role_id SECRET_ID=$secret_id jq -nc '{role_id: env.ROLE_ID, secret_id: env.SECRET_ID}' \
    >/etc/raditi/openbao/renderer.json
  chmod 0400 /etc/raditi/openbao/renderer.json
  echo "vault-setup: renderer credentials in /etc/raditi/openbao/renderer.json"
fi
