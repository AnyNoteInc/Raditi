// The runtime the role apps with a database share: the Nest wiring of Prisma and /health, and
// the tokens they are provided by. Starting, stopping and the repository .env are
// @repo/app-bootstrap's, which reaches no database (the runner takes only that one); /metrics is
// core's alone. Nest decorators cannot be type-stripped, so unlike most packages this one is
// built to dist/ (`pnpm --filter @repo/service-runtime build`); types and tests read the sources.
export * from './database.module.ts'
export * from './health.controller.ts'
export * from './health.module.ts'
export * from './lifecycle.ts'
export * from './prisma.ts'
export * from './tokens.ts'
