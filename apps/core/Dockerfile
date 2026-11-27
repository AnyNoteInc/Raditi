# The image of the core app (its own image for each app: apps/llm, apps/mcp, apps/runner, apps/preview).
# The uid comes from compose (core: 10002).
#   docker build -f apps/core/Dockerfile --target runtime .   (and --target migrate)
# Each image ships its dependencies and its code as two layers (docs/plan/92-docker-layers.md): a
# release that changes no dependency downloads only the code.
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
 && pnpm exec turbo prune core --docker \
 && pnpm exec turbo prune @repo/db --docker --out-dir out/db

FROM toolchain AS build
COPY --from=pruned /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=pruned /repo/out/full/ ./
# prisma.config.ts reads DATABASE_URL; generate never connects
RUN DATABASE_URL=postgresql://build@localhost/build pnpm --filter @repo/db db:generate \
 && pnpm --filter core... build

# The production dependencies alone: the layer changes only with the lockfile of core.
# The workspace layout stays: packages ship TypeScript sources that Node type-strips, and it
# refuses to strip under node_modules — so no `pnpm deploy`
# Not --offline: a runner restores the install layer of the build stage from the build cache,
# never the cache mount it filled, so the store may be empty here; the lockfile still decides
FROM toolchain AS deps
COPY --from=pruned /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --prefer-offline --store-dir /pnpm/store

# The code alone: the sources of the packages and dist
FROM build AS code
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules

# One-shot schema migration and seeds (MIGRATE_IMAGE): the Prisma CLI, the schema, the migrations
# and the seed of @repo/db, from its own prune and nothing of core. migrate-image.mjs leaves the
# manifests only what the image runs: the CLI and the TypeScript config become dependencies of
# @repo/db, the dev tools go. Not frozen: the edited manifests no longer match the lockfile, which
# only shrinks — `--check` fails the build on a version the lockfile does not hold.
FROM toolchain AS migrate-deps
COPY infra/app/migrate-image.mjs /usr/local/lib/raditi/
COPY --from=pruned /repo/out/db/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    node /usr/local/lib/raditi/migrate-image.mjs \
 && cp pnpm-lock.yaml pnpm-lock.locked.yaml \
 && pnpm install --prod --no-frozen-lockfile --prefer-offline --store-dir /pnpm/store \
 && node /usr/local/lib/raditi/migrate-image.mjs --check

FROM migrate-deps AS migrate-code
COPY --from=pruned /repo/out/db/full/ ./
# prisma.config.ts reads DATABASE_URL; generate never connects
RUN node /usr/local/lib/raditi/migrate-image.mjs \
 && DATABASE_URL=postgresql://build@localhost/build pnpm --filter @repo/db db:generate \
 && rm -rf node_modules packages/*/node_modules

FROM ${NODE_IMAGE} AS migrate
# Root-owned, the dependencies first: a release with no new dependency downloads only the code
COPY --from=migrate-deps /repo /repo
COPY --from=migrate-code /repo /repo
WORKDIR /repo/packages/db
USER 10004:10004
ENTRYPOINT ["node"]

FROM ${GITLEAKS_IMAGE} AS gitleaks

FROM ${NODE_IMAGE} AS runtime
# git and gitleaks for the git worker of the repositories of projects, the second entry of this
# image (docs/plan/84-projects.md, ПР33): `node dist/git-worker/main.js`. git is pinned to the
# security release of Debian trixie and the build fails below 2.47.3 (the worker pins addresses
# with http.curloptResolve and parses packs of other servers).
ARG GIT_VERSION=1:2.47.3-0+deb13u1
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates "git=${GIT_VERSION}" \
 && rm -rf /var/lib/apt/lists/* \
 && git --version | awk '{ split($3, v, "."); exit !(v[1] > 2 || (v[1] == 2 && (v[2] > 47 || (v[2] == 47 && v[3] >= 3)))) }'
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
# Root-owned: the process cannot rewrite its own code. The dependencies first, the code on top
COPY --from=deps /repo /app
COPY --from=code /repo /app
ENV NODE_ENV=production
WORKDIR /app/apps/core
USER 10001:10001
EXPOSE 8081 8083
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
