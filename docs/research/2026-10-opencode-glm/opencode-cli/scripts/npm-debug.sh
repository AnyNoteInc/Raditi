#!/bin/sh
timeout 40 $OC run --format json --agent raditi --title stand-dbg --print-logs --log-level DEBUG < /probe/prompt-ok.txt > /tmp/dbg.txt 2>&1
echo "debug lines: $(wc -l < /tmp/dbg.txt)"
grep -v -E 'message=(loading|tracking|bootstrapping|fromDirectory|"event connected"|"all LSPs|"all formatters|"shell tool|"project copy|"booting location|"llm runtime|stream|process|loop|created|"stream error"|"disposing)' /tmp/dbg.txt | cut -c1-330 | head -45
