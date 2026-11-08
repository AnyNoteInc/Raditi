#!/bin/sh
# The model in production on the single server: the steps of «Модель в production» of
# infra/app/README.md, run as root from /opt/raditi/app (README.md, «Модель»).
#   model-setup.sh key <lite|pro|max> <paid until YYYY-MM-DD>   the plan key of Z.ai on stdin
#   model-setup.sh enable                                        provider zai-coding, its profiles, rates, accounts
#   model-setup.sh clearance <countries> <notice22 ref> <notice22 date> <notice12 ref> <notice12 date>
#                            <transfer allowed from> <documents>
# The key reaches only `subscriptions:login` on stdin, with a writer token for 15 minutes in a
# tmpfs file; nothing is printed. The clearance (rule 1, spec §18) records the owner's notices to
# Roskomnadzor as given: no value is made up here.
set -eu
cd /opt/raditi/app
addr=http://127.0.0.1:8200
# The root token reaches curl as a header file on tmpfs, never in an argument
vault_post() { # <path> <json>
  header=$(mktemp -p /run)
  chmod 0600 "$header"
  printf 'X-Vault-Token: %s\n' "$(cat /etc/raditi/openbao/root-token)" >"$header"
  printf '%s' "$2" | curl -sf -X POST -H "@$header" --data-binary @- "$addr/v1/$1"
  rm -f "$header"
}
psql_c() { docker compose exec -T postgres psql -U postgres -d raditi -v ON_ERROR_STOP=1 -tA "$@"; }

case "${1:-}" in
key)
  plan=${2:?plan: lite, pro or max}
  paid=${3:?paid until YYYY-MM-DD}
  dir=$(mktemp -d -p /run)
  trap 'rm -rf "$dir"' EXIT
  vault_post auth/token/create \
    '{"policies":["subscriptions-writer"],"ttl":"15m","no_default_policy":true,"renewable":false}' |
    jq -r .auth.client_token >"$dir/token"
  chown 10008:10008 "$dir" "$dir/token"
  chmod 0400 "$dir/token"
  docker compose run --rm --no-deps -T -v "$dir/token:/run/writer-token:ro" \
    -e APP_ENV=production -e VAULT_ADDR=https://vault.raditi.internal:8200 \
    --entrypoint node llm --env-file=/run/raditi/app.env scripts/subscription-login.mjs \
    --backend zai-coding --label production-1 --plan "$plan" --paid-until "$paid" \
    --vault-token-file /run/writer-token
  ;;
enable)
  psql_c <<'EOF'
UPDATE llm_providers SET enabled = true, updated_at = clock_timestamp()
 WHERE slug = 'zai-coding' AND kind = 'subscription';
UPDATE llm_models SET enabled = true, updated_at = clock_timestamp()
 WHERE provider_id = (SELECT id FROM llm_providers WHERE slug = 'zai-coding')
   AND slug IN ('glm-5.3-light', 'glm-5.3-standard', 'glm-5.3-heavy');
EOF
  # Rates and the credit rate: Бизнес and Агентство cost more than half their price at 6.00 (plan 63)
  docker compose run --rm --no-deps -T -v /opt/raditi/app/server/rates:/rates:ro \
    --entrypoint node core --env-file=/run/raditi/app.env scripts/billing-rates.mjs \
    --file /rates/2026-11-06-zai-coding.json --reason "single server, owner 08.11.2026" \
    --operator owner --confirm-exposure
  psql_c -c "UPDATE subscription_accounts SET enabled = true, updated_at = clock_timestamp()
    WHERE provider_id = (SELECT id FROM llm_providers WHERE slug = 'zai-coding') AND status <> 'retired'
    RETURNING id"
  ;;
clearance)
  [ $# -eq 8 ] || { echo "usage: clearance <countries> <notice22 ref> <notice22 date> <notice12 ref> <notice12 date> <transfer allowed from> <documents>" >&2; exit 2; }
  psql_c -v countries="$2" -v n22="$3" -v d22="$4" -v n12="$5" -v d12="$6" -v from="$7" -v docs="$8" <<'EOF'
INSERT INTO cross_border_clearances (provider_id, countries, notice22_ref, notice22_date,
  recipients_assessed_on, notice12_ref, notice12_received_on, transfer_allowed_from, documents, recorded_by)
SELECT id, :'countries', :'n22', :'d22', :'d12', :'n12', :'d12', :'from', :'docs', 'owner'
  FROM llm_providers WHERE slug = 'zai-coding'
RETURNING id;
EOF
  ;;
*)
  echo "usage: model-setup.sh key <plan> <paid until> | enable | clearance …" >&2
  exit 2
  ;;
esac
