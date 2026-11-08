#!/bin/sh
# The host of the single server (infra/server/README.md, «Хост»), Ubuntu 22.04, as root from a
# copy of infra/server/host. Repeatable: every step checks what is already there. Order matters:
# the private address and the firewall exist before Docker and OpenBao; OpenBao is unsealed and
# renders the secrets before Docker starts the containers.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lib=/usr/local/lib/raditi
export DEBIAN_FRONTEND=noninteractive

# Packages: gVisor (runsc) from its apt repository, Node 26 is already /usr/bin/node
apt-get -qq update
apt-get -qq -y install jq git curl ca-certificates gnupg openssl rsync nftables chrony \
  unattended-upgrades apache2-utils >/dev/null
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main' \
    >/etc/apt/sources.list.d/gvisor.list
  apt-get -qq update && apt-get -qq -y install runsc >/dev/null
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 26 ? 0 : 1)' ||
  { echo "install: /usr/bin/node must be Node 26 or newer" >&2; exit 1; }
# Docker 29 and Node 26 come with the VM image (docker-ce and nodesource repositories)
command -v docker >/dev/null || { echo "install: Docker is not installed (docker-ce 29 or newer)" >&2; exit 1; }
# raditi-host.nft names eth0 and lets only SSH on 2222 reach the host: refuse a host where
# that would cut the session or close nothing
ip link show eth0 >/dev/null 2>&1 || { echo "install: no eth0: fix raditi-host.nft first" >&2; exit 1; }
ss -ltn | grep -q ':2222 ' || { echo "install: sshd does not listen on 2222: fix raditi-host.nft first" >&2; exit 1; }

# Docker: no userland proxy, live-restore, journald, runsc; wait for the clock; keep every log line
daemon_before=$(cat /etc/docker/daemon.json 2>/dev/null || true)
cat >/etc/docker/daemon.json <<'EOF'
{
  "userland-proxy": false,
  "live-restore": true,
  "log-driver": "journald",
  "runtimes": { "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--platform=systrap"] } }
}
EOF
install -d /etc/systemd/system/docker.service.d /etc/systemd/journald.conf.d
printf '[Unit]\nWants=time-sync.target\nAfter=time-sync.target\n' >/etc/systemd/system/docker.service.d/time-sync.conf
printf '[Service]\nLogRateLimitIntervalSec=0\n' >/etc/systemd/system/docker.service.d/journal.conf
printf '[Journal]\nStorage=persistent\nSystemMaxUse=10G\nMaxRetentionSec=90day\nForwardToSyslog=no\n' \
  >/etc/systemd/journald.conf.d/raditi.conf
echo 'vm.overcommit_memory = 1' >/etc/sysctl.d/90-raditi.conf
sysctl -q -p /etc/sysctl.d/90-raditi.conf
echo br_netfilter >/etc/modules-load.d/raditi.conf

# Units and helpers
install -d -m 0755 "$lib" /etc/raditi
install -d -m 0700 /etc/raditi/openbao /etc/raditi/runner
install -m 0755 "$here/internal-ca.sh" "$here/openbao-unseal.sh" "$here/vault-setup.sh" \
  "$here/platform-secrets.mjs" "$lib/"
for unit in raditi-net chrony-wait raditi-host-firewall openbao-unseal raditi-secrets; do
  install -m 0644 "$here/$unit.service" /etc/systemd/system/
done
install -m 0644 "$here/raditi-host.nft" /etc/raditi/raditi-host.nft
nft -c -f /etc/raditi/raditi-host.nft

# OpenBao on the host, its TLS from the internal CA
if ! command -v bao >/dev/null; then
  v=2.7.2
  base=https://github.com/openbao/openbao/releases/download/v$v
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/openbao_${v}_linux_amd64.deb" "$base/openbao_${v}_linux_amd64.deb"
  curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
  (cd "$tmp" && grep " openbao_${v}_linux_amd64.deb$" checksums.txt | sha256sum -c -)
  apt-get -qq -y install "$tmp/openbao_${v}_linux_amd64.deb" >/dev/null
  rm -rf "$tmp"
fi
"$lib/internal-ca.sh" init
install -d -m 0750 -o root -g openbao /etc/openbao/tls
[ -s /etc/openbao/tls/vault.pem ] || "$lib/internal-ca.sh" issue vault /etc/openbao/tls
chown openbao /etc/openbao/tls/vault.key
install -m 0640 -o openbao -g openbao "$here/openbao.hcl" /etc/openbao/openbao.hcl
install -d -m 0700 -o openbao -g openbao /var/lib/openbao/data
install -d /etc/systemd/system/openbao.service.d
printf '[Unit]\nAfter=raditi-net.service\nRequires=raditi-net.service\n' \
  >/etc/systemd/system/openbao.service.d/raditi.conf
install -d -m 0700 /etc/raditi/tls
[ -s /etc/raditi/tls/s3.pem ] || "$lib/internal-ca.sh" issue s3 /etc/raditi/tls
# The runner sees only /etc/raditi/runner: its token and the public CA of S3
install -m 0444 /etc/raditi/ca/ca.pem /etc/raditi/runner/ca.pem

systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable -q --now raditi-net.service raditi-host-firewall.service chrony-wait.service openbao.service
systemctl enable -q openbao-unseal.service raditi-secrets.service
# dockerd reads daemon.json only at start; live-restore keeps running containers
[ "$daemon_before" = "$(cat /etc/docker/daemon.json)" ] || systemctl restart docker
echo "install: host ready; next: initialize OpenBao once (README.md, «Vault»)"
