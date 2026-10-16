#!/bin/sh
# One headless turn: run-turn.sh <prompt file> [extra opencode run arguments...]
prompt=$1; shift
timeout -s TERM "${OC_TIMEOUT:-600}" "$OC" run --format json "$@" < "$prompt"
code=$?
echo "cli-exit=$code" >&2
exit $code
