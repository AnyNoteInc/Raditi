# Throwaway image of the G1 spike: the local sandbox runtime image plus the OpenCode CLI, installed from the
# lock file the probe recorded. `npm ci` checks both tarballs against the sha512 integrity in the lock and
# downloads nothing else: the launcher package and the binary package of the image architecture.
ARG BASE=raditi-p5verify-sandbox:local
FROM ${BASE}
USER root
COPY package.json package-lock.json /usr/local/lib/raditi/opencode-cli/
RUN cd /usr/local/lib/raditi/opencode-cli \
    && npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier \
    && npm ls --all > npm-ls.txt \
    && arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
    && test -x "node_modules/opencode-linux-${arch}/bin/opencode" \
    && ln -s "/usr/local/lib/raditi/opencode-cli/node_modules/opencode-linux-${arch}/bin/opencode" /usr/local/bin/opencode \
    && sha256sum "node_modules/opencode-linux-${arch}/bin/opencode" > binary.sha256 \
    && npm cache clean --force > /dev/null 2>&1
USER 10001:10001
