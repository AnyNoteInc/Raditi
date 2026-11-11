import { Logger } from '@nestjs/common'
import {
  WEB_SEARCH_FOLDER_FIELD,
  WEB_SEARCH_KEY_FIELD,
  WEB_SEARCH_KEY_PATH,
  webSearchFolderSchema,
  webSearchKeySchema,
  type SecretStore,
  type WebSearchCredentials,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'

import { mcpErrorSummary } from '../common/mcp-http-error.ts'

/** WebSearchKey of the app: read by the guard, which offers `search_web` while it is there, and calls. */
export const MCP_WEB_SEARCH_KEY = Symbol('MCP_WEB_SEARCH_KEY')

/** How long a read of the key stands: an imported or removed key is seen within this. */
export const WEB_SEARCH_KEY_TTL_MS = 30_000

/**
 * The access of the web search — the API key and the folder of Yandex Cloud — read from Vault
 * where the operator command put it (`WEB_SEARCH_KEY_PATH`, spec §20, «Веб-поиск агента — Yandex
 * Search API, 11.11.2026»). The tool is offered while it is there; the key stays in this object and
 * goes nowhere but the header of a request to the search service. A read that fails — Vault down,
 * the path refused, a field missing or malformed — is no key, for a while.
 */
export class WebSearchKey {
  readonly #logger = new Logger('McpWebSearch')
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))
  #cached: { key: WebSearchCredentials | null; until: number } | null = null
  #pending: Promise<WebSearchCredentials | null> | null = null

  constructor(
    private readonly secrets: Pick<SecretStore, 'kvRead'>,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  async available(): Promise<boolean> {
    return (await this.read()) !== null
  }

  async read(): Promise<WebSearchCredentials | null> {
    const now = (this.options.now ?? Date.now)()
    if (this.#cached && this.#cached.until > now) return this.#cached.key
    this.#pending ??= this.#fetch().finally(() => {
      this.#pending = null
    })
    const key = await this.#pending
    this.#cached = { key, until: now + (this.options.ttlMs ?? WEB_SEARCH_KEY_TTL_MS) }
    return key
  }

  async #fetch(): Promise<WebSearchCredentials | null> {
    try {
      const secret = await this.secrets.kvRead(WEB_SEARCH_KEY_PATH)
      if (!secret) return null
      const key = webSearchKeySchema.safeParse(secret.data[WEB_SEARCH_KEY_FIELD])
      const folder = webSearchFolderSchema.safeParse(secret.data[WEB_SEARCH_FOLDER_FIELD])
      if (!key.success || !folder.success) {
        this.#warn('The access of the web search in Vault is malformed', 'malformed')
        return null
      }
      return { apiKey: key.data, folderId: folder.data }
    } catch (error) {
      // The class and codes only: never the value or the answer of Vault.
      this.#warn('The key of the web search cannot be read', mcpErrorSummary(error))
      return null
    }
  }
}
