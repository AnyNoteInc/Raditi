# WordPress stack runtime. Both CLIs are pinned to the versions verified by B13/P4/P5.
# Trusted services get only tini on top of Node; agent tools stay in the runtime stage.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS base
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS runtime
# The CLIs install from a lockfile: the exact version of every package, transitive ones
# included, each tarball checked against its sha512. No lifecycle script runs as root, and none
# is needed: Kimi's postinstall only replaces a legacy shim, node-pty serves its interactive
# terminal. `npm ls` fails the build if the lockfile stops holding the verified versions.
# Changing a version: packages/agent-drivers/cli/README.md.
COPY packages/agent-drivers/cli/package.json packages/agent-drivers/cli/package-lock.json /usr/local/lib/raditi/agent-clis/
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git zstd ca-certificates curl jq ripgrep fd-find php-cli composer \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/* \
    && cd /usr/local/lib/raditi/agent-clis \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && npm ls @openai/codex@0.158.0 \
    && npm ls @moonshot-ai/kimi-code@2.1.1 \
    && npm cache clean --force \
    # The layout of a global install: the drivers and `codex`/`kimi` on PATH rely on it.
    && ln -s /usr/local/lib/raditi/agent-clis/node_modules/@openai /usr/local/lib/node_modules/@openai \
    && ln -s /usr/local/lib/raditi/agent-clis/node_modules/@moonshot-ai /usr/local/lib/node_modules/@moonshot-ai \
    && ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && ln -s ../lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs /usr/local/bin/kimi \
    && mkdir -p /workspace /agent-home /run/raditi/exec /run/raditi/secrets \
    && chown -R 10001:10001 /workspace /agent-home /run/raditi
COPY packages/sandbox-providers/runtime/runtime.mjs /usr/local/lib/raditi/runtime.mjs
ENV HOME=/agent-home LANG=C.UTF-8
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

# The gateway manager sets entrypoint and user; a bare run still does not start as root.
FROM base AS gateway
COPY infra/sandbox/gateway.mjs /usr/local/lib/raditi/gateway.mjs
USER 10001:10001

# This is trusted network infrastructure. Agent containers never get NET_ADMIN or root.
# network-guard.mjs filters the shared netns under runc; host-firewall.mjs guards the host
# from runsc attempt bridges (spec §8).
FROM base AS network-guard
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*
COPY infra/sandbox/network-guard.mjs infra/sandbox/host-firewall.mjs /usr/local/lib/raditi/

# Separate trusted service; agent containers never receive its Docker socket.
FROM base AS watchdog
COPY infra/sandbox/watchdog.mjs /usr/local/lib/raditi/watchdog.mjs
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/usr/local/lib/raditi/watchdog.mjs"]
