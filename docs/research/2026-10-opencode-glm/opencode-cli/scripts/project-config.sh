#!/bin/sh
show() { echo "### $1"; shift; rm -f /tmp/opencode-planted-plugin-ran; env "$@" $OC debug config 2>&1 | grep -E '"username"|planted|PLANTED|instructions|"plugin"|Error' | head -12; echo "agents: $(env "$@" $OC agent list 2>/dev/null | grep -E '^[a-z]' | tr '\n' ' ')"; echo "skills: $(env "$@" $OC debug skill 2>/dev/null | grep -o '"name": *"[^"]*"' | tr '\n' ' ')"; echo "plugin ran: $([ -e /tmp/opencode-planted-plugin-ran ] && echo yes || echo no)"; }
show "no flags" X=1
show "OPENCODE_DISABLE_PROJECT_CONFIG=1" OPENCODE_DISABLE_PROJECT_CONFIG=1
show "OPENCODE_PURE=1" OPENCODE_PURE=1
show "both + OPENCODE_DISABLE_EXTERNAL_SKILLS + DISABLE_CLAUDE_CODE" OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_PURE=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1 OPENCODE_DISABLE_CLAUDE_CODE=1
