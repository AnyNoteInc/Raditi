import { z } from 'zod'

import { isProduction, type AppEnv } from '../app-env.ts'
import { DomainError } from '../errors.ts'
import type { RepoProviderKind } from '../ports/git-provider.ts'
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
 * Whether «Подключить GitLab.com» is offered (ПР29). Outside production — whenever Raditi's OAuth
 * app is configured. In production — only once the texts for the client of slice 84.16а are
 * published: until then the item says «Скоро». An own GitLab server and an open link do not wait.
 */
export const gitlabComPublishedInProduction = false

export function gitlabComOffered(appEnv: AppEnv, configured: boolean): boolean {
  return configured && (!isProduction(appEnv) || gitlabComPublishedInProduction)
}

/** The provider a connection of each kind reaches: data, never a comparison (rule 8). */
export const gitConnectionProviders: Readonly<Record<GitConnectionKind, RepoProviderKind>> =
  Object.freeze({ github_app: 'github', gitlab_oauth: 'gitlab', gitlab_token: 'gitlab' })

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
})

export const gitConnectionSyncPayloadSchema = z.strictObject({ connectionId: z.uuid() })
export const gitRepoInspectPayloadSchema = z.strictObject({
  connectionId: z.uuid(),
  providerRepoId: z.string().regex(/^[1-9][0-9]{0,39}$/),
})
export const gitRepoAttachPayloadSchema = z.strictObject({ projectRepositoryId: z.uuid() })

/** Why a connection is not `ok`: `git_connections.state_reason`. */
export const gitConnectionReasons = [
  'access_denied',
  'host_refused',
  'unreachable',
  'already_connected',
  'reauth',
] as const
export type GitConnectionReason = (typeof gitConnectionReasons)[number]

/** The words of a connection that is not `ok` (P-git-connect, P-git-repo-pick). */
export const gitConnectionReasonTexts = Object.freeze({
  access_denied: 'GitLab не принял токен — проверьте его права и срок',
  host_refused: 'Этот адрес недоступен: сервер должен быть в интернете по https',
  unreachable: 'Сервер не ответил — попробуйте ещё раз немного позже',
  already_connected: 'Эта учётная запись уже подключена',
  reauth: 'Нужно войти в GitLab заново',
} satisfies Record<GitConnectionReason, string>)

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
