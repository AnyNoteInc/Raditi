import {
  agentSkillSecretPath,
  agentSkillSecretSchema,
  type AgentSkillSecret,
  type SecretStore,
} from '@repo/domain'

/** How long a read stands: a key the owner replaced is used within this. */
export const SKILL_SECRET_TTL_MS = 60_000

export interface SkillSecretRead {
  secret: AgentSkillSecret
  /** The version of the key: the CAS of a renewed token (docs/plan/81, §3.4). */
  version: number
}

/**
 * The secrets of MCP servers in Vault (`kv/sites/<site>/mcp/<name>`, docs/plan/81-mcp-server-
 * credentials.md), read under the role's AppRole and kept in this process for a minute. A key
 * that is gone or erased — a version without a value — is no secret. The value goes nowhere but
 * the header of the server's request; it is never logged.
 */
export class SkillSecrets {
  readonly #cache = new Map<string, { read: SkillSecretRead | null; until: number }>()

  constructor(
    private readonly secrets: Pick<SecretStore, 'kvRead'>,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  async read(siteId: string, name: string): Promise<SkillSecretRead | null> {
    const path = agentSkillSecretPath(siteId, name)
    const now = (this.options.now ?? Date.now)()
    const cached = this.#cache.get(path)
    if (cached !== undefined && cached.until > now) return cached.read
    const stored = await this.secrets.kvRead(path)
    const parsed = stored === null ? null : agentSkillSecretSchema.safeParse(stored.data)
    const read =
      stored !== null && parsed?.success ? { secret: parsed.data, version: stored.version } : null
    this.#cache.set(path, { read, until: now + (this.options.ttlMs ?? SKILL_SECRET_TTL_MS) })
    return read
  }

  /** Forgets a server's secret: the next read goes to Vault (a refused key, a renewed token). */
  forget(siteId: string, name: string): void {
    this.#cache.delete(agentSkillSecretPath(siteId, name))
  }
}
