#!/bin/sh
echo "### debug rg files"; timeout 30 "$OC" debug rg files 2>&1 | head -8
echo "### cache bin"; ls -la "$HOME/.cache/opencode/bin" 2>&1 | tail -n +2
echo "### PATH without rg"; mkdir -p /tmp/nopath; for b in sh bash git node env timeout head ls cat; do ln -sf "$(command -v $b)" /tmp/nopath/$b; done
PATH=/tmp/nopath timeout 40 "$OC" debug rg files 2>&1 | head -4 | cut -c1-300
ls -la "$HOME/.cache/opencode/bin" 2>&1 | tail -n +2
