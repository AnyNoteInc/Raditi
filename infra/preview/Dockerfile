# Images of previews (docs/plan/53-chat-preview-release.md, Р18, Р21). The build context is this
# folder: docker build -f infra/preview/Dockerfile --target <tools|browser|site> infra/preview
# The runtime pins each by digest (PREVIEW_FORWARDER_IMAGE, PREVIEW_BROWSER_IMAGE,
# PREVIEW_SITE_IMAGES); README.md.

# The base of the `site` target: the image of WordPress until docs/plan/62 moves it over;
# `php-base` — the stage below, on the official image of one PHP version.
ARG BASE=wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5
# The official image of one PHP version, by the digest of its index: amd64 and arm64 alike.
# site-bases.json lists them; the default is PHP 8.3.
ARG PHP_BASE=php@sha256:df17bb6139ae1667c9d9c042a4f0bf9e4e3767e0a940fadc7b17727e6e55c418
ARG TARGETARCH

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

# The extension installer of the official PHP images, by version and sha256; a stage of its own,
# so nothing of it stays in an image.
FROM scratch AS php-extension-installer
ADD --chmod=0755 --checksum=sha256:27fa8d80bd4e22feb9ddcadff1ca40c8f3e8ea942eb2dd8f446ed1afd2f2f0ab \
    https://github.com/mlocati/docker-php-extension-installer/releases/download/2.13.2/install-php-extensions \
    /install-php-extensions

# ionCube Loader 15.5.1 (18.09.2026). The address has no version: a new release of the vendor
# fails the checksum and stops the build until the version and both sums change together.
FROM scratch AS ioncube-archive-amd64
ADD --checksum=sha256:739962bd012e77ee82bf01f77a9641f050e4be057f0a5d1a95fe59ce11fd62ba \
    https://downloads.ioncube.com/loader_downloads/ioncube_loaders_lin_x86-64.tar.gz /ioncube.tar.gz
FROM scratch AS ioncube-archive-arm64
ADD --checksum=sha256:b091974aa80a76bd798d71fd5209797d93749b0be13eaff978a3dbe0106b9e1f \
    https://downloads.ioncube.com/loader_downloads/ioncube_loaders_lin_aarch64.tar.gz /ioncube.tar.gz
FROM ioncube-archive-${TARGETARCH} AS ioncube-archive

# What every stack of a preview runs on (docs/plan/62, Т21). Nothing here knows a stack.
# ionCube has no Loader for PHP 8.0 on any architecture. Its first ini name loads it before
# OPcache, as its README asks. status is off: the entry forwarder comes from the loopback, and
# Debian opens /server-status to `Require local`. PHP_PECL_PINS names the version of every PECL
# extension: an empty cache and the monthly rebuild give the same imagick, redis and apcu.
FROM ${PHP_BASE} AS php-base
ARG PHP_EXTENSIONS_SKIP=
ARG PHP_PECL_PINS="apcu-5.1.28 imagick-3.8.1 mcrypt-1.0.9 memcached-3.4.0 redis-6.3.0 xmlrpc-1.0.0RC3"
RUN --mount=type=bind,from=php-extension-installer,source=/install-php-extensions,target=/usr/local/bin/install-php-extensions \
    --mount=type=bind,from=ioncube-archive,source=/ioncube.tar.gz,target=/tmp/ioncube.tar.gz \
    set -eu; \
    . /etc/os-release; \
    php_version=$(php -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;'); \
    names=; \
    for name in apcu bcmath bz2 calendar exif gd gettext gmp imagick intl ldap mcrypt memcached \
      mysqli opcache pdo_mysql redis shmop soap sockets sysvmsg sysvsem sysvshm xmlrpc xsl zip; do \
      pinned=$name; \
      for pin in $PHP_PECL_PINS; do case "$pin" in "$name"-*) pinned=$pin ;; esac; done; \
      case " $PHP_EXTENSIONS_SKIP " in *" $name "*) ;; *) names="$names $pinned" ;; esac; \
    done; \
    install-php-extensions $names; \
    install -d -m 0755 /usr/local/lib/raditi; \
    if [ "$php_version" != 8.0 ]; then \
      install -d -m 0755 /usr/local/lib/raditi/ioncube; \
      tar -xzf /tmp/ioncube.tar.gz -C /usr/local/lib/raditi/ioncube --strip-components=1 \
        --no-same-owner ioncube/LICENSE.txt "ioncube/ioncube_loader_lin_${php_version}.so"; \
      chmod -R a+rX /usr/local/lib/raditi/ioncube; \
      printf 'zend_extension=/usr/local/lib/raditi/ioncube/ioncube_loader_lin_%s.so\n' "$php_version" \
        > /usr/local/etc/php/conf.d/00-ioncube.ini; \
    fi; \
    case "$VERSION_CODENAME" in \
      trixie) heif='libheif-plugin-aomenc libheif-plugin-x265' ;; \
      *) heif= ;; \
    esac; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ghostscript $heif; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*; \
    a2enmod rewrite expires remoteip headers; \
    a2dismod -f status
COPY --chmod=0644 preview-php.ini /usr/local/etc/php/conf.d/50-raditi.ini
COPY --chmod=0755 no-sendmail /usr/local/lib/raditi/no-sendmail

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
