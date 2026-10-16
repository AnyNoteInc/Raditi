#!/bin/sh
OC=/usr/local/lib/raditi/opencode-cli/node_modules/opencode-linux-arm64/bin/opencode
mkdir -p "$HOME"; cd /tmp
echo "### --version"; $OC --version; echo "exit=$?"
for c in "run" "serve" "export" "import" "session" "session list" "session delete" "mcp" "mcp add" "mcp list" "providers" "providers login" "providers list" "models" "agent" "agent create" "agent list" "debug" "debug config" "debug paths" "debug skill" "debug agent" "upgrade" "stats" "plugin" "db" "acp" "attach" "github" "web" "uninstall"; do
  echo; echo "### $c --help"; $OC $c --help 2>&1; echo "exit=$?"
done
echo "### files"; find /agent-home /tmp -mindepth 1 2>/dev/null | head -80
