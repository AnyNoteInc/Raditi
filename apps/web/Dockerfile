# The web app as a Next.js standalone server; the uid comes from compose (web: 10001).
#   docker build -f apps/web/Dockerfile --target runtime .
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
 && pnpm exec turbo prune web --docker

FROM toolchain AS build
COPY --from=pruned /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=pruned /repo/out/full/ ./
ENV NEXT_TELEMETRY_DISABLED=1
# prisma.config.ts reads DATABASE_URL; generate never connects
RUN DATABASE_URL=postgresql://build@localhost/build pnpm --filter @repo/db db:generate \
 && pnpm --filter web build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# Root-owned: the process cannot rewrite its own code. No public/ directory; the legal texts
# (MDX) are compiled into the build, and instrumentation.ts is part of the standalone server.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["apps/web/server.js"]
