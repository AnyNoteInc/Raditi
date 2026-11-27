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
 * The secrets of MCP servers in Vault (`kv/workspaces/<workspace>/mcp/<name>`, docs/plan/81-mcp-server-
 * credentials.md), read under the role's AppRole and kept in this process for a minute. A key
 * that is gone or erased — a version without a value — is no secret. The value goes nowhere but
 * the header of the server's request; it is never logged.
 */
export class SkillSecrets {
  readonly #cache = new Map<string, { read: SkillSecretRead | null; until: number }>()
  /** One read of Vault per path at a time: the calls that miss together wait for it. */
  readonly #pending = new Map<string, PendingRead>()

  constructor(
    private readonly secrets: Pick<SecretStore, 'kvRead'>,
    private readonly options: { ttlMs?: number; now?: () => number } = {},
  ) {}

  async read(workspaceId: string, name: string): Promise<SkillSecretRead | null> {
    const path = agentSkillSecretPath(workspaceId, name)
    const now = (this.options.now ?? Date.now)()
    const cached = this.#cache.get(path)
    if (cached !== undefined && cached.until > now) return cached.read
    const pending = this.#pending.get(path)
    if (pending !== undefined) return pending.read
    const entry: PendingRead = { forgotten: false, read: Promise.resolve(null) }
    entry.read = (async () => {
      try {
        const stored = await this.secrets.kvRead(path)
        const parsed = stored === null ? null : agentSkillSecretSchema.safeParse(stored.data)
        const read =
          stored !== null && parsed?.success
            ? { secret: parsed.data, version: stored.version }
            : null
        // A key forgotten while it was read is not kept: the next read asks Vault again.
        if (!entry.forgotten)
          this.#cache.set(path, { read, until: now + (this.options.ttlMs ?? SKILL_SECRET_TTL_MS) })
        return read
      } finally {
        if (this.#pending.get(path) === entry) this.#pending.delete(path)
      }
    })()
    this.#pending.set(path, entry)
    return entry.read
  }

  /** Forgets a server's secret: the next read goes to Vault (a refused key, a renewed token). */
  forget(workspaceId: string, name: string): void {
    const path = agentSkillSecretPath(workspaceId, name)
    this.#cache.delete(path)
    const pending = this.#pending.get(path)
    if (pending !== undefined) {
      pending.forgotten = true
      this.#pending.delete(path)
    }
  }
}

interface PendingRead {
  forgotten: boolean
  read: Promise<SkillSecretRead | null>
}
