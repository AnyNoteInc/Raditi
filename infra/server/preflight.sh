#!/bin/sh
# Host checks of the single server before its stack starts (README.md), from /opt/raditi/app.
# The checks of infra/app/preflight.sh that hold for one machine, plus what this layout adds:
# the private address, the host firewall, OpenBao, gVisor. Prints every failed check by name,
# never a secret, and exits 1 if any failed.
set -eu

dir=$(cd "$(dirname "$0")/.." && pwd)
env_file="$dir/.env"
failed=0
fail() {
  echo "preflight: $*" >&2
  failed=1
}
setting() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }

[ -r "$env_file" ] || { echo "preflight: $env_file is missing" >&2; exit 1; }

# Docker: 29+, no userland proxy (core sees the runner's own address), live-restore, gVisor
server=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)
[ "${server%%.*}" -ge 29 ] 2>/dev/null || fail "Docker server 29 or newer is required"
grep -Eq '"userland-proxy"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json 2>/dev/null ||
  fail "/etc/docker/daemon.json must set \"userland-proxy\": false"
[ "$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)" = true ] || fail "live-restore must be on"
docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"' || fail "the runsc runtime is not registered"

# The private address, the host firewall and the host's OpenBao
ip -o addr show raditi0 2>/dev/null | grep -q ' 10\.10\.0\.10/32 ' || fail "10.10.0.10 is not on raditi0"
nft list table inet raditi_host >/dev/null 2>&1 || fail "the host firewall (inet raditi_host) is not loaded"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8200/v1/sys/health)" = 200 ] ||
  fail "OpenBao is not unsealed and active"

# Secrets: rendered to tmpfs, one directory per service, owned by its uid
secrets=$(setting SECRETS_DIR)
secrets=${secrets:-/run/raditi}
check_secrets() { # <service> <uid> <file>...
  path="$secrets/$1" uid=$2
  shift 2
  [ -d "$path" ] || { fail "$path is missing"; return; }
  [ "$(stat -f -c %T "$path")" = tmpfs ] || fail "$path is not on tmpfs"
  [ "$(stat -c '%u %a' "$path")" = "$uid 700" ] || fail "$path must be $uid, mode 0700"
  for file in "$@"; do
    [ -s "$path/$file" ] || { fail "$path/$file is missing or empty"; continue; }
    [ "$(stat -c '%u %a' "$path/$file")" = "$uid 400" ] || fail "$path/$file must be $uid, mode 0400"
  done
}
check_secrets web 10001 app.env vault-ca.pem
check_secrets core 10002 app.env vault-ca.pem
check_secrets migrate 10004 app.env
check_secrets postgres 70 superuser-password password
check_secrets redis 10003 users.acl password
check_secrets llm 10008 app.env vault-ca.pem
check_secrets mcp 10005 app.env vault-ca.pem
check_secrets browser 10006 app.env vault-ca.pem
check_secrets preview 10009 app.env
check_secrets traefik 65532 dashboard-users
check_secrets s3 10007 s3.json s3.pem s3.key
[ -s /etc/raditi/runner/runner-token ] || fail "/etc/raditi/runner/runner-token is missing"
[ -s /etc/raditi/runner/ca.pem ] || fail "/etc/raditi/runner/ca.pem is missing"

# .env is not a secret store (RUNNER_TOKENS holds only hashes)
if grep -Eq '^[A-Z0-9_]*(PASSWORD|SECRET|SECRET_ID|TOKEN|_KEY|DATABASE_URL|REDIS_URL)=' "$env_file"; then
  fail "$env_file holds secret-like names: secrets are files in $secrets"
fi
if grep -Eq "^[A-Z0-9_]+=([\"']|.*[[:space:]]#)" "$env_file"; then
  fail "$env_file: write values without quotes or trailing comments"
fi

prefix=$(setting VOLUME_PREFIX)
for volume in acme pgdata redis s3; do
  docker volume inspect "${prefix:-raditi-app}-$volume" >/dev/null 2>&1 ||
    fail "volume ${prefix:-raditi-app}-$volume is missing"
done

[ "$(sysctl -n vm.overcommit_memory)" = 1 ] || fail "vm.overcommit_memory must be 1"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] || fail "the clock is not NTP-synchronized"
systemctl show docker.service -p After --value 2>/dev/null | grep -qw time-sync.target ||
  fail "docker.service must start after time-sync.target"

domain=$(setting APP_DOMAIN)
if [ -n "$domain" ] && getent ahostsv6 "$domain" 2>/dev/null | grep -qv '^::ffff:'; then
  fail "$domain has an AAAA record"
fi

# Images by digest only, never the all-zero placeholder
for name in WEB_IMAGE CORE_IMAGE LLM_IMAGE PREVIEW_GATEWAY_IMAGE MIGRATE_IMAGE MCP_IMAGE \
  RUNNER_IMAGE BROWSER_WORKER_IMAGE SANDBOX_IMAGE SANDBOX_GATEWAY_IMAGE SANDBOX_NETWORK_GUARD_IMAGE \
  SANDBOX_WATCHDOG_IMAGE BROWSER_EGRESS_IMAGE BROWSER_FORWARDER_IMAGE BROWSER_IMAGE \
  TRAEFIK_IMAGE POSTGRES_IMAGE REDIS_IMAGE SEAWEEDFS_IMAGE; do
  setting "$name" | grep -Eq '@sha256:[0-9a-f]{64}$' || fail "$name must be pinned by digest"
  ! setting "$name" | grep -Eq '@sha256:0{64}$' || fail "$name still has the all-zero placeholder digest"
done
setting APP_REVISION | grep -Eqx '[0-9a-f]{40}' || fail "APP_REVISION must be a full commit sha"

journald=/etc/systemd/journald.conf.d/raditi.conf
for line in '[Journal]' Storage=persistent SystemMaxUse=10G MaxRetentionSec=90day ForwardToSyslog=no; do
  grep -qxF "$line" "$journald" 2>/dev/null || fail "$journald must contain $line"
done

[ "$failed" -eq 0 ] || exit 1
echo "preflight: ok"
