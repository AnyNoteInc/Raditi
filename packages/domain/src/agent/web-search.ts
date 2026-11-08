import { z } from 'zod'

/**
 * The key of the agent's web search (`raditi_search_web`, Parallel Search; spec §20, «Веб-поиск
 * агента — 08.11.2026»): kept in Vault where the keys of the model are, `subs/` (one version,
 * CAS). The operator command of the llm app writes it and never reads it back; the mcp role
 * reads it and nothing else of `subs/` (policy `mcp-content`); the gateway is denied it.
 */
export const WEB_SEARCH_KEY_PATH = 'subs/search/parallel'
/** The one field of that secret. */
export const WEB_SEARCH_KEY_FIELD = 'key'
/** What a key of the search service looks like: its problems are said, never the value. */
export const webSearchKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{16,512}$/, 'must be 16 to 512 visible ASCII characters')
