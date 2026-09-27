# One image for the core, mcp and runner roles; the uid comes from compose (core: 10002).
#   docker build -f apps/orchestrator/Dockerfile --target runtime .   (and --target migrate)
# No `# syntax=` line: Docker's built-in frontend already has cache mounts, and it pulls nothing
# from Docker Hub. Mirrors keep upstream digests, so a mirror is just another NODE_IMAGE.
ARG NODE_IMAGE=node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
ARG GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f

FROM ${NODE_IMAGE} AS toolchain
# Node 26 ships no corepack: pnpm is pinned like devEngines
RUN npm install --global pnpm@12.6.0 && npm cache clean --force
WORKDIR /repo

FROM toolchain AS pruned
COPY . .
# turbo comes from the lockfile (integrity-checked), not from `pnpm dlx`
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
 && pnpm exec turbo prune orchestrator --docker

FROM toolchain AS build
COPY --from=pruned /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=pruned /repo/out/full/ ./
# prisma.config.ts reads DATABASE_URL; generate never connects
RUN DATABASE_URL=postgresql://build@localhost/build pnpm --filter @repo/db db:generate \
 && pnpm --filter orchestrator build

# One-shot schema migration and seeds: the Prisma CLI is a dev dependency of @repo/db
FROM build AS migrate
WORKDIR /repo/packages/db
USER 10004:10004
ENTRYPOINT ["node"]

FROM build AS prod
# The workspace layout stays: packages ship TypeScript sources that Node type-strips, and it
# refuses to strip under node_modules — so no `pnpm deploy`
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --offline --store-dir /pnpm/store

FROM ${GITLEAKS_IMAGE} AS gitleaks

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Publication needs git ≥ 2.47 (spec §8): fail the build, not the first publication
 && git --version | awk '{ split($3, v, "."); exit !(v[1] > 2 || (v[1] == 2 && v[2] >= 47)) }'
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
# Root-owned: the process cannot rewrite its own code
COPY --from=prod /repo /app
ENV NODE_ENV=production
WORKDIR /app/apps/orchestrator
USER 10001:10001
EXPOSE 8081 8082 8083
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
