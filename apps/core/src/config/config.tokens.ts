/** CoreConfig of this process. */
export const CORE_CONFIG = Symbol('CORE_CONFIG')
/** false in tests and tools: no BullMQ workers, no polling loops. */
export const BACKGROUND_JOBS = Symbol('BACKGROUND_JOBS')
