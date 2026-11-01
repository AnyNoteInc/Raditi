# syntax=docker/dockerfile:1
# Research prototype, not part of the repository.
ARG OS=debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
FROM ${OS} AS os
COPY mariadb-release-signing-key.asc /usr/share/keyrings/mariadb-release.asc
COPY sury.gpg /usr/share/keyrings/sury.gpg
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eu; \
    . /etc/os-release; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates locales tini; \
    printf 'ru_RU.UTF-8 UTF-8\nru_RU.CP1251 CP1251\nen_US.UTF-8 UTF-8\n' > /etc/locale.gen; \
    locale-gen; \
    echo "deb [signed-by=/usr/share/keyrings/mariadb-release.asc] https://archive.mariadb.org/mariadb-11.8.9/repo/debian ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/mariadb.list; \
    echo "deb [signed-by=/usr/share/keyrings/sury.gpg] https://packages.sury.org/php/ ${VERSION_CODENAME} main" > /etc/apt/sources.list.d/sury.list; \
    apt-get update; \
    groupadd --system --gid 999 mysql; \
    useradd --system --uid 999 --gid 999 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin mysql; \
    apt-get install -y --no-install-recommends apache2 \
      "mariadb-server-core=1:11.8.9+maria~deb13" "mariadb-client-core=1:11.8.9+maria~deb13"; \
    a2dismod -f mpm_event >/dev/null; a2enmod mpm_prefork rewrite headers expires deflate env setenvif mime dir alias >/dev/null; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/lib/mysql

FROM os AS site
ARG PHP=8.3
RUN set -eu; \
    apt-get update; \
    pk=""; for e in cli common bcmath bz2 curl gd gmp imagick intl ldap mbstring memcached mysql opcache redis soap xml zip apcu mcrypt xmlrpc; do pk="$pk php${PHP}-$e"; done; \
    case "$PHP" in 5.*|7.*) pk="$pk php${PHP}-json";; 8.5) pk=$(echo "$pk" | sed "s/ php8.5-opcache//");; esac; \
    apt-get install -y --no-install-recommends "libapache2-mod-php${PHP}" $pk; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*; \
    a2dismod -f mpm_event >/dev/null 2>&1 || true; a2enmod mpm_prefork "php${PHP}" >/dev/null
