#!/bin/sh
# The database dump before a migration (README.md, «Обычная выкладка»). Prisma has no down
# migrations: data a broken migration changed comes back only from this dump. Run as root on the
# VM from /opt/raditi/app after the record for rollback: the dump's path joins that record. The
# dumps hold personal data: root only, the last five and none older than 30 days, like the
# platform's backups (spec §14). Exits 1 without a usable dump; then do not migrate. DUMP_DIR and
# RELEASES_LOG move the paths for the checks.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
dumps=${DUMP_DIR:-/opt/raditi/backups}
log=${RELEASES_LOG:-/opt/raditi/releases.log}
keep=5
days=30
fail() {
  echo "dump-db: $*" >&2
  exit 1
}

revision=$(sed -n 's/^APP_REVISION=//p' "$dir/.env" 2>/dev/null | tail -n 1)
case $revision in
'' | *[!A-Za-z0-9._-]*) fail "APP_REVISION in $dir/.env is missing or not a revision" ;;
esac
[ -f "$log" ] && [ -w "$log" ] || fail "$log is not writable: write the record for rollback first"

umask 077
install -d -m 0700 "$dumps"
file="$dumps/$(date -u +%Y%m%dT%H%M%SZ)-$revision.dump"
cd "$dir"
# The superuser over the socket: it has no password (postgres/init-roles.sh). An archive that
# lists the data of the migrations table is a dump of the platform database.
if ! docker compose exec -T postgres pg_dump -U postgres -Fc raditi >"$file" ||
  ! docker compose exec -T postgres pg_restore -l <"$file" |
  grep -q ' TABLE DATA public _prisma_migrations '; then
  rm -f "$file"
  fail "no usable dump: do not migrate"
fi
echo "dump=$file" >>"$log"

# Only names this script gives: they start with the UTC time, so the glob lists the oldest first.
find "$dumps" -maxdepth 1 -type f -name '[0-9]*Z-*.dump' -mtime +"$days" -exec rm -f -- {} +
set -- "$dumps"/[0-9]*Z-*.dump
while [ "$#" -gt "$keep" ]; do
  rm -f -- "$1"
  shift
done
echo "dump-db: $file"
