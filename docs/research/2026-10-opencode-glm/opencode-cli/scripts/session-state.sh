#!/bin/sh
# session-state.sh <session id>: what the CLI keeps about a session (the id of run D in the probe).
S=${1:?session id}
D=$HOME/.local/share/opencode
echo "### session list"; $OC session list --format json 2>&1 | head -c 900; echo
echo "### tables"; $OC db "select name from sqlite_master where type='table' order by name" 2>&1 | tr '\n' ' '; echo
echo "### counts"; for t in session message part project; do echo "$t: $($OC db "select count(*) from $t" 2>&1 | tail -1)"; done
echo "### session row"; $OC db --format json "select * from session where id='$S'" 2>&1 | head -c 1200; echo
echo "### pragma"; $OC db "pragma journal_mode" 2>&1 | tail -1; $OC db "pragma wal_checkpoint(TRUNCATE)" 2>&1 | tail -1
ls -la $D | grep opencode.db
echo "### export"; $OC export "$S" > /tmp/export.json 2>/tmp/export.err; echo "exit=$? bytes=$(wc -c < /tmp/export.json)"; head -c 300 /tmp/export.err; head -c 700 /tmp/export.json; echo
node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/export.json","utf8")); console.log("export keys:",Object.keys(j), "info keys:", Object.keys(j.info||{}), "messages:", j.messages?.length, "first message keys:", Object.keys(j.messages?.[0]||{}), "part types:", [...new Set(j.messages.flatMap(m=>m.parts.map(p=>p.type)))])'
cp /tmp/export.json /workspace/export-d.json
