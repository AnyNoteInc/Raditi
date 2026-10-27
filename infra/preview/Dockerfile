# Images of previews (docs/plan/53-chat-preview-release.md, Р18, Р21). The build context is this
# folder: docker build -f infra/preview/Dockerfile --target <tools|browser|site> infra/preview
# The runtime pins each by digest (PREVIEW_FORWARDER_IMAGE, PREVIEW_BROWSER_IMAGE,
# PREVIEW_SITE_IMAGES); README.md.

# The PHP and Apache of a `site` image: a WordPress image of one PHP version, by digest
# (docker build … --target site --build-arg BASE=wordpress@sha256:…). The default is PHP 8.3.
ARG BASE=wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5

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

# A preview in one container (docs/plan/58-preview-single-container.md, §10): the PHP and Apache
# of BASE, MariaDB, the entry forwarder and WP-CLI, started by init.sh under tini, each service
# under its own uid — PHP 33, the database 999, the forwarder 10001 — with no capability. The
# runtime starts it as 0:0 with SETUID, SETGID and SETPCAP only and a read-only root file system;
# what is written lives on its tmpfs and the two volumes, /var/www/html and /var/lib/mysql.
#
# MariaDB 11.8.9 from the archive of mariadb.org, by exact version, the key checked by its
# fingerprint 177F 4010 FE56 CA33 3630 0305 F165 6F24 C74C D1D8 (mariadb-release-signing-key.asc):
# 11.4 is not built for Debian 13 (trixie), on which the images of PHP 8.2 and later stand, and
# one version serves bullseye, bookworm and trixie alike.
FROM ${BASE} AS site
ARG MARIADB_VERSION=11.8.9
COPY mariadb-release-signing-key.asc /usr/share/keyrings/mariadb-release.asc
RUN set -eu; \
    . /etc/os-release; \
    case "$VERSION_CODENAME" in \
      bullseye) debian=11 ;; bookworm) debian=12 ;; trixie) debian=13 ;; \
      *) echo "Unsupported base: $VERSION_CODENAME" >&2; exit 1 ;; \
    esac; \
    getent passwd 999 >/dev/null && { echo 'uid 999 is taken in the base' >&2; exit 1; } || true; \
    groupadd --system --gid 999 mysql; \
    useradd --system --uid 999 --gid 999 --home-dir /nonexistent --no-create-home \
      --shell /usr/sbin/nologin mysql; \
    echo "deb [signed-by=/usr/share/keyrings/mariadb-release.asc] https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/repo/debian ${VERSION_CODENAME} main" \
      > /etc/apt/sources.list.d/mariadb.list; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tini \
      "mariadb-server-core=1:${MARIADB_VERSION}+maria~deb${debian}" \
      "mariadb-client-core=1:${MARIADB_VERSION}+maria~deb${debian}"; \
    rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/mariadb.list /var/cache/apt/* \
      /var/lib/mysql; \
    install -d -o 999 -g 999 -m 0700 /var/lib/mysql; \
    install -d -o 999 -g 999 -m 0755 /run/mysqld; \
    for binary in mariadb-install-db mariadbd mariadb setpriv setsid tini; do \
      command -v "$binary" >/dev/null || { echo "$binary is missing" >&2; exit 1; }; \
    done
# WP-CLI for the commands of the platform (`wp eval`), by its sha256.
ADD --checksum=sha256:ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c \
    https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar /usr/local/bin/wp
# The folder first: a COPY --chmod would give a folder it makes the mode of its files.
RUN chmod 0755 /usr/local/bin/wp && install -d -m 0755 /usr/local/lib/raditi
# Node of the tools image: the entry forwarder and the forwarder of names only.
COPY --from=tools /usr/local/bin/node /usr/local/bin/node
COPY --chmod=0644 forward.mjs dns.mjs /usr/local/lib/raditi/
COPY --chmod=0755 init.sh run-as.sh /usr/local/lib/raditi/
# The base stops Apache by SIGWINCH; here init stops the database cleanly on SIGTERM.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/lib/raditi/init.sh"]
CMD ["apache2-foreground"]
