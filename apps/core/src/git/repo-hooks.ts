import { randomBytes } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import {
  gitConnectionProviders,
  GIT_WEBHOOK_DELIVERY_KEEP_MS,
  isDomainError,
  type GitAuth,
  type GitConnectionKind,
  type GitHookRemovePayload,
  type GitProvider,
  type RepoProviderKind,
  type RepoRef,
} from '@repo/domain'
import { gitlabHookKeyId, gitlabHookSecrets } from '@repo/git-providers/webhooks'

import type { GitAuthSource } from './git-auth-source.ts'
import { openGitOperation, type GitProviderFactory } from './git-operation.ts'
import type { ResolvePublicHost } from './public-host.ts'

// The hooks of the repositories of projects (docs/plan/84-projects.md, ПР17, §4.3; slice 84.26):
// - `git.hook.create` — a project hook on a GitLab project, by the repository's own connection and
//   only when its user is a Maintainer there (GitLab requires it); push, merge request and pipeline
//   events go to `POST <APP_URL>/api/webhooks/gitlab?r=<id>`. Its token and signing token are
//   derived from REPO_CONFIRM_SECRET and a nonce of the row, never stored; GitLab ≥ 19.0 signs every
//   delivery (`webhook-signature`), and a hook it said it signs is refused unsigned by web;
// - `git.hook.remove` — the hook of a repository whose row is gone (detached, purged), by what the
//   row held;
// - the tick — the repositories with a connection whose hook was never tried, or made by another
//   root secret (rotated), get `git.hook.create`; delivery ids past their seven days go.
// A hook is only a hint: everything still works by the poll when there is none.

/** Repositories one tick tries a hook for at most. */
const HOOKS_PER_TICK = 5
/** A hook whose job stopped before it wrote a state is tried again this much later. */
const HOOK_PENDING_RETRY_MS = 10 * 60_000
/** A failed or refused hook is tried again this much later (a new role, a server that came back). */
const HOOK_RETRY_MS = 24 * 60 * 60_000

export interface RepoHooksOptions {
  prisma: PrismaClient
  auth: Pick<GitAuthSource, 'grantFor'>
  resolvePublic: ResolvePublicHost
  provider: GitProviderFactory
  /** REPO_CONFIRM_SECRET: the root the hooks' secrets are derived from; null — no hooks. */
  rootSecret: string | null
  /** APP_URL: where GitLab sends; only `https://` — a hook on another scheme is never made. */
  appUrl: string
  logger: { log(line: string): void; warn(line: string): void }
  now?: () => Date
}

const connectionSelect = {
  id: true,
  workspaceId: true,
  kind: true,
  host: true,
  state: true,
  installationId: true,
} as const

export class RepoHooks {
  readonly #o: RepoHooksOptions
  readonly #now: () => Date

  constructor(options: RepoHooksOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
  }

  /** Whether hooks are made here at all: a root secret and a public https address. */
  get enabled(): boolean {
    return (
      this.#o.rootSecret !== null && /^https:\/\/[^/]+$/.test(this.#o.appUrl.replace(/\/$/, ''))
    )
  }

  /** `git.hook.create`. A hook there already, made by this root secret, is kept. */
  async create(projectRepositoryId: string): Promise<void> {
    const { prisma } = this.#o
    const root = this.#o.rootSecret
    if (root === null || !this.enabled) return
    const repo = await prisma.projectRepository.findUnique({
      where: { id: projectRepositoryId },
      select: {
        id: true,
        provider: true,
        host: true,
        path: true,
        providerRepoId: true,
        mirrorState: true,
        hookId: true,
        hookKeyId: true,
        connection: { select: connectionSelect },
      },
    })
    if (repo === null || repo.connection === null || repo.providerRepoId === null) return
    if (repo.connection.state !== 'ok') return
    const keyId = gitlabHookKeyId(root)
    if (repo.hookId !== null && repo.hookKeyId === keyId) return
    const connectionKind = repo.connection.kind as GitConnectionKind
    const kind: RepoProviderKind = gitConnectionProviders[connectionKind]
    const ref: RepoRef = {
      provider: kind,
      host: repo.host,
      path: repo.path,
      providerRepoId: repo.providerRepoId,
    }
    const mark = (state: 'failed' | 'not_allowed') =>
      prisma.projectRepository.updateMany({
        where: { id: repo.id, hookId: null },
        data: { hookState: state, hookCheckedAt: this.#now() },
      })
    const grant = await this.#o.auth.grantFor({ ...repo.connection, kind: connectionKind })
    const op = await openGitOperation(this.#o, {
      kind,
      host: repo.host,
      grant,
      repo: ref,
      access: 'write',
    })
    try {
      const { provider, auth } = op
      // GitHub has one webhook of the app for every installation: no hook of a repository.
      if (!provider.support.projectHooks || !provider.createHook) return
      const info = await provider.getRepository(auth, ref)
      if (info === null) {
        await mark('failed')
        return
      }
      if (info.canManageHooks !== true) {
        await mark('not_allowed')
        return
      }
      // The hook of another root secret goes first: its deliveries would be refused.
      if (repo.hookId !== null) await this.#delete(provider, auth, ref, repo.hookId)
      const nonce = randomBytes(16).toString('hex')
      const secrets = gitlabHookSecrets(root, repo.id, nonce)
      const url = `${this.#o.appUrl.replace(/\/$/, '')}/api/webhooks/gitlab?r=${repo.id}`
      const hook = await provider.createHook(auth, ref, {
        url,
        token: secrets.token,
        signingToken: secrets.signingToken,
      })
      const kept = await prisma.projectRepository.updateMany({
        where: { id: repo.id, hookId: repo.hookId },
        data: {
          hookId: hook.hookId,
          hookState: 'active',
          hookSigned: hook.signed,
          hookNonce: nonce,
          hookKeyId: secrets.keyId,
          hookCheckedAt: this.#now(),
        },
      })
      // Another delivery of this job made one first, or the row went: this one goes.
      if (kept.count === 0) await this.#delete(provider, auth, ref, hook.hookId)
      else this.#o.logger.log(`git.hook.create ${repo.id}: ${hook.signed ? 'signed' : 'token'}`)
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      this.#o.logger.warn(`git.hook.create ${projectRepositoryId}: ${code}`)
      await mark(code === 'GIT_ACCESS_DENIED' ? 'not_allowed' : 'failed')
    } finally {
      await op.close()
    }
  }

  /** `git.hook.remove`: by the connection the row named; a connection gone leaves the hook. */
  async remove(payload: GitHookRemovePayload): Promise<void> {
    const connection = await this.#o.prisma.gitConnection.findUnique({
      where: { id: payload.connectionId },
      select: connectionSelect,
    })
    if (connection === null || connection.state !== 'ok') return
    const connectionKind = connection.kind as GitConnectionKind
    const kind = gitConnectionProviders[connectionKind]
    const ref: RepoRef = {
      provider: kind,
      host: payload.host,
      path: payload.path,
      providerRepoId: payload.providerRepoId,
    }
    const grant = await this.#o.auth.grantFor({ ...connection, kind: connectionKind })
    const op = await openGitOperation(this.#o, {
      kind,
      host: payload.host,
      grant,
      repo: ref,
      access: 'write',
    })
    try {
      await this.#delete(op.provider, op.auth, ref, payload.hookId)
    } finally {
      await op.close()
    }
  }

  async #delete(provider: GitProvider, auth: GitAuth, ref: RepoRef, hookId: string): Promise<void> {
    await provider.deleteHook?.(auth, ref, hookId).catch((error: unknown) => {
      const code = isDomainError(error) ? error.code : 'unknown'
      this.#o.logger.warn(`git.hook.remove ${hookId}: ${code}`)
    })
  }

  /**
   * The tick of `git.poll`: delivery ids past GIT_WEBHOOK_DELIVERY_KEEP_MS go; repositories of a
   * GitLab connection with no hook tried (or tried a day ago and failed), or a hook of another root
   * secret, are tried. Returns the ids tried.
   */
  async tick(): Promise<{ purged: number; tried: string[] }> {
    const { prisma } = this.#o
    const now = this.#now()
    const { count: purged } = await prisma.gitWebhookDelivery.deleteMany({
      where: { receivedAt: { lt: new Date(now.getTime() - GIT_WEBHOOK_DELIVERY_KEEP_MS) } },
    })
    const root = this.#o.rootSecret
    if (root === null || !this.enabled) return { purged, tried: [] }
    const keyId = gitlabHookKeyId(root)
    const due = await prisma.projectRepository.findMany({
      where: {
        provider: 'gitlab',
        mirrorState: 'ready',
        providerRepoId: { not: null },
        connection: { state: 'ok' },
        OR: [
          {
            hookState: null,
            OR: [
              { hookCheckedAt: null },
              { hookCheckedAt: { lt: new Date(now.getTime() - HOOK_PENDING_RETRY_MS) } },
            ],
          },
          {
            hookState: { in: ['failed', 'not_allowed'] },
            hookCheckedAt: { lt: new Date(now.getTime() - HOOK_RETRY_MS) },
          },
          { hookState: 'active', hookKeyId: { not: keyId } },
        ],
      },
      orderBy: { hookCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: HOOKS_PER_TICK,
      select: { id: true },
    })
    const tried: string[] = []
    for (const repo of due) {
      // Marked first: a repository whose job fails before it writes is not tried every tick.
      await prisma.projectRepository.updateMany({
        where: { id: repo.id },
        data: { hookCheckedAt: now },
      })
      await this.create(repo.id).catch((error: unknown) => {
        const code = isDomainError(error) ? error.code : 'unknown'
        this.#o.logger.warn(`git.hook.create ${repo.id}: ${code}`)
      })
      tried.push(repo.id)
    }
    return { purged, tried }
  }
}
