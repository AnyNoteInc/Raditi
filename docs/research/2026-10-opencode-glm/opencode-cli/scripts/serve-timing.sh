#!/bin/sh
node /probe/serve-timing.mjs
echo "--- server log (gaps over 2 s are marked)"
awk -F'[= ]' '{ print }' /tmp/serve.log | cut -c1-230 | head -60
