import { randomBytes } from 'node:crypto'

import { badRequest, type RepoRef } from '@repo/domain'

import { parseGitProviderConfig, type GitProviderConfig } from './config.ts'
import type { ManagedGitProvider } from './credential-lifecycle.ts'
import {
  createGiteaClient,
  giteaFailed,
  isGiteaName,
  type GiteaClient,
  type GiteaClientOptions,
} from './gitea-client.ts'
import { createStubGitProvider } from './stub-provider.ts'
import { parseGiteaWebhook } from './webhook.ts'

export type GiteaProviderOptions = GiteaClientOptions

/**
 * Gitea 1.27.3 access tokens have no lifetime, so the adapter enforces one: the expiry is part
 * of the token's name, the adapter deletes the token when it expires, and a token that outlived
 * its process is swept by name — at the start of the next process (`sweepCredentials`) and
 * before a grant. A process that stops deletes what it issued (`revokeCredentials`).
 */
const GRANT = /^raditi-git-[rw]-(\d{1,12})-[0-9a-f]{16}$/
const SCOPES = { read: 'read:repository', write: 'write:repository' } as const
const MIN_TTL_SECONDS = 5
const MAX_TTL_SECONDS = 900
const SWEEP_INTERVAL_MS = 5 * 60_000
/** The list must end within them: just under 2 000 tokens of the bot with the default page size. */
const SWEEP_PAGES = 40
const REVOKE_RETRY_MS = 30_000
/** About ten minutes of retries; after that the sweep of a later grant takes over. */
const REVOKE_RETRIES = 20

/**
 * Our Gitea 1.27, organization `sites` (spec §10): `getRepository` and `issueCredentials`.
 * The other API methods stay P8 stubs. The API is called only over https and with a bot token;
 * webhook parsing needs neither.
 */
export function createGiteaProvider(
  config: GitProviderConfig,
  options: GiteaProviderOptions = {},
): ManagedGitProvider {
  const parsed = parseGitProviderConfig('GiteaProvider', config)
  let client: GiteaClient | undefined
  const api = () => (client ??= createGiteaClient(parsed, options))
  let login: Promise<string> | undefined
  let sweeping: Promise<void> | undefined
  let sweptAt = Number.NEGATIVE_INFINITY
  /**
   * Tokens waiting for their deletion, by id. `own` — issued by this process; the others are
   * live grants a sweep found, left by a process that is gone or held by another replica.
   */
  const pending = new Map<number, { timer: NodeJS.Timeout; own: boolean }>()

  /** The bot's own login: the owner of every token this adapter creates. */
  function botLogin(): Promise<string> {
    login ??= api()
      .tokenOwner()
      .catch((error: unknown) => {
        login = undefined
        throw error
      })
    return login
  }

  async function sweep(bot: string): Promise<void> {
    const expired: number[] = []
    let ended = false
    for (let page = 1; page <= SWEEP_PAGES && !ended; page++) {
      const tokens = await api().listTokens(bot, page)
      ended = tokens.length === 0
      for (const token of tokens) {
        const seconds = GRANT.exec(token.name)?.[1]
        if (seconds === undefined) continue
        const left = Number(seconds) * 1000 - Date.now()
        if (left <= 0) expired.push(token.id)
        // A live grant nobody here watches ends at its term even if its process is gone.
        // A term beyond the longest grant is not one of this adapter's: a later sweep sees it.
        else if (left <= MAX_TTL_SECONDS * 1000 && !pending.has(token.id))
          revokeAt(bot, token.id, Number(seconds) * 1000, false)
      }
    }
    // Listed first: deleting while paging would shift the pages.
    for (const id of expired) await api().deleteToken(bot, id)
    // The unread rest may hold expired grants; what was deleted shortens the next sweep's list.
    if (!ended) throw giteaFailed('Gitea lists more tokens than a sweep reads')
  }

  /** No grant is issued while expired ones may still be alive. */
  function sweepIfDue(bot: string): Promise<void> {
    if (Date.now() - sweptAt < SWEEP_INTERVAL_MS) return Promise.resolve()
    sweeping ??= sweep(bot)
      .then(() => {
        sweptAt = Date.now()
      })
      .finally(() => {
        sweeping = undefined
      })
    return sweeping
  }

  function revokeAt(bot: string, id: number, at: number, own: boolean, attempt = 0): void {
    const timer = setTimeout(
      () => {
        // Forgotten or re-armed only while this timer is still the token's: a revocation at
        // shutdown may have taken the token over in the meantime.
        const mine = () => pending.get(id)?.timer === timer
        api()
          .deleteToken(bot, id)
          .then(
            () => {
              if (mine()) pending.delete(id)
            },
            () => {
              if (!mine()) return
              if (attempt < REVOKE_RETRIES)
                revokeAt(bot, id, Date.now() + REVOKE_RETRY_MS, own, attempt + 1)
              else pending.delete(id)
            },
          )
      },
      Math.max(0, at - Date.now()),
    )
    // A pending expiry does not keep the process alive; the next start sweeps what it left.
    timer.unref()
    pending.set(id, { timer, own })
  }

  return {
    ...createStubGitProvider('gitea', 'GiteaProvider', parseGiteaWebhook),
    async getRepository(ref) {
      assertGitea(ref)
      const repository = await api().getRepository(ref.owner, ref.name)
      if (!repository) return null
      return {
        ref: { provider: 'gitea', owner: repository.owner, name: repository.name },
        defaultBranch: repository.defaultBranch,
        // Built from the configured address: Gitea derives its clone_url from the Host header.
        cloneUrl: `${api().root}/${repository.owner}/${repository.name}.git`,
        private: repository.private,
      }
    },
    /**
     * A Gitea token is scoped to the bot's repositories, not to `ref`: it opens every
     * repository the bot may read (or write). `expiresAt` is when the adapter deletes it.
     */
    async issueCredentials(ref, access, ttlSeconds) {
      assertGitea(ref)
      if (access !== 'read' && access !== 'write') throw badRequest('Invalid repository access')
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < MIN_TTL_SECONDS ||
        ttlSeconds > MAX_TTL_SECONDS
      )
        throw badRequest('Invalid credential lifetime')
      const bot = await botLogin()
      await sweepIfDue(bot)
      // Counted from before the request: the token never lives longer than it was asked to.
      const expiresAt = Date.now() + ttlSeconds * 1000
      const name = `raditi-git-${access === 'read' ? 'r' : 'w'}-${Math.ceil(expiresAt / 1000)}-${randomBytes(8).toString('hex')}`
      const created = await api().createToken(bot, name, [SCOPES[access]])
      if (
        created.name !== name ||
        created.scopes.length !== 1 ||
        created.scopes[0] !== SCOPES[access]
      ) {
        // Deleted now; if Gitea does not confirm, the retries of an expiry take over.
        await api()
          .deleteToken(bot, created.id)
          .catch(() => revokeAt(bot, created.id, Date.now() + REVOKE_RETRY_MS, true, 1))
        throw giteaFailed('Gitea issued a token of another scope')
      }
      revokeAt(bot, created.id, expiresAt, true)
      return { username: bot, token: created.token, expiresAt: new Date(expiresAt) }
    },
    async sweepCredentials() {
      await sweepIfDue(await botLogin())
    },
    async revokeCredentials() {
      const own = [...pending].filter(([, grant]) => grant.own)
      if (own.length === 0) return
      const bot = await botLogin()
      // At once: a stopping process has seconds, and one unanswered deletion must not cost the rest.
      const deleted = await Promise.allSettled(
        own.map(async ([id, grant]) => {
          await api().deleteToken(bot, id)
          clearTimeout(grant.timer)
          if (pending.get(id) === grant) pending.delete(id)
        }),
      )
      // What Gitea did not confirm keeps its timer and its name: the expiry or a sweep ends it.
      if (deleted.some((result) => result.status === 'rejected'))
        throw giteaFailed('Gitea did not confirm the deletion of every issued token')
    },
  }
}

function assertGitea(ref: RepoRef): void {
  if (ref?.provider !== 'gitea' || !isGiteaName(ref.owner) || !isGiteaName(ref.name))
    throw badRequest('Invalid repository reference')
}
