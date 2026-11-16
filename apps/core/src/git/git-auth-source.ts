import type { PrismaClient } from '@repo/db'
import {
  gitConnectionReauth,
  gitConnectionSecretPath,
  gitConnectionSecretSchema,
  gitNotSupported,
  gitProviderFailed,
  type GitConnect,
  type GitConnectionKind,
  type GitConnectionSecret,
  type GitGrant,
  type OAuthApp,
  type SecretStore,
} from '@repo/domain'

// The access of a git connection for one operation (docs/plan/84-projects.md, §4.3, ПР10): the
// tokens are read from Vault (`core-git`), never from the base, and never leave core but as the
// grant of the operation. A GitLab OAuth pair close to its end is renewed by one renewer: under
// the advisory lock of the connection, the second process waits, reads the pair the first one
// wrote and uses it — a refresh token is good once, so two renewals would sign the client out.
// The new pair is written by CAS on the version that was read. A refresh the provider refuses
// for good puts the connection to `reauth_needed`.

/** A pair is renewed this long before the end the provider named. */
export const GIT_TOKEN_RENEW_BEFORE_MS = 2 * 60_000
/** Writes of a renewed pair to Vault, and the pause between them grows by this. */
const KEEP_TRIES = 3
const KEEP_PAUSE_MS = 250

export interface GitConnectionOfGrant {
  id: string
  workspaceId: string
  kind: GitConnectionKind
  host: string
  /** The installation of a connection of the GitHub App (ПР10). */
  installationId?: bigint | string | null
}

/** The GitHub App of Raditi as core holds it (§4.2): its id, and its private key read on demand. */
export interface GithubAppGrantSource {
  appId: string
  /** The PEM of the key: read from its file each time, so a new key needs no restart. */
  privateKey(): string
}

export interface GitAuthSourceOptions {
  prisma: PrismaClient
  secrets: Pick<SecretStore, 'kvRead' | 'kvWrite'>
  /** The sign-in adapter of a host (createGitConnect of @repo/git-providers/connect). */
  connect: (host: string) => GitConnect
  /** Raditi's OAuth app on gitlab.com; null — the pair cannot be renewed (not configured). */
  gitlabOauth: OAuthApp | null
  /** Raditi's GitHub App; null — its connections are not served here (not configured). */
  githubApp?: GithubAppGrantSource | null
  now?: () => Date
}

interface ReadSecret {
  data: GitConnectionSecret
  version: number
}

export class GitAuthSource {
  readonly #options: GitAuthSourceOptions
  readonly #now: () => Date

  constructor(options: GitAuthSourceOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date())
  }

  /** The grant of an operation on this connection; GIT_CONNECTION_REAUTH when it must sign in. */
  async grantFor(connection: GitConnectionOfGrant): Promise<GitGrant> {
    const grants: Record<GitConnectionKind, () => Promise<GitGrant>> = {
      gitlab_token: async () => {
        const secret = await this.#read(connection)
        if (!('token' in secret.data)) throw gitProviderFailed('a token connection without one')
        return { kind: 'token', token: secret.data.token }
      },
      gitlab_oauth: async () => ({ kind: 'token', token: await this.#oauthToken(connection) }),
      // An installation's access is issued per operation by the adapter, from the app's JWT; core
      // keeps no token of it (ПР10).
      github_app: async () => {
        const app = this.#options.githubApp ?? null
        if (app === null) throw gitNotSupported('the GitHub App, which is not configured here')
        const installationId = connection.installationId
        if (installationId === null || installationId === undefined)
          throw gitProviderFailed('a connection of the GitHub App without its installation')
        return {
          kind: 'github_installation',
          appId: app.appId,
          privateKey: app.privateKey(),
          installationId: String(installationId),
        }
      },
    }
    return grants[connection.kind]()
  }

  async #read(connection: GitConnectionOfGrant): Promise<ReadSecret> {
    const read = await this.#options.secrets.kvRead(
      gitConnectionSecretPath(connection.workspaceId, connection.id),
    )
    const parsed = gitConnectionSecretSchema.safeParse(read?.data)
    if (read === null || !parsed.success) throw gitConnectionReauth()
    return { data: parsed.data, version: read.version }
  }

  #fresh(secret: GitConnectionSecret): string | null {
    if (!('accessToken' in secret)) return null
    if (secret.expiresAt === undefined) return secret.accessToken
    const left = Date.parse(secret.expiresAt) - this.#now().getTime()
    return left > GIT_TOKEN_RENEW_BEFORE_MS ? secret.accessToken : null
  }

  /**
   * The renewed pair written over `cas`, tried up to three times. null — another writer moved the
   * version meanwhile (a new sign-in): its pair stands.
   */
  async #keep(
    connection: GitConnectionOfGrant,
    path: string,
    data: Record<string, string>,
    cas: number,
  ): Promise<number | null> {
    let failure: unknown
    for (let attempt = 0; attempt < KEEP_TRIES; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, KEEP_PAUSE_MS * attempt))
      try {
        return (await this.#options.secrets.kvWrite(path, data, { cas })).version
      } catch (error) {
        failure = error
        const now = await this.#read(connection).catch(() => null)
        if (now !== null && now.version !== cas) return null
      }
    }
    throw failure
  }

  async #oauthToken(connection: GitConnectionOfGrant): Promise<string> {
    const first = await this.#read(connection)
    const fresh = this.#fresh(first.data)
    if (fresh !== null) return fresh
    const app = this.#options.gitlabOauth
    if (app === null || app.host !== connection.host)
      throw gitProviderFailed('the OAuth app of this host is not configured')
    const path = gitConnectionSecretPath(connection.workspaceId, connection.id)
    const outcome = await this.#options.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`git-conn:${connection.id}`}, 0))`
        // Another process may have renewed it while this one waited for the lock.
        const current = await this.#read(connection)
        const renewed = this.#fresh(current.data)
        if (renewed !== null) return { token: renewed }
        const refreshToken = 'refreshToken' in current.data ? current.data.refreshToken : undefined
        if (refreshToken === undefined) return { reauth: true as const }
        const tokens = await this.#options.connect(connection.host).refreshAccess(app, refreshToken)
        if ('reauth' in tokens) return { reauth: true as const }
        // A provider that renews without a new refresh token keeps the old one valid (ревью C4).
        const data: Record<string, string> = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? refreshToken,
          ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt.toISOString() } : {}),
        }
        // CAS on the version read under the lock: a writer beside the lock (a new sign-in of web)
        // wins, and this renewal is dropped instead of overwriting it. The refresh token is spent
        // already: a write Vault failed is tried again under the lock (ревью C4), or the pair is lost.
        const version = await this.#keep(connection, path, data, current.version)
        if (version === null) return { token: tokens.accessToken }
        await tx.credentialRef.updateMany({
          where: { vaultPath: path },
          data: { keyVersion: version },
        })
        return { token: tokens.accessToken }
      },
      { maxWait: 30_000, timeout: 60_000 },
    )
    if ('reauth' in outcome) {
      await this.#options.prisma.gitConnection.updateMany({
        where: { id: connection.id, state: { not: 'suspended' } },
        data: { state: 'reauth_needed', stateReason: 'reauth', checkedAt: this.#now() },
      })
      throw gitConnectionReauth()
    }
    return outcome.token
  }
}
