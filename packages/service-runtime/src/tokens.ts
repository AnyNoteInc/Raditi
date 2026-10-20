// Nest DI tokens every role shares. Ports and adapters are plain objects, so they are provided by
// Symbol tokens and injected with an explicit @Inject(TOKEN) (no reliance on emitted type metadata).
// The tokens only one role uses stay with that role.

/** PrismaClient from @repo/db. */
export const PRISMA = Symbol('PRISMA')
/** ObjectStorage port (S3). */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE')
/** SecretStore port (Vault/OpenBao). */
export const SECRET_STORE = Symbol('SECRET_STORE')

/** Record<string, HealthCheck> served by GET /health. */
export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS')
/** Prometheus registry served by GET /metrics. */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY')
/** The bearer token of GET /metrics (and of the details of GET /health). */
export const METRICS_TOKEN = Symbol('METRICS_TOKEN')
/** false in tests and tools: no BullMQ workers, no polling loops. */
export const BACKGROUND_JOBS = Symbol('BACKGROUND_JOBS')
