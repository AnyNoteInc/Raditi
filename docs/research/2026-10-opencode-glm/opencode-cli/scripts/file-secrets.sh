#!/bin/sh
# Secrets as files the CLI reads through {file:…}. Mode "plain": ordinary files. Mode "fifo": named pipes that
# deliver each value exactly once, so a second read of the config (or a later `cat` by a tool) would block.
mode=$1; shift
cd /run/raditi/secrets
if [ "$mode" = fifo ]; then
  mkfifo llm mcp
  (printf %s "$RADITI_LLM_KEY" > llm) &
  (printf %s "$RADITI_MCP_TOKEN" > mcp) &
else
  printf %s "$RADITI_LLM_KEY" > llm; printf %s "$RADITI_MCP_TOKEN" > mcp
fi
cd /workspace/repo
# The CLI itself starts without the two variables in its environment.
env -u RADITI_LLM_KEY -u RADITI_MCP_TOKEN timeout -s TERM 40 "$OC" run --format json --agent raditi --title stand-file < /probe/prompt-ok.txt
code=$?
echo "cli-exit=$code; secrets dir now: $(ls -l /run/raditi/secrets | tail -n +2 | awk '{print $1, $NF}' | tr '\n' ';')" >&2
