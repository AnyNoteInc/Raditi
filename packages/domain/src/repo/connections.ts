import { z } from 'zod'

import { isProduction, type AppEnv } from '../app-env.ts'
import { DomainError } from '../errors.ts'
import type { RepoProviderKind } from '../ports/git-provider.ts'
import { repoRefusalTexts } from './errors.ts'
import { gitHostSchema } from './ref.ts'
import type { GitConnectionKind } from './statuses.ts'

// The git connections of a user and the jobs of the queue `git` (docs/plan/84-projects.md, ПР10,
// §4.2, §4.3; slice 84.17). A connection acts in the name of the one who made it: only they see,
// bind and use it. Its tokens live in Vault, written by web and never read back by it; core reads
// and renews them.

export const gitConnectionLimits = Object.freeze({
  /** Connections of one workspace, of all its users together (§4.1). */
  perWorkspace: 10,
  /** A token of an own GitLab server, as the form takes it. */
  tokenChars: 512,
})

/**
 * Whether the code of a client may go, in production, to a code host abroad the client picks:
 * gitlab.com (GitLab Inc., USA) and github.com (GitHub Inc., USA) — ПР29, slice 84.16а. The
 * documents of the edition 2026-11-17 name both recipients; the transfer itself starts only after
 * the owner, the operator, has filed the notice of art. 12 of 152-FZ for the USA and its ten working
 * days have passed (the USA is not on the list of RKN order No. 253, so part 11 of art. 12 holds the
 * transfer until then). One flag for both: one notice and one edition cover both recipients. The
 * owner turns it on once they confirm the filing (docs/plan/84-projects.md, §10, «Действия
 * владельца»; apps/web/content/legal/README.md, «Уведомление по ст. 12 о передаче кода в США»).
 * An own GitLab server and an open link never wait on it.
 */
export const codeHostsAbroadPublishedInProduction = false

/**
 * Whether a code host abroad is offered: Raditi's app for it is configured, and in production the
 * flag above is on. Outside production a stand's fake stands in for gitlab.com and github.com.
 */
function codeHostAbroadOffered(appEnv: AppEnv, configured: boolean): boolean {
  return configured && (!isProduction(appEnv) || codeHostsAbroadPublishedInProduction)
}

/**
 * Whether «Подключить GitLab.com» is offered (ПР29): Raditi's OAuth app is configured and the gate
 * of code hosts abroad is open; until then the item says «Скоро».
 */
export function gitlabComOffered(appEnv: AppEnv, configured: boolean): boolean {
  return codeHostAbroadOffered(appEnv, configured)
}

/**
 * Whether «Подключить GitHub» is offered (ПР10, ПР29, ПР31; slices 84.25 and 84.16а): Raditi's GitHub
 * App is configured — on the server its group of secrets is rendered only when all its fields are
 * set (infra/server/README.md, «Репозитории проектов») — and the gate of code hosts abroad is open;
 * until then the item says «Скоро».
 */
export function githubOffered(appEnv: AppEnv, configured: boolean): boolean {
  return codeHostAbroadOffered(appEnv, configured)
}

/** The provider a connection of each kind reaches: data, never a comparison (rule 8). */
export const gitConnectionProviders: Readonly<Record<GitConnectionKind, RepoProviderKind>> =
  Object.freeze({ github_app: 'github', gitlab_oauth: 'gitlab', gitlab_token: 'gitlab' })

/**
 * Which kinds of connection are a sign-in on the provider's page (OAuth): the window that comes
 * back from it picks the newest of them (rule 8: a table, never a comparison of the kind).
 */
export const gitConnectionSignsIn: Readonly<Record<GitConnectionKind, boolean>> = Object.freeze({
  github_app: true,
  gitlab_oauth: true,
  gitlab_token: false,
})

/** The name and the icon of each provider the client reads (rule 8: data, never a comparison). */
export const repoProviderBrands: Readonly<
  Record<RepoProviderKind, Readonly<{ label: string; icon: 'github' | 'gitlab' }>>
> = Object.freeze({
  github: Object.freeze({ label: 'GitHub', icon: 'github' }),
  gitlab: Object.freeze({ label: 'GitLab', icon: 'gitlab' }),
})

/**
 * «Нужно войти в GitLab заново», «Нужно войти в GitHub заново»: the sign-in of a connection is to be
 * renewed. The brand comes from `repoProviderBrands` (rule 8: data, never a comparison); null —
 * the provider is not known where the words are said (a code of a press, a line of the feed, a run
 * of a scheduled task): neutral words.
 */
export function repoReauthText(provider: RepoProviderKind | null): string {
  return provider === null
    ? repoRefusalTexts.GIT_CONNECTION_REAUTH
    : `Нужно войти в ${repoProviderBrands[provider].label} заново`
}

/** Where the tokens of a connection live: one version, CAS (§4.2). */
export const gitConnectionSecretPath = (workspaceId: string, connectionId: string): string =>
  `kv/workspaces/${workspaceId}/git/${connectionId}`

/**
 * The tokens as Vault keeps them: an OAuth pair of gitlab.com (`expiresAt` — ISO, absent when the
 * provider names none) or the token of an own server. Strings only: KV data is a map of strings.
 */
export const gitConnectionSecretSchema = z.union([
  z.strictObject({
    accessToken: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(4096).optional(),
    expiresAt: z.iso.datetime().optional(),
  }),
  z.strictObject({ token: z.string().min(1).max(gitConnectionLimits.tokenChars) }),
])
export type GitConnectionSecret = z.infer<typeof gitConnectionSecretSchema>

/** A token as the form of an own GitLab server takes it: printable, one word. */
export const gitTokenInputSchema = z
  .string()
  .trim()
  .min(8)
  .max(gitConnectionLimits.tokenChars)
  .regex(/^[\x21-\x7e]+$/, 'One word of printable characters')

/** The host of an own GitLab server as the form takes it: `git.example.ru` or its https address. */
export function gitServerHostOf(input: string): string | null {
  const text = input.trim().toLowerCase()
  let host = text
  if (text.includes('/') || text.includes(':')) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return null
    }
    if (
      url.protocol !== 'https:' ||
      (url.port !== '' && url.port !== '443') ||
      url.username !== '' ||
      url.password !== '' ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search !== '' ||
      url.hash !== ''
    )
      return null
    host = url.hostname
  }
  return gitHostSchema.safeParse(host).success ? host : null
}

// --- the queue `git` (§4.3) -------------------------------------------------------------------

export const gitJobNames = Object.freeze({
  connectionSync: 'git.connection.sync',
  repoInspect: 'git.repo.inspect',
  repoAttach: 'git.repo.attach',
  /** A row of `repo_actions` a button of the client wrote (ПР13, ПР15; slice 84.19). */
  action: 'git.action',
  /** The diff of the build settings of a chat's branch and its CI Lint (ПР16; slice 84.20). */
  ciLint: 'git.ci_lint',
  /** The tick of the poll of builds and merge requests, or one repository (ПР17; slice 84.21). */
  poll: 'git.poll',
  /** The tail of the log of a job (ПР17; slice 84.21). */
  log: 'git.log',
  /** The manual jobs of the head of the default branch (ПР15, ПР17; slice 84.21). */
  deployActions: 'git.repo.deploy_actions',
  /**
   * The mirror and the bundles of a repository whose row is gone — detached, or its project purged:
   * written in the transaction that deleted the row (docs/plan/84-projects.md, ПР20, §4.2).
   */
  repoForget: 'git.repo.forget',
  /** A hint of a webhook: core reads the repository again (ПР17; slice 84.26). */
  refresh: 'git.refresh',
  /** The hook of a GitLab project, created by its connection when it may (ПР17; slice 84.26). */
  hookCreate: 'git.hook.create',
  /** The hook of a repository whose row is gone, removed at the provider (slice 84.26). */
  hookRemove: 'git.hook.remove',
  /** The paths of the main branch for `@` (ПР24; slice 84.26). */
  repoTree: 'git.repo.tree',
})

export const gitConnectionSyncPayloadSchema = z.strictObject({ connectionId: z.uuid() })
export const gitRepoInspectPayloadSchema = z.strictObject({
  connectionId: z.uuid(),
  providerRepoId: z.string().regex(/^[1-9][0-9]{0,39}$/),
})
export const gitRepoAttachPayloadSchema = z.strictObject({ projectRepositoryId: z.uuid() })
export const gitRepoForgetPayloadSchema = z.strictObject({ projectRepositoryId: z.uuid() })

/** Why a connection is not `ok`: `git_connections.state_reason`. */
export const gitConnectionReasons = [
  'access_denied',
  'host_refused',
  'unreachable',
  'already_connected',
  'reauth',
  /** The GitHub App was removed from the account or suspended there (the `installation` webhook). */
  'installation_gone',
] as const
export type GitConnectionReason = (typeof gitConnectionReasons)[number]

/**
 * The words of a connection that is not `ok` (P-git-connect, P-git-repo-pick), by the kind of the
 * connection: its provider names the brand, and a connection by a token is told to check the
 * token, one by a sign-in to connect again (rule 8: tables, never a comparison of the kind). null
 * — the kind is not known: neutral words.
 */
export function gitConnectionReasonText(
  reason: GitConnectionReason,
  kind: GitConnectionKind | null,
): string {
  switch (reason) {
    case 'access_denied': {
      if (kind === null) return repoRefusalTexts.GIT_ACCESS_DENIED
      const brand = repoProviderBrands[gitConnectionProviders[kind]].label
      return gitConnectionSignsIn[kind]
        ? `${brand} не дал доступ — подключите ${brand} заново`
        : `${brand} не принял токен — проверьте его права и срок`
    }
    case 'reauth':
      return repoReauthText(kind === null ? null : gitConnectionProviders[kind])
    case 'host_refused':
      return 'Этот адрес недоступен: сервер должен быть в интернете по https'
    case 'unreachable':
      return 'Сервер не ответил — попробуйте ещё раз немного позже'
    case 'already_connected':
      return 'Эта учётная запись уже подключена'
    // Only an installation of the GitHub App comes to it (the `installation` webhook, 84.27).
    case 'installation_gone':
      return 'Приложение Радити на GitHub удалено или приостановлено — подключите GitHub заново'
  }
}

export const isGitConnectionReason = (reason: string): reason is GitConnectionReason =>
  (gitConnectionReasons as readonly string[]).includes(reason)

// --- refusals ---------------------------------------------------------------------------------

export const gitConnectionNotFound = (): DomainError =>
  new DomainError('GIT_CONNECTION_NOT_FOUND', 'No such connection of this user', 404)

export const gitConnectionLimit = (): DomainError =>
  new DomainError('GIT_CONNECTION_LIMIT', 'The workspace has its most connections', 409)

export const gitConnectionNotReady = (): DomainError =>
  new DomainError('GIT_CONNECTION_NOT_READY', 'The connection is not checked yet', 409)

export const gitConnectUnavailable = (): DomainError =>
  new DomainError('GIT_CONNECT_UNAVAILABLE', 'Connecting a repository is off here', 503)

export const projectHasRepository = (): DomainError =>
  new DomainError('PROJECT_HAS_REPOSITORY', 'The project has a repository already', 409)

export const repoNotInConnection = (): DomainError =>
  new DomainError('REPO_NOT_IN_CONNECTION', 'The connection does not see this repository', 404)

/** What the client reads for each refusal above, without a final period. */
export const gitConnectionRefusalTexts = Object.freeze({
  GIT_CONNECTION_NOT_FOUND: 'Подключения нет — подключите репозиторий заново',
  GIT_CONNECTION_LIMIT: `Подключений уже ${gitConnectionLimits.perWorkspace} — отключите ненужное`,
  GIT_CONNECTION_NOT_READY: 'Подключение ещё проверяется — подождите несколько секунд',
  GIT_CONNECT_UNAVAILABLE: 'Подключить репозиторий сейчас нельзя — попробуйте позже',
  PROJECT_HAS_REPOSITORY: 'У проекта уже есть репозиторий — сначала отключите его',
  REPO_NOT_IN_CONNECTION: 'Этого репозитория нет в подключении — обновите список',
} satisfies Record<string, string>)
