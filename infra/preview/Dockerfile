# Images of previews (docs/plan/53-chat-preview-release.md, Р18, Р21). The build context is this
# folder: docker build -f infra/preview/Dockerfile --target <tools|browser> infra/preview
# The runtime pins each by digest (PREVIEW_FORWARDER_IMAGE, PREVIEW_BROWSER_IMAGE); README.md.

# Trusted tools of a preview: the entry forwarder, the browser relay and the files helper. The
# runtime sets the entrypoint and the user of each container; a bare run is not root either.
FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS tools
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
COPY forward.mjs files.mjs /usr/local/lib/raditi/
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]

# The agent's browser: Chromium of the Playwright image, Playwright from a lockfile (every
# tarball checked against its sha512, no install scripts), the server that starts it.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS browser
COPY browser/package.json browser/package-lock.json /usr/local/lib/raditi/browser/
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && cd /usr/local/lib/raditi/browser \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && npm ls playwright-core@1.63.0 \
    && npm cache clean --force
COPY browser-server.mjs /usr/local/lib/raditi/browser/server.mjs
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
