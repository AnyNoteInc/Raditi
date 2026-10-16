#!/bin/sh
# Host side: one CLI run in a throwaway container on the internal network.
#   oc-run.sh <scenario> <config-file-name|-> [proxy scenario query] -- <command inside the container...>
# Environment for the container is taken from OC_ENV (space separated NAME=VALUE; dummy values only).
# PROBE_OUT (absolute, outside the repository) receives runs/<scenario>/ and holds oc-proxy.port, written by
# scripts/oc-proxy.mjs. DOCKER_HOST and DOCKER_CONFIG come from the caller. The network raditi-glm-net, the
# sink container raditi-glm-sink and the image raditi-glm-opencode:1.18.34 (image/) must exist.
set -u
: "${PROBE_OUT:?set PROBE_OUT to a directory outside the repository}"
HERE=$(cd "$(dirname "$0")" && pwd)
scenario=$1; config=$2; query=${3:-}; shift 3; [ "$1" = "--" ] && shift
out=$PROBE_OUT/runs/$scenario; mkdir -p "$out"
port=$(cat "$PROBE_OUT/oc-proxy.port")
curl -sS -m 5 "http://127.0.0.1:$port/__scenario/$scenario?$query" > "$out/scenario.json"; echo >> "$out/scenario.json"
sinkmark=$(docker logs raditi-glm-sink 2>&1 | wc -l | tr -d ' ')
envflags=""
for pair in ${OC_ENV:-}; do envflags="$envflags -e $pair"; done
[ "$config" != "-" ] && envflags="$envflags -e OC_CONFIG_FILE=/cfg/$config"
started=$(date +%s)
docker run --rm --name "raditi-glm-oc-$scenario" --network raditi-glm-net \
  -v "$HERE/scripts/resolv.conf":/etc/resolv.conf:ro \
  --read-only --tmpfs /tmp:rw,size=512m --tmpfs /run/raditi:rw,uid=10001,gid=10001,mode=0700,size=1m \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory 4g --cpus 2 \
  -v ${OC_HOME_VOLUME:-raditi-glm-home}:/agent-home -v ${OC_WORK_VOLUME:-raditi-glm-work}:/workspace \
  -v "$HERE/scripts":/probe:ro -v "$HERE/configs":/cfg:ro \
  -e NO_COLOR=1 -e RADITI_LLM_KEY=raditi-glm-dummy-llm-token-000000000000 -e RADITI_MCP_TOKEN=raditi-glm-dummy-mcp-token-000000000000 \
  $envflags --entrypoint /probe/entry.sh raditi-glm-opencode:1.18.34 "$@" > "$out/stdout.txt" 2> "$out/stderr.txt" < /dev/null
code=$?
echo "exit=$code seconds=$(( $(date +%s) - started ))" > "$out/exit.txt"
docker logs raditi-glm-sink 2>&1 | tail -n +$((sinkmark + 1)) > "$out/sink.jsonl"
docker run --rm --name "raditi-glm-ls-$scenario" --network none -v ${OC_HOME_VOLUME:-raditi-glm-home}:/agent-home:ro -v ${OC_WORK_VOLUME:-raditi-glm-work}:/workspace:ro --entrypoint sh raditi-glm-opencode:1.18.34 -c 'cd /agent-home && find . -type f -not -path "*/snapshot/*" -not -path "./.npm/*" -printf "%10s  %p\n" | sort -k2; echo "--- snapshot objects: $(find . -path "*/snapshot/*" -type f | wc -l) files, $(du -sk ./opencode/.local/share/opencode/snapshot 2>/dev/null | cut -f1) KiB"; echo "--- workspace"; cd /workspace && find . -type f -not -path "./repo/.git/*" -printf "%10s  %p\n" | sort -k2' > "$out/files.txt" 2>&1
cat "$out/exit.txt"; echo "stdout lines: $(wc -l < "$out/stdout.txt") stderr lines: $(wc -l < "$out/stderr.txt") sink lines: $(wc -l < "$out/sink.jsonl")"
