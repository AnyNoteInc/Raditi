#!/bin/sh
# The functional check inside the browser image of the platform (infra/preview/Dockerfile, target
# `browser`, is built on this image): no network, the limits of a browser session container
# (packages/sandbox-providers/src/browser-session/kit.ts: 1 CPU, 1536 MiB, shm 256 MiB), read-only
# root, uid 10001. Run from the work dir after `pnpm install` and one host run (assets/ exists).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/out/docker-check"
docker run --rm --name spike88-s3-check \
  --network none --cpus=1 --memory=1536m --memory-swap=1536m --shm-size=256m --pids-limit=512 \
  --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m,mode=1777 \
  --cap-drop=ALL --security-opt=no-new-privileges --user 10001:10001 \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$here:/spike:ro" -v "$here/out/docker-check:/out:rw" -w /spike \
  mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  node /spike/check.mjs --out /out --buffers "$@"
