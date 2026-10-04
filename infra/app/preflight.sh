#!/bin/sh
# Host checks before the app VM stack starts (README.md; ExecStartPre of raditi-app.service).
# Run as root on the VM from /opt/raditi/app. Prints every failed check by name, never a value
# of a secret, and exits 1 if any failed.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
env_file="$dir/.env"
failed=0
fail() {
  echo "preflight: $*" >&2
  failed=1
}
# A value from .env without sourcing it: the file is data, not a script.
setting() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

[ -r "$env_file" ] || {
  echo "preflight: $env_file is missing" >&2
  exit 1
}

# Validate both file and ambient Compose settings before deciding whether llm is enabled.
# Compose treats '*' as every profile; a substring gate must never bypass the llm checks.
# With llm disabled this checks configuration only and does not read any llm secret files.
node "$dir/llm-preflight.mjs" --env-file "$env_file" || exit 1

# 1. Docker 28+ drops direct routing to published container ports from outside the host.
server=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 0)
[ "${server%%.*}" -ge 28 ] 2>/dev/null || fail "Docker server 28 or newer is required"

# 2. The real client address: without userland-proxy core sees a runner VM's own address (its
# token is bound to it) and Traefik the client's; live-restore keeps containers across upgrades.
daemon=/etc/docker/daemon.json
grep -Eq '"userland-proxy"[[:space:]]*:[[:space:]]*false' "$daemon" 2>/dev/null ||
  fail "$daemon must set \"userland-proxy\": false"
! pgrep -x docker-proxy >/dev/null 2>&1 || fail "docker-proxy is running: restart dockerd"
[ "$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)" = true ] ||
  fail "$daemon must set \"live-restore\": true"

# 3. The runner API is published only on this VM's private address.
private_ip=$(setting APP_PRIVATE_IP)
if [ -z "$private_ip" ] ||
  ! ip -o addr show | awk '{ split($4, a, "/"); print a[1] }' | grep -qxF "$private_ip"; then
  fail "APP_PRIVATE_IP is not an address of this VM"
fi

# 4. Secrets: rendered to tmpfs, one directory per service, owned by its uid.
secrets=$(setting SECRETS_DIR)
secrets=${secrets:-/run/raditi}
check_secrets() { # <service> <uid> <file>...
  service=$1 uid=$2
  shift 2
  path="$secrets/$service"
  if [ ! -d "$path" ]; then
    fail "$path is missing"
    return
  fi
  [ "$(stat -f -c %T "$path")" = tmpfs ] || fail "$path is not on tmpfs"
  [ "$(stat -c '%u %a' "$path")" = "$uid 700" ] || fail "$path must be $uid, mode 0700"
  for file in "$@"; do
    [ -s "$path/$file" ] || {
      fail "$path/$file is missing or empty"
      continue
    }
    [ "$(stat -c '%u %a' "$path/$file")" = "$uid 400" ] || fail "$path/$file must be $uid, mode 0400"
  done
}
# vault-ca.pem: web and core verify Vault's internal CA (NODE_EXTRA_CA_CERTS in the compose file).
check_secrets web 10001 app.env vault-ca.pem
check_secrets core 10002 app.env vault-ca.pem
check_secrets migrate 10004 app.env
check_secrets postgres 70 superuser-password password
check_secrets redis 10003 users.acl password

# Optional subscription gateway. Check both sources so a shell override cannot silently select
# a different profile than the file checked here. Node rejects conflicting interpolation values.
if printf '%s\n%s\n' "$(setting COMPOSE_PROFILES)" "${COMPOSE_PROFILES-}" |
  grep -Eq '(^|[,[:space:]])llm([,[:space:]]|$)'; then
  check_secrets llm 10008 app.env egress-client.pem egress-client-key.pem egress-ca.pem vault-ca.pem
  firewall_helper=/usr/local/lib/raditi/llm-firewall.mjs
  cmp -s "$dir/llm-firewall.mjs" "$firewall_helper" ||
    fail "installed llm firewall helper must match this release"
  # The interpreter of the units (systemd/): a newer Node found on PATH proves nothing about it.
  /usr/bin/node "$firewall_helper" check --env-file "$env_file" ||
    fail "llm firewall checks failed (the units run the helper with /usr/bin/node, Node 26)"
  systemctl is-active --quiet raditi-llm-firewall.service || fail "llm firewall service is not active"
  systemctl show docker.service -p After --value 2>/dev/null | grep -qw raditi-llm-firewall.service ||
    fail "docker.service must start after raditi-llm-firewall.service"
  systemctl show docker.service -p Requires --value 2>/dev/null | grep -qw raditi-llm-firewall.service ||
    fail "docker.service must require raditi-llm-firewall.service"
fi

# 5. Compose's .env is not a secret store (RUNNER_TOKENS holds only hashes).
if grep -Eq '^[A-Z0-9_]*(PASSWORD|SECRET|SECRET_ID|TOKEN|_KEY|DATABASE_URL|REDIS_URL)=' "$env_file"; then
  fail "$env_file holds secret-like names: secrets are files in $secrets"
fi

# 6. Stateful volumes are created once by the runbook and survive `down -v`.
prefix=$(setting VOLUME_PREFIX)
for volume in acme pgdata redis; do
  docker volume inspect "${prefix:-raditi-app}-$volume" >/dev/null 2>&1 ||
    fail "volume ${prefix:-raditi-app}-$volume is missing"
done

# 7. Redis' AOF rewrite forks; leases and deadlines count on PostgreSQL's clock.
[ "$(sysctl -n vm.overcommit_memory)" = 1 ] || fail "vm.overcommit_memory must be 1"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] ||
  fail "the clock is not NTP-synchronized"
# At boot dockerd starts the containers itself: only its own ordering holds them until the sync.
systemctl show docker.service -p After --value 2>/dev/null | grep -qw time-sync.target ||
  fail "docker.service must start after time-sync.target"

# 8. No AAAA while the bridges have no IPv6: a client over IPv6 would reach web with the address
# of the bridge gateway instead of its own.
domain=$(setting APP_DOMAIN)
if [ -n "$domain" ] && getent ahostsv6 "$domain" 2>/dev/null | grep -qv '^::ffff:'; then
  fail "$domain has an AAAA record"
fi

# 9. Images by digest only (spec §19): a tag is not a rollback point. env.example's all-zero
# digests are placeholders; core would start with SANDBOX_IMAGE's and fail only at a turn.
for name in WEB_IMAGE ORCHESTRATOR_IMAGE MIGRATE_IMAGE TRAEFIK_IMAGE POSTGRES_IMAGE REDIS_IMAGE SANDBOX_IMAGE; do
  setting "$name" | grep -Eq '@sha256:[0-9a-f]{64}$' || fail "$name must be pinned by digest"
  ! setting "$name" | grep -Eq '@sha256:0{64}$' || fail "$name still has the all-zero placeholder digest"
done

# 10. setting() reads a value as written, while compose strips quotes and a trailing comment.
if grep -Eq "^[A-Z0-9_]+=([\"']|.*[[:space:]]#)" "$env_file"; then
  fail "$env_file: write values without quotes or trailing comments"
fi

# 11. The rollback record and database bootstrap need the revision of this directory.
setting APP_REVISION | grep -Eqx '[0-9a-f]{40}' || fail "APP_REVISION must be a full commit sha"

# 12. The access log holds client addresses: kept 90 days and 10 GB at most, no copy in syslog.
journald=/etc/systemd/journald.conf.d/raditi.conf
for line in '[Journal]' Storage=persistent SystemMaxUse=10G MaxRetentionSec=90day ForwardToSyslog=no; do
  grep -qxF "$line" "$journald" 2>/dev/null || fail "$journald must contain $line"
done

[ "$failed" -eq 0 ] || exit 1
echo "preflight: ok"
