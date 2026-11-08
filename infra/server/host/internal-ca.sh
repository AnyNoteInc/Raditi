#!/bin/sh
# The internal CA of the single server (infra/server/README.md): it signs the TLS certificates of
# the services on the private address 10.10.0.10 — Vault, S3 and Gitea, all under *.raditi.internal.
# Containers trust it through the file vault-ca.pem of their secret directory (NODE_EXTRA_CA_CERTS).
#   internal-ca.sh init               the CA, once (10 years, EC P-256)
#   internal-ca.sh issue <name> <dir> a leaf for <name>.raditi.internal into <dir>/<name>.{pem,key}
# Run as root. The CA key never leaves /etc/raditi/ca (0700, root).
set -eu

ca_dir=/etc/raditi/ca
ip=10.10.0.10

case "${1:-}" in
init)
  install -d -m 0700 -o root -g root "$ca_dir"
  if [ -s "$ca_dir/ca.pem" ]; then
    echo "internal-ca: $ca_dir/ca.pem exists"
    exit 0
  fi
  umask 077
  openssl ecparam -name prime256v1 -genkey -noout -out "$ca_dir/ca-key.pem"
  openssl req -x509 -new -key "$ca_dir/ca-key.pem" -sha256 -days 3650 \
    -subj '/O=Raditi/CN=Raditi internal CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -out "$ca_dir/ca.pem"
  chmod 0444 "$ca_dir/ca.pem"
  echo "internal-ca: created $ca_dir/ca.pem"
  ;;
issue)
  name=${2:?name}
  out=${3:?directory}
  host="$name.raditi.internal"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  umask 077
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem"
  openssl req -new -key "$tmp/key.pem" -subj "/O=Raditi/CN=$host" -out "$tmp/req.csr"
  printf '%s\n' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=serverAuth' \
    "subjectAltName=DNS:$host,IP:$ip,IP:127.0.0.1" >"$tmp/ext"
  openssl x509 -req -in "$tmp/req.csr" -CA "$ca_dir/ca.pem" -CAkey "$ca_dir/ca-key.pem" \
    -CAcreateserial -days 825 -sha256 -extfile "$tmp/ext" -out "$tmp/cert.pem"
  [ -d "$out" ] || install -d -m 0700 "$out"
  install -m 0444 "$tmp/cert.pem" "$out/$name.pem"
  install -m 0400 "$tmp/key.pem" "$out/$name.key"
  echo "internal-ca: issued $host into $out"
  ;;
*)
  echo "usage: internal-ca.sh init | issue <name> <dir>" >&2
  exit 2
  ;;
esac
