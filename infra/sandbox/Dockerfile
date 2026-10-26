# WordPress stack runtime. The CLI is pinned to the version verified by G3.
# Trusted services get only tini on top of Node; agent tools stay in the runtime stage.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS base
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS runtime
# The CLI installs from a lockfile: the exact version of every package, each tarball checked
# against its sha512. No lifecycle script runs as root, and none is needed: OpenCode's only
# copies the binary of its platform package over a launcher stub. The image links that binary
# itself, by its own architecture: arm64, or the x64 baseline build, which needs no AVX2 (the
# other x64 package that npm installs next to it leaves the layer). `npm ls` fails the build if
# the lockfile stops holding the verified version.
# The browser skill of the agent (owner's request of 26.10.2026): Playwright MCP from the same
# lockfile and the Chromium of its Playwright, with the system libraries Playwright names,
# installed while building — a turn downloads nothing. The skill runs it headless, through the
# egress proxy (packages/agent-drivers/src/opencode.ts).
# Changing a version: packages/agent-drivers/cli/README.md.
COPY packages/agent-drivers/cli/package.json packages/agent-drivers/cli/package-lock.json /usr/local/lib/raditi/agent-clis/
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git zstd ca-certificates curl jq ripgrep fd-find php-cli composer \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/* \
    && cd /usr/local/lib/raditi/agent-clis \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && npm ls opencode-ai@1.18.34 \
    && npm ls @playwright/mcp@0.0.83 \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
      node node_modules/@playwright/mcp/cli.js install-browser --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/ms-playwright \
    && npm cache clean --force \
    && case "$(dpkg --print-architecture)" in \
      arm64) opencode=opencode-linux-arm64 ;; \
      amd64) opencode=opencode-linux-x64-baseline; rm -rf node_modules/opencode-linux-x64 ;; \
      *) echo 'No OpenCode binary for this architecture' >&2; exit 1 ;; \
    esac \
    && test -x "node_modules/${opencode}/bin/opencode" \
    && ln -s "/usr/local/lib/raditi/agent-clis/node_modules/${opencode}/bin/opencode" /usr/local/bin/opencode \
    && mkdir -p /workspace /agent-home /run/raditi/exec /run/raditi/secrets \
    && chown -R 10001:10001 /workspace /agent-home /run/raditi
COPY packages/sandbox-providers/runtime/runtime.mjs /usr/local/lib/raditi/runtime.mjs
ENV HOME=/agent-home LANG=C.UTF-8
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

# The gateway manager sets entrypoint and user; a bare run still does not start as root. The
# client egress proxy of a turn (Р13) is a listener of its own next to the gateway's.
FROM base AS gateway
COPY infra/sandbox/gateway.mjs infra/sandbox/client-egress.mjs /usr/local/lib/raditi/
USER 10001:10001

# The client egress proxy of a preview (docs/plan/53-chat-preview-release.md, Р13):
# PREVIEW_EGRESS_IMAGE, pinned by digest. The preview runtime starts it with LISTEN_HOST,
# LISTEN_PORT, ALLOWED_HOSTS and REFUSED_SUBNETS, as the user below.
FROM base AS client-egress
COPY infra/sandbox/client-egress.mjs /usr/local/lib/raditi/client-egress.mjs
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/usr/local/lib/raditi/client-egress.mjs"]

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
