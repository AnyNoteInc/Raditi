import type {
  ChecksState,
  CiStatus,
  GitProviderSupport,
  PullRequestState,
} from '../ports/git-provider.ts'

// The states of a project repository and their Russian words (docs/plan/84-projects.md, ПР3,
// §4.1, §4.8). Git words are Russian with the brand: «репозиторий», «ветка», «запрос на слияние»,
// «сборка». Names of stages and jobs stay as the client's configuration writes them.

/** `project_repositories.mirror_state` (§4.1). */
export const repoMirrorStates = ['syncing', 'ready', 'too_large', 'unreachable', 'failed'] as const
export type RepoMirrorState = (typeof repoMirrorStates)[number]

export const repoMirrorStateWords = Object.freeze({
  syncing: 'Получаем репозиторий',
  ready: 'Репозиторий подключён',
  too_large: 'Репозиторий больше 64 МБ без истории — агент с ним не работает',
  unreachable: 'Репозиторий недоступен — проверим ещё раз позже',
  failed: 'Не удалось получить репозиторий',
} satisfies Record<RepoMirrorState, string>)

/** `project_repositories.mode` (ПР9). */
export const repoModes = ['read', 'write'] as const
export type RepoMode = (typeof repoModes)[number]

export const repoModeWords = Object.freeze({
  read: 'только чтение',
  write: 'чтение и запись',
} satisfies Record<RepoMode, string>)

/** `project_repo_branches.state` (ПР13). */
export const repoBranchStates = ['local', 'pushed', 'merged', 'closed'] as const
export type RepoBranchState = (typeof repoBranchStates)[number]

export const repoBranchStateWords = Object.freeze({
  local: 'Изменения в Радити',
  pushed: 'Отправлено в ветку',
  merged: 'Принято в основную ветку',
  closed: 'Запрос на слияние закрыт',
} satisfies Record<RepoBranchState, string>)

export const pullRequestStates = ['open', 'draft', 'merged', 'closed'] as const

export const pullRequestStateWords = Object.freeze({
  open: 'открыт',
  draft: 'черновик',
  merged: 'принят в основную ветку',
  closed: 'закрыт',
} satisfies Record<PullRequestState, string>)

export const checksStates = ['none', 'pending', 'success', 'failure'] as const

export const checksStateWords = Object.freeze({
  none: 'сборки нет',
  pending: 'сборка идёт',
  success: 'сборка прошла',
  failure: 'сборка не прошла',
} satisfies Record<ChecksState, string>)

/**
 * The word of a pipeline or of one of its jobs (owner's answer of 15.11.2026, §8, question 11; the
 * words of ПР17).
 */
export const ciStatusWords = Object.freeze({
  pending: 'Ждёт запуска',
  running: 'Идёт',
  manual: 'Ждёт ручного запуска',
  success: 'Прошла',
  failed: 'Упала',
  canceled: 'Отменена',
  skipped: 'Пропущена',
} satisfies Record<CiStatus, string>)

/** A run that may still change; a finished one is not polled again (§4.3, `git.poll`). */
export function ciStatusIsActive(status: CiStatus): boolean {
  return status === 'pending' || status === 'running'
}

/** The checks of a merge request, from the status of its newest pipeline. */
export function checksOf(status: CiStatus | null): ChecksState {
  if (status === null || status === 'skipped' || status === 'manual') return 'none'
  if (status === 'success') return 'success'
  if (status === 'failed' || status === 'canceled') return 'failure'
  return 'pending'
}

/**
 * How the client reads the number of a merge request: `!37` on GitLab, `#37` on GitHub — the
 * adapter writes it (ПР3, ПР11), the core never compares the kind.
 */
export function mergeRequestLabel(
  support: Pick<GitProviderSupport, 'requestRef'>,
  number: number,
): string {
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError('Not a request number')
  return support.requestRef(number)
}

/** `git_connections.kind` (ПР10): the GitHub App, the OAuth app on gitlab.com, a token of a server. */
export const gitConnectionKinds = ['github_app', 'gitlab_oauth', 'gitlab_token'] as const
export type GitConnectionKind = (typeof gitConnectionKinds)[number]

/** `git_connections.state` (ПР10): `suspended` — the one who connected it left the workspace. */
export const gitConnectionStates = [
  'checking',
  'ok',
  'reauth_needed',
  'refused',
  'suspended',
] as const
export type GitConnectionState = (typeof gitConnectionStates)[number]

/** `git_connection_repositories.visibility`. */
export const gitRepoVisibilities = ['public', 'internal', 'private'] as const
export type GitRepoVisibility = (typeof gitRepoVisibilities)[number]
