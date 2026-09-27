# Platform runtime. Driver CLIs and their pinned versions are added by P4/P5.
# Trusted services get only tini on top of Node; agent tools stay in the runtime stage.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS base
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS runtime
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git zstd ca-certificates curl jq ripgrep fd-find php-cli composer \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/* \
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
FROM base AS network-guard
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*
COPY infra/sandbox/network-guard.mjs /usr/local/lib/raditi/network-guard.mjs

# Separate trusted service; agent containers never receive its Docker socket.
FROM base AS watchdog
COPY infra/sandbox/watchdog.mjs /usr/local/lib/raditi/watchdog.mjs
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/usr/local/lib/raditi/watchdog.mjs"]
