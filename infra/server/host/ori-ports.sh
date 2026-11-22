#!/bin/sh
# /usr/local/lib/raditi/ori-ports.sh, run by raditi-ori-ports.timer (infra/server/README.md, «ОРИ»):
# moves the client's port of each fact of the ORI from the edge's access lines in journald into
# ori_fact_ports before journald forgets them (90 days; plan 88, slice 88.16а-2). Web answers an
# action with a fact by `X-Raditi-Fact: <random key>`, Traefik keeps that header beside ClientPort.
# The cursor moves only after core kept the lines: a failed run reads them again next time, and
# core skips what it already has. The lines (client addresses) live only in a 0700 temporary file.
set -eu

state=${ORI_PORTS_STATE:-/var/lib/raditi/ori-ports}
cursor="$state/cursor"
container=${ORI_EDGE_CONTAINER:-raditi-app-traefik-1}
app=${RADITI_APP_DIR:-/opt/raditi/app}

install -d -m 0700 "$state"
lines=$(mktemp "$state/lines.XXXXXX")
trap 'rm -f "$lines"' EXIT INT TERM

# JSON, not cat: Docker splits a line over 16 KB into parts (CONTAINER_PARTIAL_*), core joins them.
set -- --no-pager --quiet --output=json --show-cursor "CONTAINER_NAME=$container"
if [ -s "$cursor" ]; then set -- "$@" "--after-cursor=$(cat "$cursor")"; fi
journalctl "$@" >"$lines"

next=$(sed -n 's/^-- cursor: //p' "$lines" | tail -n 1)
[ -n "$next" ] || exit 0

if grep -qF -e 'downstream_X-Raditi-Fact' -e 'CONTAINER_PARTIAL' "$lines"; then
  # COMPOSE_FILE in the app's .env names its files relative to the working directory (deploy.sh).
  cd "$app"
  grep -F -e 'downstream_X-Raditi-Fact' -e 'CONTAINER_PARTIAL' "$lines" |
    docker compose exec -T core node --env-file=/run/raditi/app.env scripts/ori-ports.mjs
fi

printf '%s\n' "$next" >"$cursor.new"
mv "$cursor.new" "$cursor"
