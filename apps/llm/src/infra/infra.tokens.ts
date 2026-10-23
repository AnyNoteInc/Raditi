// PRISMA and SECRET_STORE are @repo/service-runtime's: the same Symbols a stand gets the role's
// clients by. The tokens below are the role's own.

/** readonly LlmBackend[]: the registry the role's configuration read its provider origins from. */
export const LLM_BACKENDS = Symbol('LLM_BACKENDS')
/**
 * The one Logger('LlmGateway') of the role: the store, the channel, the pool, the gateway and the
 * maintenance jobs write under this context.
 */
export const LLM_LOGGER = Symbol('LLM_LOGGER')
/** HealthProbe over the database and Vault, cached: what GET /health of the gateway asks. */
export const HEALTH_PROBE = Symbol('HEALTH_PROBE')
/** DatabaseShutdown: the last step of the stop of the role (gateway/llm-runtime.ts). */
export const DATABASE_SHUTDOWN = Symbol('DATABASE_SHUTDOWN')
