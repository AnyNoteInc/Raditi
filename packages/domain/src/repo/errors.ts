import { DomainError } from '../errors.ts'

// The refusals of repositories (docs/plan/84-projects.md, §4.4). The English message is for the
// logs and the agent; the client reads the Russian text of the code (`repoRefusalTexts`).

/** Not a public `https` address on 443, or one the platform refuses (§4.6). */
export const gitHostRefused = (): DomainError =>
  new DomainError('GIT_HOST_REFUSED', 'The address of the git server is refused', 400)

/**
 * gitlab.com by a personal token while «Подключить GitLab.com» is not offered (docs/plan/84,
 * ПР29): the code of the client would go abroad before the documents of 84.16а.
 */
export const gitlabComTokenRefused = (): DomainError =>
  new DomainError('GIT_GITLAB_COM_TOKEN', 'gitlab.com is not connected by a token now', 400)

/** The provider refused the stored sign-in for good: the client signs in again. */
export const gitConnectionReauth = (): DomainError =>
  new DomainError('GIT_CONNECTION_REAUTH', 'The sign-in with the provider has to be renewed', 409)

export const gitConnectionInUse = (projects: readonly string[]): DomainError =>
  new DomainError('GIT_CONNECTION_IN_USE', 'Projects use this connection', 409, { projects })

/** A link the platform cannot read: not a repository address, or a host it does not know. */
export const repoLinkInvalid = (): DomainError =>
  new DomainError('REPO_LINK_INVALID', 'Not a link to a repository', 400)

/** Private and missing are never told apart. */
export const repoLinkPrivate = (): DomainError =>
  new DomainError('REPO_LINK_PRIVATE', 'The repository is private or does not exist', 409)

/** The repository could not be fetched for a pass (ПР12, «Сбой подготовки»): tried again later. */
export const repoUnreachable = (): DomainError =>
  new DomainError('REPO_UNREACHABLE', 'The repository could not be fetched', 503)

export const repoTooLarge = (): DomainError =>
  new DomainError('REPO_TOO_LARGE', 'The repository is larger than 64 MiB without history', 409)

export const repoNotAllowed = (what: 'push' | 'merge'): DomainError =>
  new DomainError('REPO_NOT_ALLOWED', `The user may not ${what} in this repository`, 403, { what })

export const repoReadOnly = (): DomainError =>
  new DomainError('REPO_READ_ONLY', 'The repository is attached read-only', 409)

/** The head moved since it was shown (a merge's `sha`, a deploy's head): show it again. */
export const repoChanged = (): DomainError =>
  new DomainError('REPO_CHANGED', 'The changes moved since they were shown', 409)

export const repoConfirmExpired = (): DomainError =>
  new DomainError('REPO_CONFIRM_EXPIRED', 'The confirmation expired', 409)

export const repoConfirmUsed = (): DomainError =>
  new DomainError('REPO_CONFIRM_USED', 'The confirmation was already used', 409)

export const repoProtectedBranch = (): DomainError =>
  new DomainError('REPO_PROTECTED_BRANCH', 'The agent never pushes to a protected branch', 409)

/**
 * A request the adapter would send outside the paths of the attached project (ПР10): refused
 * before the network. Never shown to the client: it is a defect or an attack.
 */
export const gitPathRefused = (method: string, path: string): DomainError =>
  new DomainError('GIT_PATH_REFUSED', `The git provider path is refused: ${method} ${path}`, 403)

/** What the provider does not have (`support` says so too): a defect of the caller. */
export const gitNotSupported = (what: string): DomainError =>
  new DomainError('NOT_SUPPORTED', `The git provider does not support ${what}`, 400)

/** The provider answered with something the adapter cannot use, or did not answer at all. */
export const gitProviderFailed = (detail: string, status?: number): DomainError =>
  new DomainError('GIT_PROVIDER_FAILED', `The git provider failed: ${detail}`, 502, { status })

/** The provider refused the access of the operation (401, 403). */
export const gitAccessDenied = (): DomainError =>
  new DomainError('GIT_ACCESS_DENIED', 'The git provider refused the access', 403)

/** The merge request cannot be merged now (conflicts, discussions, pipeline). */
export const repoNotMergeable = (): DomainError =>
  new DomainError('REPO_NOT_MERGEABLE', 'The merge request cannot be merged now', 409)

/** What the client reads for each refusal above (§4.4), without a final period. */
export const repoRefusalTexts = Object.freeze({
  GIT_HOST_REFUSED: 'Этот адрес недоступен: сервер должен быть в интернете по https',
  GIT_GITLAB_COM_TOKEN:
    'GitLab.com скоро можно будет подключить. Сейчас по токену подключается только свой сервер GitLab',
  GIT_CONNECTION_REAUTH: 'Нужно войти в GitLab заново',
  GIT_CONNECTION_IN_USE: 'Подключение используют проекты',
  REPO_LINK_INVALID: 'Это не ссылка на репозиторий GitHub или GitLab',
  REPO_LINK_PRIVATE:
    'Репозиторий закрытый или его нет: по ссылке агент видит только открытые репозитории',
  REPO_TOO_LARGE: 'Репозиторий больше 64 МБ без истории — агент с ним не работает',
  REPO_NOT_ALLOWED: 'У вас нет права отправлять в этот репозиторий',
  REPO_READ_ONLY: 'Репозиторий подключён только для чтения',
  REPO_CHANGED: 'Изменения обновились — посмотрите ещё раз',
  REPO_CONFIRM_EXPIRED: 'Карточка устарела — откройте её снова',
  REPO_CONFIRM_USED: 'Это уже подтверждено',
  REPO_PROTECTED_BRANCH: 'В основную и защищённые ветки агент не отправляет',
  REPO_NOT_MERGEABLE: 'Запрос на слияние сейчас нельзя принять — откройте его в репозитории',
  GIT_ACCESS_DENIED: 'Доступ к репозиторию не подтвердился — подключите его заново',
} satisfies Record<string, string>)

/** The second words of `REPO_NOT_ALLOWED` (ПР10). */
export const repoNotAllowedMergeText = 'У вас нет права принимать в эту ветку'
