// Nest DI tokens every role shares. Ports and adapters are plain objects, so they are provided by
// Symbol tokens and injected with an explicit @Inject(TOKEN) (no reliance on emitted type metadata).
// The tokens only one role uses stay with that role.

/** PrismaClient from @repo/db. */
export const PRISMA = Symbol('PRISMA')
/** SecretStore port (Vault/OpenBao). */
export const SECRET_STORE = Symbol('SECRET_STORE')

/** Record<string, HealthCheck> served by GET /health. */
export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS')
