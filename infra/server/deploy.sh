#!/bin/sh
# A release on the single server (README.md, «Выкладка»): the steps of «Обычная выкладка» of
# infra/app/README.md for one machine. GitHub Actions (.github/workflows/deploy.yml) copies the
# tag's infra/app and infra/server with its images.env to /opt/raditi/incoming/<tag>/ and runs
#   /opt/raditi/incoming/<tag>/server/deploy.sh <tag> <registry user>
# as root, with a registry token on stdin (read once, only for the pull, never stored).
set -eu

tag=${1:?tag}
registry_user=${2:?registry user}
case $tag in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "deploy: $tag is not a release tag" >&2; exit 2 ;; esac
src=/opt/raditi/incoming/$tag
app=/opt/raditi/app
log=/opt/raditi/releases.log
images="$src/images.env"
[ -s "$images" ] || { echo "deploy: $images is missing" >&2; exit 1; }

exec 9>/run/raditi-deploy.lock
flock -n 9 || { echo "deploy: another deploy is running" >&2; exit 1; }
say() { echo "deploy $tag: $*"; }
# From the app directory: COMPOSE_FILE in .env names its files relative to the working directory
compose() { (cd "$app" && docker compose "$@"); }

# 0. The record for rollback: what runs now, before any file or digest changes
[ -f "$log" ] || install -m 0640 -g docker /dev/null "$log"
if [ -f "$app/.env" ]; then
  {
    date -Is
    echo "TAG=$(cat "$app/.tag" 2>/dev/null || echo none)"
    grep -E '^(APP_REVISION|[A-Z_]+_IMAGE)=' "$app/.env"
  } >>"$log"
fi

# 0b. The dump before anything changes: dump-db.sh names it by the running APP_REVISION
if compose ps --status running --services 2>/dev/null | grep -qx postgres &&
  compose exec -T postgres psql -U postgres -d raditi -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null | grep -qx t; then
  (cd "$app" && ./dump-db.sh)
fi

# Until the migrations the running release stays whole: a failure puts its files and .env back,
# so a later `docker compose up` by anyone never starts an unchecked release.
prev=/opt/raditi/app.prev
rm -rf "$prev"
[ -d "$app" ] && cp -a "$app" "$prev"
restore() {
  status=$?
  if [ "$status" -ne 0 ] && [ -d "$prev" ]; then
    rsync -a --delete "$prev/" "$app/"
    echo "deploy $tag: failed before the migrations, files and .env of the running release restored" >&2
  fi
  rm -rf "${config:-}"
}
trap restore EXIT

# 1. Files of the tag: infra/app at the root, infra/server under server/; .env stays
install -d -m 0755 "$app"
rsync -a --delete --exclude /.env --exclude /.tag --exclude /server "$src/app/" "$app/"
rsync -a --delete "$src/server/" "$app/server/"
[ -f "$app/.env" ] || { echo "deploy: $app/.env is missing: first deploy is manual (README.md)" >&2; exit 1; }

# 2. Digests of the release and its revision into .env (only these lines change)
revision=$(sed -n 's/^# Raditi v[0-9.]* (\([0-9a-f]\{40\}\))$/\1/p' "$images")
[ -n "$revision" ] || { echo "deploy: $images names no revision" >&2; exit 1; }
put() { # <name> <value>
  if grep -q "^$1=" "$app/.env"; then
    sed -i "s|^$1=.*|$1=$2|" "$app/.env"
  else
    echo "$1=$2" >>"$app/.env"
  fi
}
grep -E '^[A-Z_]+_IMAGE=' "$images" | while IFS='=' read -r name value; do put "$name" "$value"; done
put APP_REVISION "$revision"
say "revision $revision"

# 3. Pull with a throwaway registry login: the token never lands in /root/.docker
config=$(mktemp -d -p /run)
DOCKER_CONFIG=$config docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
# --profile would replace COMPOSE_PROFILES of .env (llm): the ops jobs join it instead
profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$app/.env" | tail -n 1),ops"
COMPOSE_PROFILES=$profiles DOCKER_CONFIG=$config compose pull --quiet
rm -rf "$config"

"$app/server/preflight.sh"

# 5. Data services, buckets, migrations, seeds; from the migrations on there is no way back by files
compose up -d --wait postgres redis s3
COMPOSE_PROFILES=$profiles compose run --rm s3-buckets >/dev/null
trap 'rm -rf "${config:-}"' EXIT
rm -rf "$prev"
COMPOSE_PROFILES=$profiles compose run --rm migrate
COMPOSE_PROFILES=$profiles compose run --rm seed || say "seed failed: web and core keep running (infra/app/README.md, step 7)"

# 6. Everything else
compose up -d --wait --remove-orphans
echo "$tag" >"$app/.tag"
say "running"

# 7. Images of the platform registry no longer named by .env or by the last record of the log
keep=$( (grep -E '^[A-Z_]+_IMAGE=' "$app/.env"; tail -n 40 "$log" | grep -E '^[A-Z_]+_IMAGE=') |
  sed 's/^[A-Z_]*=//' | sed 's/.*@//' | sort -u)
docker image ls --digests --format '{{.Repository}} {{.Digest}} {{.ID}}' |
  grep '^ghcr.io/' | while read -r _ digest id; do
    echo "$keep" | grep -qx "$digest" || docker image rm "$id" >/dev/null 2>&1 || true
  done
rm -rf "$src"
say "done"
