#!/bin/sh
# Prints NAMES only (never values) of credential-like variables a tool command can see.
names() { sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E 'OPENCODE|RADITI|ZHIPU|API_KEY|TOKEN' | sort | tr '\n' ' '; }
echo "own env names: $(env | names)"
p=$PPID
for hop in 1 2 3 4; do
  [ -d /proc/$p ] || break
  if [ -r /proc/$p/environ ]; then echo "environ of pid $p ($(cat /proc/$p/comm)) readable, names: $(tr '\0' '\n' < /proc/$p/environ | names)"; else echo "environ of pid $p ($(cat /proc/$p/comm)) not readable"; fi
  p=$(awk '{print $4}' /proc/$p/stat 2>/dev/null); [ "$p" = "0" ] && break
done
echo "secret files: $(ls /run/raditi/secrets 2>/dev/null | tr '\n' ' ')"
echo "auth.json present: $([ -e "$HOME/.local/share/opencode/auth.json" ] && echo yes || echo no)"
