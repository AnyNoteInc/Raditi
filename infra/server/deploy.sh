#!/bin/sh
# A release on the single server (README.md, «Выкладка»): the steps of «Обычная выкладка» of
# infra/app/README.md for one machine. GitHub Actions (.github/workflows/deploy.yml) copies the
# tag's infra/app and infra/server with its images.env to /opt/raditi/incoming/<tag>/ and runs
#   /opt/raditi/incoming/<tag>/server/deploy.sh <tag> <registry user>
# as root, with a registry token on stdin (read first into a tmpfs file, removed after the pull).
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
# The registry token first, before any command can read stdin (docker compose exec does), into a
# tmpfs file the pull reads; the rest of the script gets no stdin
token=$(mktemp -p /run)
chmod 0600 "$token"
cat >"$token"
exec </dev/null
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
  rm -rf "${config:-}" "$token"
}
trap restore EXIT

# 1. Files of the tag: infra/app at the root, infra/server under server/; .env stays
install -d -m 0755 "$app"
rsync -a --delete --exclude /.env --exclude /.tag --exclude /server "$src/app/" "$app/"
rsync -a --delete "$src/server/" "$app/server/"
# The routes of the single server next to raditi.yml in the directory Traefik watches
install -m 0644 "$app/server/traefik/server.yml" "$app/traefik/dynamic/server.yml"
[ -f "$app/.env" ] || { echo "deploy: $app/.env is missing: first deploy is manual (README.md)" >&2; exit 1; }
# The host's helpers of this release (the secret renderer reads what the compose files need);
# the units stay as install.sh put them
for helper in platform-secrets.mjs telegram-proxy.mjs; do
  if ! cmp -s "$app/server/host/$helper" "/usr/local/lib/raditi/$helper"; then
    install -m 0755 "$app/server/host/$helper" "/usr/local/lib/raditi/$helper"
    say "host helper $helper updated"
    [ "$helper" != telegram-proxy.mjs ] || systemctl restart raditi-telegram-proxy.service
  fi
done

# A variable the release added to env.example joins .env with its default (step 1 of «Обычная
# выкладка»); a value already there is never changed
grep -E '^[A-Z_]+=' "$app/server/env.example" | while IFS= read -r line; do
  grep -q "^${line%%=*}=" "$app/.env" || { echo "$line" >>"$app/.env"; say "new setting ${line%%=*}"; }
done

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
grep -E '^([A-Z_]+_IMAGE|PREVIEW_SITE_IMAGES)=' "$images" | while IFS='=' read -r name value; do put "$name" "$value"; done
put APP_REVISION "$revision"
say "revision $revision"

# The deploy runner: label `deploy` on this release's core image, over what it registered with
core_image=$(sed -n 's/^CORE_IMAGE=//p' "$app/.env" | tail -n 1)
install -d -m 0755 "$app/server/runner"
sed "s|@CORE_IMAGE@|$core_image|" "$app/server/runner.yaml.in" >"$app/server/runner/runner.yaml"

# 3. Pull with a throwaway registry login: the token never lands in /root/.docker
config=$(mktemp -d -p /run)
DOCKER_CONFIG=$config docker login ghcr.io --username "$registry_user" --password-stdin <"$token" >/dev/null
rm -f "$token"
# --profile would replace COMPOSE_PROFILES of .env (llm): the ops jobs join it instead
profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$app/.env" | tail -n 1),ops"
COMPOSE_PROFILES=$profiles DOCKER_CONFIG=$config compose pull --quiet
rm -rf "$config"

"$app/server/preflight.sh"

# 5. Data services, buckets, migrations, seeds; from the migrations on there is no way back by files
compose up -d --wait postgres redis s3
# The internal CA for the deploy jobs (runner.yaml.in: options and valid_volumes)
docker volume create raditi-ci-ca >/dev/null
docker run --rm --network none -v raditi-ci-ca:/ca -v /etc/raditi/ca/ca.pem:/src.pem:ro \
  --entrypoint cp "$(sed -n 's/^REDIS_IMAGE=//p' "$app/.env" | tail -n 1)" /src.pem /ca/ca.pem
COMPOSE_PROFILES=$profiles compose run --rm s3-buckets >/dev/null
trap 'rm -rf "${config:-}" "$token"' EXIT
rm -rf "$prev"
COMPOSE_PROFILES=$profiles compose run --rm migrate
COMPOSE_PROFILES=$profiles compose run --rm seed || say "seed failed: web and core keep running (infra/app/README.md, step 7)"

# 6. Everything else; the runner reads its labels only at start
compose up -d --wait --remove-orphans
compose restart gitea-runner >/dev/null

# 7. platform/ci of this tag, the required source of the scoped workflows of every site
NODE_EXTRA_CA_CERTS=/etc/raditi/ca/ca.pem /usr/bin/node "$app/server/gitea-setup.mjs" ci "$src/ci"
echo "$tag" >"$app/.tag"
say "running"

# 8. Images of the platform registry no longer named by .env or by the last record of the log
# Every digest .env names (PREVIEW_SITE_IMAGES names eight) and the recent records of the log do
keep=$( (grep -E '^[A-Z_]+=' "$app/.env"; tail -n 60 "$log") | grep -ohE 'sha256:[0-9a-f]{64}' | sort -u)
docker image ls --digests --format '{{.Repository}} {{.Digest}} {{.ID}}' |
  grep '^ghcr.io/' | while read -r _ digest id; do
    echo "$keep" | grep -qx "$digest" || docker image rm "$id" >/dev/null 2>&1 || true
  done
rm -rf "$src"
say "done"
