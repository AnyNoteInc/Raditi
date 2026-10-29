# The image of the preview app (the gateway of previews, docs/plan/53-chat-preview-release.md,
# Р19): routes the exact Host of a preview to its upstream; with the browser worker configured,
# also relays the stream of a task's browser on 8091 (docs/plan/57-browser-tasks.md, Б12). Has
# the database, no git, no gitleaks.
# The user comes from compose (preview: 10009).
#   docker build -f apps/preview/Dockerfile --target runtime .
# No `# syntax=` line: Docker's built-in frontend already has cache mounts, and it pulls nothing
# from Docker Hub. Mirrors keep upstream digests, so a mirror is just another NODE_IMAGE.
ARG NODE_IMAGE=node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1

FROM ${NODE_IMAGE} AS toolchain
# Node 26 ships no corepack: pnpm is pinned like devEngines
RUN npm install --global pnpm@12.6.0 && npm cache clean --force
WORKDIR /repo

FROM toolchain AS pruned
COPY . .
# turbo comes from the lockfile (integrity-checked), not from `pnpm dlx`
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
 && pnpm exec turbo prune preview --docker

FROM toolchain AS build
COPY --from=pruned /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=pruned /repo/out/full/ ./
# prisma.config.ts reads DATABASE_URL; generate never connects
RUN DATABASE_URL=postgresql://build@localhost/build pnpm --filter @repo/db db:generate \
 && pnpm --filter preview build

FROM build AS prod
# The workspace layout stays: packages ship TypeScript sources that Node type-strips, and it
# refuses to strip under node_modules — so no `pnpm deploy`
# Not --offline: a runner restores the install layer of the build stage from the build cache,
# never the cache mount it filled, so the store may be empty here; the lockfile still decides
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --prefer-offline --store-dir /pnpm/store

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Root-owned: the process cannot rewrite its own code
COPY --from=prod /repo /app
ENV NODE_ENV=production
WORKDIR /app/apps/preview
USER 10001:10001
EXPOSE 8090 8091
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
