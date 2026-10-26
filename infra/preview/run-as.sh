#!/bin/sh
# A command of the platform inside a preview (docs/plan/58-preview-single-container.md, §10):
# `docker exec -u 0:0 <preview> run-as.sh <uid:gid> <seconds> -- <argv…>`. The command runs as
# `uid:gid` with no capability, in a session of its own; when it ends — or its seconds run out —
# every process of that session's group is killed, since there is no throwaway container to take
# them away. stdin, stdout and stderr pass through. The code is the command's, 124 at the limit.
set -eu

ids=${1:-}
seconds=${2:-}
case "$ids" in
  *[!0-9:]* | :* | *: | *:*:* | '') ids= ;;
  *:*) ;;
  *) ids= ;;
esac
[ -n "$ids" ] || { echo 'raditi-preview: run-as.sh <uid:gid> <seconds> -- <argv…>' >&2; exit 64; }
case "$seconds" in
  '' | *[!0-9]*) echo 'raditi-preview: the seconds are not a number' >&2; exit 64 ;;
esac
shift 2
[ "${1:-}" = -- ] && shift
[ "$#" -gt 0 ] || { echo 'raditi-preview: the command is missing' >&2; exit 64; }

# Everything below runs as the command's uid: it kills its own processes, no KILL is needed.
exec setpriv --reuid="${ids%%:*}" --regid="${ids##*:}" --clear-groups \
  --bounding-set=-all --inh-caps=-all --no-new-privs -- /bin/sh -c '
  seconds=$1
  shift
  flag=$(mktemp /tmp/raditi-run-as.XXXXXX)
  # A background command of a script reads /dev/null unless told otherwise: stdin is the caller’s.
  exec 3<&0
  setsid "$@" <&3 3<&- &
  pid=$!
  exec 3<&-
  # The timer in a group of its own, so that its sleep goes with it.
  setsid sh -c "sleep \"\$1\"; : >\"\$2\"; kill -s KILL -- \"-\$3\"" raditi "$seconds" "$flag.out" "$pid" \
    </dev/null &
  timer=$!
  code=0
  wait "$pid" || code=$?
  kill -s KILL -- "-$timer" 2>/dev/null || true
  kill -s KILL -- "-$pid" 2>/dev/null || true
  if [ -e "$flag.out" ]; then code=124; fi
  rm -f "$flag" "$flag.out"
  exit "$code"
' raditi "$seconds" "$@"
