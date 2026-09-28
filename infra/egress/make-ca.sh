#!/bin/sh
# Certificates of the egress proxy (README.md, «Сертификаты»). Run on the owner's machine, never
# on egress-1: the CA keys stay offline with the owner. One root and two intermediates with
# separate extended key usage, so a client certificate never passes as the proxy's and the
# proxy's certificate never passes as a client's. Needs OpenSSL 3.
#
#   make-ca.sh ca <dir>                    root, server CA and client CA with their keys
#   make-ca.sh server <dir> <dns-name>     server/<dns-name>.pem (with the server CA) and key
#   make-ca.sh client <dir> <cn> [days]    clients/<cn>.pem (with the client CA) and key
#
# A leaf is issued again with a new key on every run (renewal); the CA only once.
set -eu

fail() {
  echo "make-ca: $*" >&2
  exit 1
}
usage="usage: make-ca.sh ca <dir> | server <dir> <dns-name> | client <dir> <cn> [days]"
[ $# -ge 2 ] || fail "$usage"
action=$1
dir=$2
shift 2
command -v openssl >/dev/null 2>&1 || fail "openssl is not installed"
matches() { printf '%s' "$1" | grep -Eq "$2"; }

umask 077
ext=$(mktemp)
csr=$(mktemp)
trap 'rm -f "$ext" "$csr"' EXIT

newkey() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }
serial() { echo "0x$(openssl rand -hex 16)"; }
# request <key> <cn>: a CSR in $csr; every extension comes from $ext at signing.
request() { openssl req -new -key "$1" -subj "/CN=$2" -out "$csr"; }
# sign <issuer> <issuer-key> <days> <out>
sign() {
  openssl x509 -req -in "$csr" -CA "$1" -CAkey "$2" -days "$3" -sha256 -set_serial "$(serial)" \
    -extfile "$ext" -out "$4" 2>/dev/null
}
# intermediate <name> <extended key usage>
intermediate() {
  newkey "$dir/$1-key.pem"
  request "$dir/$1-key.pem" "raditi-egress-$1"
  cat >"$ext" <<EOF
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
extendedKeyUsage = $2
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
  sign "$dir/root.pem" "$dir/root-key.pem" 1825 "$dir/$1.pem"
}
# leaf <subdir> <name> <cn> <days> <issuer> <extensions>: the chain file carries the issuer too.
leaf() {
  [ -f "$dir/$5.pem" ] || fail "$dir/$5.pem is missing: run 'make-ca.sh ca $dir' first"
  mkdir -p "$dir/$1"
  newkey "$dir/$1/$2-key.pem"
  request "$dir/$1/$2-key.pem" "$3"
  printf '%s\n' "basicConstraints = critical, CA:false" "keyUsage = critical, digitalSignature" \
    "subjectKeyIdentifier = hash" "authorityKeyIdentifier = keyid:always" "$6" >"$ext"
  sign "$dir/$5.pem" "$dir/$5-key.pem" "$4" "$dir/$1/$2.leaf.pem"
  cat "$dir/$1/$2.leaf.pem" "$dir/$5.pem" >"$dir/$1/$2.pem"
  rm -f "$dir/$1/$2.leaf.pem"
  echo "$dir/$1/$2.pem: $(openssl x509 -in "$dir/$1/$2.pem" -noout -enddate)"
}

case $action in
ca)
  [ $# -eq 0 ] || fail "$usage"
  [ ! -e "$dir/root.pem" ] || fail "$dir/root.pem exists: the CA is issued once"
  mkdir -p "$dir"
  newkey "$dir/root-key.pem"
  request "$dir/root-key.pem" raditi-egress-root
  cat >"$ext" <<EOF
basicConstraints = critical, CA:true, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
  openssl x509 -req -in "$csr" -signkey "$dir/root-key.pem" -days 3650 -sha256 \
    -set_serial "$(serial)" -extfile "$ext" -out "$dir/root.pem" 2>/dev/null
  intermediate server-ca serverAuth
  intermediate client-ca clientAuth
  echo "$dir: root.pem, server-ca.pem, client-ca.pem and their keys; keep the keys offline"
  ;;
server)
  [ $# -eq 1 ] || fail "$usage"
  matches "$1" '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' ||
    fail "the server name must be a lowercase DNS name"
  leaf server "$1" "$1" 397 server-ca \
    "extendedKeyUsage = serverAuth
subjectAltName = DNS:$1"
  ;;
client)
  [ $# -eq 1 ] || [ $# -eq 2 ] || fail "$usage"
  matches "$1" '^[a-z0-9][a-z0-9-]{0,62}$' ||
    fail "the CN must be a short lowercase name without personal data, such as app-1 or op-1"
  days=${2:-397}
  matches "$days" '^[1-9][0-9]{0,3}$' || fail "days must be a number from 1 to 9999"
  leaf clients "$1" "$1" "$days" client-ca "extendedKeyUsage = clientAuth"
  ;;
*) fail "$usage" ;;
esac
