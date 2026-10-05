#!/bin/sh
OC=/usr/local/lib/raditi/opencode-cli/node_modules/opencode-linux-arm64/bin/opencode
mkdir -p "$HOME" /workspace/repo; cd /workspace/repo
run() { echo; echo "### $*"; s=$(date +%s); timeout 60 "$@" 2>&1 | head -${LINES_MAX:-60}; echo "(took $(( $(date +%s) - s ))s)"; }
run $OC debug paths
run $OC debug info
LINES_MAX=120 run $OC debug config
run $OC providers list
LINES_MAX=40 run $OC models
run $OC models zai-coding-plan
run $OC models zai
run $OC agent list
run $OC mcp list
run $OC session list
run $OC db path
echo "### files"; find /agent-home /tmp /workspace -mindepth 1 2>/dev/null | head -80
echo "### log tail"; for f in $HOME/.local/share/opencode/log/*; do echo "== $f"; tail -40 "$f" | cut -c1-400; done
