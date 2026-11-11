import { z } from 'zod'

/**
 * The access of the agent's web search (`raditi_search_web`, Yandex Search API; spec §20,
 * «Веб-поиск агента — Yandex Search API, 11.11.2026»): kept in Vault where the keys of the model
 * are, `subs/` (one version, CAS). The operator command of the llm app writes it and never reads
 * it back; the mcp role reads it and nothing else of `subs/` (policy `mcp-content`); the gateway
 * is denied it.
 */
export const WEB_SEARCH_KEY_PATH = 'subs/search/yandex'
/** The API key of the service account with the role `search-api.webSearch.user`. */
export const WEB_SEARCH_KEY_FIELD = 'key'
/** The folder of Yandex Cloud the searches are billed to; not a secret, kept beside the key. */
export const WEB_SEARCH_FOLDER_FIELD = 'folderId'
/** What a key of the search service looks like: its problems are said, never the value. */
export const webSearchKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{16,512}$/, 'must be 16 to 512 visible ASCII characters')
/** A folder id of Yandex Cloud (`b1g…`): lower-case letters and digits. */
export const webSearchFolderSchema = z
  .string()
  .regex(/^[a-z0-9]{8,64}$/, 'must be 8 to 64 lower-case letters and digits')

/** The access the search is made with: the API key and the folder it is billed to. */
export interface WebSearchCredentials {
  apiKey: string
  folderId: string
}
