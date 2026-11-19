/** Per-turn subscription gateway key and MCP token: Vault turns/ plus fenced PostgreSQL rows. */
export const TURN_CREDENTIALS = Symbol('TURN_CREDENTIALS')
/** The probe of the pool through the gateway (`PoolProbeClient`); null without LLM_CONTROL_URL. */
export const POOL_PROBE = Symbol('POOL_PROBE')
