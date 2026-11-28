import { Logger } from '@nestjs/common'
import { VK_SERVICE_KEY_PATH, VK_TOKEN_FIELD, vkTokenSchema, type SecretStore } from '@repo/domain'
import { throttledLogger } from '@repo/observability'

import { mcpErrorSummary } from '../common/mcp-http-error.ts'

/** How long a read of the key stands: an imported or removed key is seen within this. */
export const VK_SERVICE_KEY_TTL_MS = 30_000

/**
 * The service key of Raditi's VK app (docs/plan/99-vk-community.md, ВК4), read from Vault where the
 * operator put it (`VK_SERVICE_KEY_PATH`). It reads the open walls and their comments; it goes
 * nowhere but the body of a request to api.vk.com. A read that fails — Vault down, the path
 * refused, the field missing or malformed — is no key, for a while.
 */
export class VkServiceKey {
  readonly #logger = new Logger('McpVk')
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))
  #cached: { key: string | null; until: number } | null = null
  #pending: Promise<string | null> | null = null

  constructor(
    private readonly secrets: Pick<SecretStore, 'kvRead'>,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  async read(): Promise<string | null> {
    const now = (this.options.now ?? Date.now)()
    if (this.#cached && this.#cached.until > now) return this.#cached.key
    this.#pending ??= this.#fetch().finally(() => {
      this.#pending = null
    })
    const key = await this.#pending
    this.#cached = { key, until: now + (this.options.ttlMs ?? VK_SERVICE_KEY_TTL_MS) }
    return key
  }

  async #fetch(): Promise<string | null> {
    try {
      const secret = await this.secrets.kvRead(VK_SERVICE_KEY_PATH)
      if (!secret) return null
      const key = vkTokenSchema.safeParse(secret.data[VK_TOKEN_FIELD])
      if (!key.success) {
        this.#warn('The service key of VK in Vault is malformed', 'malformed')
        return null
      }
      return key.data
    } catch (error) {
      // The class and codes only: never the value or the answer of Vault.
      this.#warn('The service key of VK cannot be read', mcpErrorSummary(error))
      return null
    }
  }
}
