# Throwaway probe image: the local sandbox runtime image plus the OpenCode CLI from a lock file.
FROM raditi-p5verify-sandbox:local
USER root
COPY package.json /usr/local/lib/raditi/opencode-cli/package.json
RUN cd /usr/local/lib/raditi/opencode-cli \
    && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --no-update-notifier \
    && npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier \
    && npm ls --all > npm-ls.txt 2>&1; \
    ls -la /usr/local/lib/raditi/opencode-cli/node_modules > /usr/local/lib/raditi/opencode-cli/node-modules-ls.txt 2>&1; \
    npm cache clean --force >/dev/null 2>&1; true
USER 10001:10001
