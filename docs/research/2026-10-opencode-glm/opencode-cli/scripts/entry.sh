#!/bin/sh
# Entry of the CLI container: stages the config the way a driver would, then runs the given command.
export OC=/usr/local/lib/raditi/opencode-cli/node_modules/opencode-linux-arm64/bin/opencode
export HOME=/agent-home/opencode
mkdir -p "$HOME/.config/opencode" /workspace/repo /run/raditi/secrets
chmod 755 "$HOME/.config/opencode"
if [ -n "$OC_CONFIG_FILE" ]; then cp "$OC_CONFIG_FILE" "$HOME/.config/opencode/opencode.json"; fi
if [ -n "$OC_AGENTS_FILE" ]; then cp "$OC_AGENTS_FILE" "$HOME/.config/opencode/AGENTS.md"; fi
if [ -n "$OC_CONFIG_READONLY" ]; then chmod 555 "$HOME/.config/opencode"; fi
cd /workspace/repo
if [ ! -d .git ]; then
  git init -q . && git config user.email stand@example.invalid && git config user.name stand
  printf '# Stand repository\n\nSynthetic content for a CLI probe.\n' > README.md
  git add . && git commit -qm 'init'
fi
exec "$@"
