#!/bin/sh
# The init of a preview in one container (docs/plan/58-preview-single-container.md, §10): MariaDB,
# the web server of the recipe and the entry forwarder, each under its own uid with no capability,
# then a watch with no capability either. tini is PID 1: it reaps the services, and when this
# script ends the container ends with every process in it.
#
# Started as 0:0 with SETUID, SETGID and SETPCAP only (no DAC_OVERRIDE, no KILL): the files of a
# service are read as that service. Inputs — the environment RADITI_HTTP_HOST, RADITI_WEB_PORT,
# RADITI_DATABASE and RADITI_DNS_SERVERS, the web server's argv as the arguments, and the files the
# runtime writes into the tmpfs after the start: the settings (as 33) and the passwords of the
# database (as 999).
# Nothing here prints a password or passes one in an argument or an environment variable.
set -eu
umask 077

SETTINGS=/run/raditi/preview/settings.json
SECRETS=/run/raditi/db
READY=/run/raditi/ready
DATA=/var/lib/mysql
SOCKET=/run/mysqld/mysqld.sock
# The database's own temporary files: not the /tmp of PHP, which could fill it or take names.
DATABASE_TMP=/run/mysqld/tmp
TOOLS=/usr/local/lib/raditi
WEB=33:33
DATABASE=999:999
FORWARDER=10001:10001

# A process as `uid:gid`, with no capability it could keep or regain.
as() {
  ids=$1
  shift
  setpriv --reuid="${ids%%:*}" --regid="${ids##*:}" --clear-groups \
    --bounding-set=-all --inh-caps=-all --no-new-privs -- "$@"
}

fail() {
  echo "raditi-preview: $1" >&2
  exit "${2:-1}"
}

# A dotted IPv4 literal, each part 0–255 without a leading zero.
ipv4() {
  (
    case "$1" in '' | *[!0-9.]* | .* | *. | *..*) exit 1 ;; esac
    IFS=.
    set -f
    # shellcheck disable=SC2086
    set -- $1
    [ "$#" -eq 4 ] || exit 1
    for part in "$@"; do
      case "$part" in 0) ;; 0*) exit 1 ;; esac
      [ "${#part}" -le 3 ] && [ "$part" -le 255 ] || exit 1
    done
  )
}

# Up to 120 s for a file the runtime writes after the start, tested as the uid that owns it.
wait_file() {
  i=0
  until as "$1" test -f "$2"; do
    i=$((i + 1))
    [ "$i" -le 600 ] || fail "$2 was not written" 70
    sleep 0.2
  done
}

# A service in the background, handed to tini (the subshell ends at once), its pid in READY:
# setpriv itself, which becomes the service — no shell stays between them with this script's
# capabilities.
start() {
  name=$1
  ids=$2
  shift 2
  (
    setpriv --reuid="${ids%%:*}" --regid="${ids##*:}" --clear-groups \
      --bounding-set=-all --inh-caps=-all --no-new-privs -- "$@" </dev/null &
    echo $! >"$READY/$name.pid"
  )
}

pids() {
  for name in "$@"; do cat "$READY/$name.pid"; done
}

# --- the watch: no capability, uid 0 only to reach the database's socket as its root -------

if [ "${1:-}" = --watch ]; then
  shift
  stopping=
  trap 'stopping=1' TERM INT
  while :; do
    for pid in "$@"; do
      if [ ! -d "/proc/$pid" ]; then
        [ -n "$stopping" ] && exit 0
        fail 'a service of the preview ended'
      fi
    done
    if [ -n "$stopping" ]; then
      # The database shuts down cleanly; the web server and the forwarder end with the container.
      if [ -S "$SOCKET" ]; then
        mariadb --no-defaults --socket="$SOCKET" --user=root --connect-timeout=2 \
          --execute=SHUTDOWN >/dev/null 2>&1 || true
        i=0
        while [ "$i" -lt 80 ] && [ -f "$READY/db.pid" ] && [ -d "/proc/$(cat "$READY/db.pid")" ]; do
          i=$((i + 1))
          sleep 0.1
        done
      fi
      exit 0
    fi
    sleep 1
  done
fi

# --- start -----------------------------------------------------------------------------------

# The servers of names. Docker gives the container `nameserver 127.0.0.11`, its embedded DNS,
# which gVisor's network stack never reaches, and a read-only root file system keeps
# /etc/resolv.conf as it is under both runtimes (measured 26.10.2026). So the forwarder of names
# (dns.mjs, 10001) listens at 127.0.0.11:53 inside the container — the runtime sets the sysctl
# net.ipv4.ip_unprivileged_port_start=0 for it — and asks the servers of RADITI_DNS_SERVERS. It
# starts before anything that resolves a name; under runc Docker's DNAT answers there first.
case "${RADITI_DNS_SERVERS:-}" in
  '' | *[!0-9.,]*) fail 'RADITI_DNS_SERVERS holds something other than IPv4 addresses' 70 ;;
esac
count=0
for server in $(printf '%s' "$RADITI_DNS_SERVERS" | tr ',' ' '); do
  ipv4 "$server" || fail 'RADITI_DNS_SERVERS holds something other than IPv4 addresses' 70
  count=$((count + 1))
done
[ "$count" -ge 1 ] && [ "$count" -le 3 ] || fail 'RADITI_DNS_SERVERS needs one to three addresses' 70

case "${RADITI_HTTP_HOST:-}" in
  '' | *[!a-z0-9.-]*) fail 'RADITI_HTTP_HOST is not a hostname' 64 ;;
esac
case "${RADITI_WEB_PORT:-}" in
  '' | *[!0-9]*) fail 'RADITI_WEB_PORT is not a port' 64 ;;
esac
case "${RADITI_DATABASE:-}" in
  0 | 1) ;;
  *) fail 'RADITI_DATABASE is neither 0 nor 1' 64 ;;
esac
[ "$#" -gt 0 ] || fail 'the command of the web server is missing' 64
rm -f "$READY"/*

start dns "$FORWARDER" /usr/local/bin/node "$TOOLS/dns.mjs" "$RADITI_DNS_SERVERS"
i=0
until as "$FORWARDER" test -f /run/raditi-forward/dns.ready; do
  i=$((i + 1))
  [ "$i" -le 150 ] || fail 'the forwarder of names did not start'
  [ -d "/proc/$(pids dns)" ] || fail 'the forwarder of names ended at its start'
  sleep 0.2
done
services=dns
if [ "$RADITI_DATABASE" = 1 ]; then
  as "$DATABASE" mkdir -p -m 0700 "$DATABASE_TMP"
  wait_file "$DATABASE" "$SECRETS/user"
  wait_file "$DATABASE" "$SECRETS/root"
  # A data folder without the mark of a finished first start is the leftover of one that died:
  # nothing in it is the client's yet, so it is made again.
  if ! as "$DATABASE" test -f "$DATA/.raditi-ready"; then
    as "$DATABASE" find "$DATA" -mindepth 1 -delete
    as "$DATABASE" mariadb-install-db --no-defaults --basedir=/usr --datadir="$DATA" \
      --tmpdir="$DATABASE_TMP" --auth-root-authentication-method=socket --skip-test-db \
      --skip-name-resolve >/dev/null ||
      fail 'the data folder of the database was not made'
    # The first start makes the preview's user and protects root by a password; the file is read
    # by the server only and goes once the server answers. The passwords are checked against the
    # form the runtime makes (previewDatabasePasswordSchema) before they are written into SQL.
    as "$DATABASE" sh -c '
      set -eu
      umask 077
      user=$(cat "$1/user")
      root=$(cat "$1/root")
      for value in "$user" "$root"; do
        case "$value" in *[!A-Za-z0-9_-]*) exit 71 ;; esac
        [ "${#value}" -ge 24 ] && [ "${#value}" -le 128 ] || exit 71
      done
      cat >"$1/init.sql" <<SQL
CREATE DATABASE IF NOT EXISTS \`preview\`;
CREATE USER IF NOT EXISTS '\''preview'\''@'\''127.0.0.1'\'' IDENTIFIED BY '\''$user'\'';
CREATE USER IF NOT EXISTS '\''preview'\''@'\''localhost'\'' IDENTIFIED BY '\''$user'\'';
GRANT ALL PRIVILEGES ON \`preview\`.* TO '\''preview'\''@'\''127.0.0.1'\'', '\''preview'\''@'\''localhost'\'';
ALTER USER '\''root'\''@'\''localhost'\'' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD('\''$root'\'');
FLUSH PRIVILEGES;
SQL
    ' raditi "$SECRETS" || fail 'the passwords of the database are not of the expected form' 71
    init="--init-file=$SECRETS/init.sql"
  else
    init=
  fi
  # Loopback only; native AIO off: gVisor has no io_uring, and a preview needs no speed.
  start db "$DATABASE" mariadbd --no-defaults --datadir="$DATA" --socket="$SOCKET" \
    --pid-file=/run/mysqld/mysqld.pid --tmpdir="$DATABASE_TMP" --bind-address=127.0.0.1 --port=3306 \
    --skip-name-resolve --max-allowed-packet=64M --innodb-use-native-aio=0 \
    --character-set-server=utf8mb4 ${init:+"$init"}
  # Root of the database is the root of this container on the socket (unix_socket), and no one
  # else: the first start leaves it so, with a password besides.
  i=0
  until mariadb --no-defaults --socket="$SOCKET" --user=root --connect-timeout=2 \
    --execute='SELECT 1' >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 600 ] || fail 'the database did not start'
    [ -d "/proc/$(pids db)" ] || fail 'the database ended at its start'
    sleep 0.2
  done
  if [ -n "$init" ]; then
    as "$DATABASE" rm -f "$SECRETS/init.sql"
    as "$DATABASE" touch "$DATA/.raditi-ready"
  fi
  : >"$READY/db"
  services="$services db"
fi

# The web server once its settings are there (the runtime writes its configuration first). Its
# output goes through a pipe of its own uid: Apache opens its logs again by path
# (/proc/self/fd/2), which the container's own stdio — root's — would refuse it.
wait_file "$WEB" "$SETTINGS"
start web "$WEB" /bin/sh -c '"$@" 2>&1 | cat' raditi "$@"
# The entry: the preview's own address alone (421 for any other Host), to PHP on the loopback.
start forward "$FORWARDER" /usr/local/bin/node "$TOOLS/forward.mjs" \
  "--http-host=$RADITI_HTTP_HOST" "0.0.0.0:8080=127.0.0.1:$RADITI_WEB_PORT"
services="$services web forward"

# shellcheck disable=SC2046,SC2086
exec setpriv --bounding-set=-all --inh-caps=-all --no-new-privs -- /bin/sh "$0" --watch \
  $(pids $services)
