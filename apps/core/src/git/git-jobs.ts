import { createHash } from 'node:crypto'

import { chatBranchHead, Prisma, type PrismaClient } from '@repo/db'
import {
  ciConfigPathOf,
  ciIncludePaths,
  DEFAULT_CI_CONFIG_PATH,
  gitConnectionProviders,
  gitConnectionReauth,
  isDomainError,
  repositoryTooLarge,
  repoUnreachable,
  mirrorLimits,
  readRepoCiPaths,
  REPO_CI_CONFIG_LINT_BYTES,
  REPO_DIFF_KEPT_BYTES,
  repoCiDiffKey,
  repoCiLintSchema,
  type GitAuth,
  type GitConnectionKind,
  type GitConnectionReason,
  type GitGrant,
  type GitProvider,
  type ObjectStorage,
  type RepoCiLint,
  type RepoCiPaths,
  type RepoProviderKind,
  type RepoRef,
  type RepositoryInfo,
} from '@repo/domain'
import { errorMessage } from '@repo/observability'

import { GIT_CREDENTIAL_TTL_SECONDS } from '../git-workspace/git-auth.ts'
import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { diffStat } from '../tasks/diff-stat.ts'
import { buildPathsOf } from './build-paths.ts'
import type { GitAuthSource } from './git-auth-source.ts'
import type { ResolvePublicHost } from './public-host.ts'

// The jobs of the queue `git` of slice 84.17 (docs/plan/84-projects.md, §4.3):
// - `git.connection.sync` — the access of a connection is checked, its account named and the
//   repositories it sees listed into `git_connection_repositories` (P-git-repo-pick);
// - `git.repo.inspect` — the branches of one of them, for «Основная ветка»;
// - `git.repo.attach` — the repository of a project: the provider's size, the first fetch by the
//   git worker under the limits, gitleaks over the main branch (a warning, never a refusal) and
//   the client's own paths of build settings (`ci_paths`: its `ci_config_path` and the files of
//   `include: local` of the main branch by CI Lint). Done — `mirror_state = 'ready'`;
// - `git.ci_lint` (slice 84.20) — the diff of the build settings of a chat's branch since its last
//   push, kept in `raditi-artifacts`, with CI Lint where the provider has it, for the card «Агент
//   хочет изменить настройки сборки» (ПР16).
// Every operation resolves the host once; the API and git connect to that very address (§4.6).

/** Pages of 50 repositories one sync reads at most (P-git-repo-pick shows what it has). */
export const GIT_SYNC_PAGES = 10
/** Branches a repository keeps for the choice (CHECK of `git_connection_repositories`). */
export const GIT_BRANCHES_KEPT = 100
/** A first fetch still `syncing` after this stopped with its core (ревью C10). */
export const REPO_SYNC_STUCK_MS = 30 * 60_000

export interface GitProviderFactory {
  (input: { kind: RepoProviderKind; host: string; address: string }): GitProvider
}

export interface GitJobsOptions {
  prisma: PrismaClient
  auth: Pick<GitAuthSource, 'grantFor'>
  resolvePublic: ResolvePublicHost
  /** An adapter whose every request of this operation goes to `address`. */
  provider: GitProviderFactory
  workspace: Pick<
    GitWorkspaceService,
    'fetch' | 'findSecrets' | 'buildSettingsChange' | 'removeOrphans'
  >
  /** Where the diff of the build settings of a branch is kept for the card (`git.ci_lint`). */
  storage?: Pick<ObjectStorage, 'put'>
  logger: { log(line: string): void; warn(line: string): void }
  now?: () => Date
}

interface ConnectionRow {
  id: string
  workspaceId: string
  kind: GitConnectionKind
  host: string
  state: string
}

const connectionSelect = {
  id: true,
  workspaceId: true,
  kind: true,
  host: true,
  state: true,
} as const

const tooLargeCodes = new Set(['REPOSITORY_TOO_LARGE', 'PUBLICATION_TOO_LARGE'])

const reasonOf = (error: unknown): GitConnectionReason => {
  if (!isDomainError(error)) return 'unreachable'
  if (error.code === 'GIT_HOST_REFUSED') return 'host_refused'
  if (error.code === 'GIT_ACCESS_DENIED') return 'access_denied'
  if (error.code === 'GIT_CONNECTION_REAUTH') return 'reauth'
  return 'unreachable'
}

/** A path of the client's own build settings, or null for one on another project or address. */
export function ownCiPath(value: string | null | undefined): string | null {
  return ciConfigPathOf(value).path
}

/** `ci_paths` with the configuration path the provider names now; its includes kept. */
const ciPathsWith = (
  current: RepoCiPaths,
  configPath: string | null | undefined,
  includes = current.includes,
): RepoCiPaths => {
  const config = ciConfigPathOf(configPath)
  return { v: 1, configPath: config.path, foreign: config.foreign, includes }
}

export class GitJobs {
  readonly #o: GitJobsOptions
  readonly #now: () => Date

  constructor(options: GitJobsOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
  }

  /** One operation on a host: its address, an adapter pinned to it and the access of a grant. */
  async #operation(kind: RepoProviderKind, host: string, grant: GitGrant) {
    const address = await this.#o.resolvePublic(host)
    const provider = this.#o.provider({ kind, host, address })
    const auth: GitAuth =
      grant.kind === 'token' ? { kind: 'bearer', token: grant.token } : { kind: 'anonymous' }
    return { address, provider, auth }
  }

  async #connection(id: string): Promise<ConnectionRow | null> {
    const row = await this.#o.prisma.gitConnection.findUnique({
      where: { id },
      select: connectionSelect,
    })
    return row === null ? null : { ...row, kind: row.kind as GitConnectionKind }
  }

  /**
   * The upkeep of the tick of `git.poll` (ревью C3, C10): a repository whose first fetch stopped
   * — its job is one attempt, a core that died left it `syncing` — is `failed` after
   * `REPO_SYNC_STUCK_MS`, so «Обновить» is offered; the mirrors and bundles of repositories that
   * are no longer a project's go from the volume. Each part fails alone.
   */
  async sweep(): Promise<{ stuck: number; removed: number }> {
    const { prisma } = this.#o
    let stuck = 0
    let removed = 0
    try {
      stuck = (
        await prisma.projectRepository.updateMany({
          where: {
            mirrorState: 'syncing',
            updatedAt: { lt: new Date(this.#now().getTime() - REPO_SYNC_STUCK_MS) },
          },
          data: { mirrorState: 'failed' },
        })
      ).count
    } catch (error) {
      this.#o.logger.warn(`git_sweep_stuck_failed ${errorMessage(error)}`)
    }
    try {
      removed = await this.#o.workspace.removeOrphans(async (ids) => {
        const rows = await prisma.projectRepository.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true },
        })
        return new Set(rows.map((row) => row.id))
      })
    } catch (error) {
      this.#o.logger.warn(`git_sweep_orphans_failed ${errorMessage(error)}`)
    }
    return { stuck, removed }
  }

  /**
   * The head of the main branch of a project's repository, fetched into its mirror for a pass
   * (docs/plan/84-projects.md, §4.3, step 3), and the brand of its provider. Throws what the pass
   * tells the client: REPOSITORY_TOO_LARGE, GIT_CONNECTION_REAUTH, or REPO_UNREACHABLE for
   * anything else — a provider that does not answer, a repository gone, a connection not `ok`.
   */
  async fetchForTurn(
    projectRepositoryId: string,
    /** The chat's branch at the client, once it was sent (ПР13): its head is fetched too. */
    chatBranch: string | null = null,
  ): Promise<{ sha: string; label: string; chatHead: string | null }> {
    const repo = await this.#o.prisma.projectRepository.findUnique({
      where: { id: projectRepositoryId },
      select: {
        provider: true,
        host: true,
        path: true,
        providerRepoId: true,
        defaultBranch: true,
        ciPaths: true,
        connection: { select: connectionSelect },
      },
    })
    if (repo === null) throw repoUnreachable()
    const ref: RepoRef = {
      provider: repo.provider as RepoProviderKind,
      host: repo.host,
      path: repo.path,
      ...(repo.providerRepoId === null ? {} : { providerRepoId: repo.providerRepoId }),
    }
    try {
      let grant: GitGrant = { kind: 'anonymous' }
      if (repo.connection !== null) {
        if (repo.connection.state === 'reauth_needed') throw gitConnectionReauth()
        if (repo.connection.state !== 'ok') throw repoUnreachable()
        grant = await this.#o.auth.grantFor({
          ...repo.connection,
          kind: repo.connection.kind as GitConnectionKind,
        })
      }
      const { address, provider, auth } = await this.#operation(ref.provider, ref.host, grant)
      const info = await provider.getRepository(auth, ref)
      if (info === null) throw repoUnreachable()
      if (info.sizeBytes !== null && info.sizeBytes > mirrorLimits.repositoryBytes)
        throw repositoryTooLarge('The provider names a repository above its limit')
      const access = await provider.issueCredentials(grant, info.ref, 'read', {
        ttlSeconds: GIT_CREDENTIAL_TTL_SECONDS,
      })
      try {
        const heads = await this.#o.workspace.fetch({
          projectRepositoryId,
          remote: { cloneUrl: info.cloneUrl, pin: { host: ref.host, address }, access },
          branches: chatBranch ? [repo.defaultBranch, chatBranch] : [repo.defaultBranch],
          sizeBytes: info.sizeBytes,
        })
        const sha = heads.get(repo.defaultBranch) ?? null
        if (sha === null) throw repoUnreachable()
        // `ci_config_path` is read at every preparation of a turn too (ПР16).
        const ciPaths = ciPathsWith(readRepoCiPaths(repo.ciPaths), info.ciConfigPath)
        await this.#o.prisma.projectRepository.updateMany({
          where: { id: projectRepositoryId },
          data: { lastFetchedSha: sha, fetchedAt: this.#now(), ciPaths },
        })
        return {
          sha,
          label: provider.support.label,
          chatHead: chatBranch ? (heads.get(chatBranch) ?? null) : null,
        }
      } finally {
        await access.revoke?.().catch(() => undefined)
      }
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      if (tooLargeCodes.has(code)) throw repositoryTooLarge()
      if (code === 'GIT_CONNECTION_REAUTH') throw gitConnectionReauth()
      if (code !== 'REPO_UNREACHABLE')
        this.#o.logger.warn(`git.turn.fetch ${projectRepositoryId}: ${code}`)
      throw repoUnreachable()
    }
  }

  /** `git.connection.sync`. */
  async syncConnection(connectionId: string): Promise<void> {
    const connection = await this.#connection(connectionId)
    if (connection === null || connection.state === 'suspended') return
    let account: { login: string; id: string }
    let items: RepositoryInfo[]
    try {
      const grant = await this.#o.auth.grantFor(connection)
      const { provider, auth } = await this.#operation(
        gitConnectionProviders[connection.kind],
        connection.host,
        grant,
      )
      account = await provider.whoAmI(auth)
      items = []
      let page: string | undefined
      for (let read = 0; read < GIT_SYNC_PAGES; read++) {
        const listed = await provider.listRepositories(auth, page)
        items.push(...listed.items)
        if (listed.next === null) break
        page = listed.next
      }
    } catch (error) {
      const reason = reasonOf(error)
      this.#o.logger.warn(`git.connection.sync ${connectionId}: ${reason}`)
      // A connection that worked keeps its state on a passing failure of the network; a refused
      // access or a new sign-in is said at once.
      if (connection.state === 'ok' && reason === 'unreachable') return
      if (reason === 'reauth') return // the auth source has set `reauth_needed`
      await this.#o.prisma.gitConnection.updateMany({
        where: { id: connectionId, state: { not: 'suspended' } },
        data: { state: 'refused', stateReason: reason, checkedAt: this.#now() },
      })
      return
    }
    const now = this.#now()
    try {
      await this.#o.prisma.$transaction(async (tx) => {
        await tx.gitConnection.update({
          where: { id: connectionId },
          data: {
            accountLogin: account.login.slice(0, 100),
            accountId: account.id,
            state: 'ok',
            stateReason: null,
            checkedAt: now,
          },
        })
        const seen = items.map((item) => item.ref.providerRepoId)
        await tx.gitConnectionRepository.deleteMany({
          where: { connectionId, providerRepoId: { notIn: seen } },
        })
        for (const item of items) {
          const fields = {
            path: item.ref.path,
            name: item.ref.path.split('/').at(-1)!.slice(0, 200),
            visibility: item.private ? 'private' : 'public',
            defaultBranch: item.defaultBranch,
            // GitLab lists the projects of a membership; the right to push is checked again
            // before every push by the provider itself (84.19).
            canPush: true,
            canHook: false,
            syncedAt: now,
          }
          await tx.gitConnectionRepository.upsert({
            where: {
              connectionId_providerRepoId: {
                connectionId,
                providerRepoId: item.ref.providerRepoId,
              },
            },
            create: { connectionId, providerRepoId: item.ref.providerRepoId, ...fields },
            update: fields,
          })
        }
      })
    } catch (error) {
      // The same account of the same server is connected already by this user (the unique key).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.#o.prisma.gitConnection.updateMany({
          where: { id: connectionId },
          data: { state: 'refused', stateReason: 'already_connected', checkedAt: now },
        })
        return
      }
      throw error
    }
  }

  /** `git.repo.inspect`. */
  async inspectRepository(connectionId: string, providerRepoId: string): Promise<void> {
    const connection = await this.#connection(connectionId)
    if (connection === null || connection.state !== 'ok') return
    const row = await this.#o.prisma.gitConnectionRepository.findUnique({
      where: { connectionId_providerRepoId: { connectionId, providerRepoId } },
      select: { path: true, defaultBranch: true },
    })
    if (row === null) return
    const grant = await this.#o.auth.grantFor(connection)
    const kind = gitConnectionProviders[connection.kind]
    const { provider, auth } = await this.#operation(kind, connection.host, grant)
    const names = await provider.listBranches(auth, {
      provider: kind,
      host: connection.host,
      path: row.path,
      providerRepoId,
    })
    const kept = [row.defaultBranch, ...names.filter((name) => name !== row.defaultBranch)].slice(
      0,
      GIT_BRANCHES_KEPT,
    )
    await this.#o.prisma.gitConnectionRepository.update({
      where: { connectionId_providerRepoId: { connectionId, providerRepoId } },
      data: { branches: kept, syncedAt: this.#now() },
    })
  }

  /** `git.repo.attach`. */
  async attachRepository(projectRepositoryId: string): Promise<void> {
    const repo = await this.#o.prisma.projectRepository.findUnique({
      where: { id: projectRepositoryId },
      select: {
        id: true,
        provider: true,
        host: true,
        path: true,
        providerRepoId: true,
        defaultBranch: true,
        connectionId: true,
        connection: { select: connectionSelect },
      },
    })
    if (repo === null) return
    const mark = (data: Prisma.ProjectRepositoryUpdateInput) =>
      this.#o.prisma.projectRepository.updateMany({
        where: { id: projectRepositoryId },
        data: data as Prisma.ProjectRepositoryUpdateManyMutationInput,
      })
    const ref: RepoRef = {
      provider: repo.provider as RepoProviderKind,
      host: repo.host,
      path: repo.path,
      ...(repo.providerRepoId === null ? {} : { providerRepoId: repo.providerRepoId }),
    }
    try {
      let grant: GitGrant = { kind: 'anonymous' }
      if (repo.connection !== null) {
        if (repo.connection.state !== 'ok') {
          await mark({ mirrorState: 'failed' })
          return
        }
        grant = await this.#o.auth.grantFor({
          ...repo.connection,
          kind: repo.connection.kind as GitConnectionKind,
        })
      }
      const { address, provider, auth } = await this.#operation(ref.provider, ref.host, grant)
      const info = await provider.getRepository(auth, ref)
      // By a link: private and missing are one answer (REPO_LINK_PRIVATE); by a connection the
      // repository went away from what it sees.
      if (info === null) {
        await mark({ mirrorState: repo.connection === null ? 'unreachable' : 'failed' })
        return
      }
      const branch = repo.connection === null ? info.defaultBranch : repo.defaultBranch
      await mark({
        providerRepoId: info.ref.providerRepoId,
        defaultBranch: branch,
        webUrl: info.webUrl,
      })
      if (info.sizeBytes !== null && info.sizeBytes > mirrorLimits.repositoryBytes) {
        await mark({ mirrorState: 'too_large' })
        return
      }
      const access = await provider.issueCredentials(grant, info.ref, 'read', {
        ttlSeconds: GIT_CREDENTIAL_TTL_SECONDS,
      })
      try {
        const heads = await this.#o.workspace.fetch({
          projectRepositoryId,
          remote: { cloneUrl: info.cloneUrl, pin: { host: ref.host, address }, access },
          branches: [branch],
          sizeBytes: info.sizeBytes,
        })
        const sha = heads.get(branch) ?? null
        if (sha === null) {
          await mark({ mirrorState: 'failed' })
          return
        }
        const secrets = await this.#o.workspace.findSecrets(projectRepositoryId, sha)
        const own = ciPathsWith(readRepoCiPaths(null), info.ciConfigPath)
        const includes = own.foreign
          ? []
          : await this.#mainIncludes(provider, auth, info.ref, {
              projectRepositoryId,
              sha,
              branch,
              configPath: own.configPath ?? DEFAULT_CI_CONFIG_PATH,
            })
        await mark({
          mirrorState: 'ready',
          lastFetchedSha: sha,
          fetchedAt: this.#now(),
          secretsFound: secrets.map((path) => ({ path, rule: 'gitleaks' })),
          ciPaths: { ...own, includes },
        })
      } finally {
        await access.revoke?.().catch(() => undefined)
      }
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      this.#o.logger.warn(`git.repo.attach ${projectRepositoryId}: ${code}`)
      await mark({
        mirrorState: tooLargeCodes.has(code) ? 'too_large' : 'failed',
      })
    }
  }

  /**
   * The files of `include: local` of the configuration of the main branch, by CI Lint where the
   * provider has it (ПР16). Never fails the attachment: no lint — no includes.
   */
  async #mainIncludes(
    provider: GitProvider,
    auth: GitAuth,
    ref: RepoRef,
    at: { projectRepositoryId: string; sha: string; branch: string; configPath: string },
  ): Promise<string[]> {
    if (!provider.support.ciLint || !provider.lintCi) return []
    try {
      const { config } = await this.#o.workspace.buildSettingsChange({
        projectRepositoryId: at.projectRepositoryId,
        from: at.sha,
        to: at.sha,
        isBuildPath: () => false,
        maxBytes: 1,
        configPath: at.configPath,
        configBytes: REPO_CI_CONFIG_LINT_BYTES,
      })
      if (config === null) return []
      const lint = await provider.lintCi(auth, ref, config.toString('utf8'), at.branch)
      return ciIncludePaths(lint.includes)
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      this.#o.logger.warn(`git.repo.attach ${at.projectRepositoryId}: lint ${code}`)
      return []
    }
  }

  /**
   * `git.ci_lint` (ПР16): the change of build settings of the chat's branch at `headSha` since what
   * the client was last sent (or since its base), its diff in `raditi-artifacts`, CI Lint of its
   * configuration where the provider has it — its `include: local` files join the build paths —
   * and the result in `project_repo_branches.ci_lint`. A job of another head does nothing. A lint
   * that fails leaves `lint: null`: the card shows the diff without it.
   */
  async lintBranch(taskId: string, headSha: string): Promise<void> {
    const { prisma, workspace, storage } = this.#o
    const branch = await prisma.projectRepoBranch.findUnique({
      where: { taskId },
      select: {
        projectRepositoryId: true,
        branch: true,
        baseSha: true,
        mirrorSha: true,
        remoteSha: true,
        ciLint: true,
      },
    })
    if (branch === null) return
    if ((await chatBranchHead(prisma, taskId))?.headSha !== headSha) return
    const done = repoCiLintSchema.safeParse(branch.ciLint)
    if (done.success && done.data.headSha === headSha) return
    const repo = await prisma.projectRepository.findUnique({
      where: { id: branch.projectRepositoryId },
      select: {
        provider: true,
        host: true,
        path: true,
        providerRepoId: true,
        defaultBranch: true,
        ciPaths: true,
        connection: { select: connectionSelect },
      },
    })
    if (repo === null) return
    const ci = readRepoCiPaths(repo.ciPaths)
    const configPath = ci.configPath ?? DEFAULT_CI_CONFIG_PATH
    const fromSha = branch.mirrorSha ?? branch.baseSha
    const change = (includes: readonly string[]) =>
      workspace.buildSettingsChange({
        projectRepositoryId: branch.projectRepositoryId,
        from: fromSha,
        to: headSha,
        isBuildPath: buildPathsOf(repo, includes),
        maxBytes: REPO_DIFF_KEPT_BYTES,
        configPath,
        configBytes: REPO_CI_CONFIG_LINT_BYTES,
      })
    let found = await change([])
    let lint: RepoCiLint['lint'] = null
    let includes: string[] = []
    if (found.config !== null && !ci.foreign && repo.connection?.state === 'ok') {
      try {
        const kind = gitConnectionProviders[repo.connection.kind as GitConnectionKind]
        const grant = await this.#o.auth.grantFor({
          ...repo.connection,
          kind: repo.connection.kind as GitConnectionKind,
        })
        const { provider, auth } = await this.#operation(kind, repo.host, grant)
        if (provider.support.ciLint && provider.lintCi) {
          const ref: RepoRef = {
            provider: kind,
            host: repo.host,
            path: repo.path,
            ...(repo.providerRepoId === null ? {} : { providerRepoId: repo.providerRepoId }),
          }
          // A branch never sent is not at the client yet: the lint runs on the main branch.
          const result = await provider.lintCi(
            auth,
            ref,
            found.config.toString('utf8'),
            branch.remoteSha !== null ? branch.branch : repo.defaultBranch,
          )
          lint = { valid: result.valid, errors: result.errors.map((e) => e.slice(0, 1000)) }
          includes = ciIncludePaths(result.includes)
          if (includes.some((path) => !ci.includes.includes(path))) found = await change(includes)
        }
      } catch (error) {
        const code = isDomainError(error) ? error.code : 'unknown'
        this.#o.logger.warn(`git.ci_lint ${taskId}: lint ${code}`)
      }
    }
    const patch = found.patch
    const ciDiffSha256 =
      patch === null || found.paths.length === 0
        ? null
        : createHash('sha256').update(patch).digest('hex')
    if (patch !== null && patch.byteLength > 0) {
      if (!storage) throw new Error('git.ci_lint needs the storage of artifacts')
      await storage.put('artifacts', repoCiDiffKey(taskId, headSha), patch, {
        contentType: 'text/x-diff',
        sizeBytes: patch.byteLength,
      })
    }
    const files =
      patch === null
        ? found.paths.map((path) => ({ path, additions: 0, deletions: 0 }))
        : diffStat(patch)
    const row: RepoCiLint = {
      v: 1,
      headSha,
      fromSha,
      ciDiffSha256,
      files: files.slice(0, 50).map((file) => ({ ...file, path: file.path.slice(0, 4096) })),
      tooLarge: patch === null,
      lint,
      includes,
      declined: false,
    }
    await prisma.projectRepoBranch.updateMany({
      where: { taskId },
      data: { ciLint: row, ciDiffSha256 },
    })
  }
}
