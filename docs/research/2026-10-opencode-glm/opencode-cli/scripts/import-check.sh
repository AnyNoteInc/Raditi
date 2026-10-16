#!/bin/sh
# import-check.sh <session id>: import of the export made by session-state.sh, then a resume of that session.
S=${1:?session id}
echo "### import"; "$OC" import /workspace/export-d.json 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -5; echo "import exit=$?"
echo "### sessions"; "$OC" session list --format json 2>&1 | grep -E '"id"|"title"' | head -4
echo "### resume"; timeout 30 "$OC" run --format json --agent raditi --session "$S" < /probe/prompt-ok.txt 2>&1 | cut -c1-160
