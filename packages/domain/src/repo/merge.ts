import { z } from 'zod'

import { DomainError } from '../errors.ts'
import type { RepoProviderKind } from '../ports/git-provider.ts'

// «Принять в основную ветку» and «Выкатить» (docs/plan/84-projects.md, ПР15, §4.4; slice 84.22):
// only by a trusted card of the client — never by the agent and never by a run without a person
// (ПР19). A merge is bound to the merge request, its target branch and its head; a deploy is a
// manual job of the head of the main branch, which core reads again before it plays it. The
// platform promises no rollback: «Отменить можно новым запросом на слияние».

/** «Принять в основную ветку» — now; «Принять, когда сборка пройдёт» — GitLab `auto_merge`. */
export const repoMergeModes = ['now', 'when_green'] as const
export type RepoMergeMode = (typeof repoMergeModes)[number]

/** What the client chose on the card of a merge: kept in `repo_actions.args.merge`. */
export const repoMergeArgsSchema = z.strictObject({
  mode: z.enum(repoMergeModes),
  /** «Удалить ветку … после принятия» — on by default (ПР15). */
  deleteBranch: z.boolean(),
})
export type RepoMergeArgs = z.infer<typeof repoMergeArgsSchema>

/**
 * What a card may offer of a provider before core reaches its adapter (web never does): the same
 * values as `support.autoMerge` and `support.manualJobs` of the adapters — a table by kind, not a
 * comparison of the kind (rule 8); a test of `@repo/git-providers` holds them equal.
 */
export const repoProviderOffers: Readonly<
  Record<RepoProviderKind, { readonly autoMerge: boolean; readonly manualJobs: boolean }>
> = Object.freeze({
  github: Object.freeze({ autoMerge: false, manualJobs: false }),
  gitlab: Object.freeze({ autoMerge: true, manualJobs: true }),
})

// --- refusals ---------------------------------------------------------------------------------

/** The merge request leads into another branch than the card showed (ПР15): nothing is merged. */
export const repoMergeTargetChanged = (): DomainError =>
  new DomainError('REPO_MR_TARGET_CHANGED', 'The target branch of the merge request changed', 409)

/**
 * The head of a chat's merge request is not the commit Радити sent (ревью, безопасность 4):
 * someone pushed to the branch since, and the client never saw those commits on the card.
 */
export const repoForeignCommits = (): DomainError =>
  new DomainError('REPO_FOREIGN_COMMITS', 'The branch has commits Raditi did not send', 409)

/** The wait for the build was taken off, or the request closed, before the provider merged it. */
export const repoAutoMergeOff = (): DomainError =>
  new DomainError('REPO_AUTO_MERGE_OFF', 'The merge request was not merged after its build', 409)

/** The manual job of the card is not one of the newest build of the main branch any more. */
export const repoDeployGone = (): DomainError =>
  new DomainError('REPO_DEPLOY_GONE', 'The deploy job is not there any more', 409)

/** The words of the refusals of a merge and a deploy the client reads, without a final period. */
export const repoMergeRefusalTexts = Object.freeze({
  REPO_FOREIGN_COMMITS:
    'В ветке есть коммиты не из Радити — посмотрите их в запросе на слияние в репозитории',
  REPO_MR_TARGET_CHANGED:
    'Запрос на слияние теперь ведёт в другую ветку — изменения не приняты. Посмотрите запрос в репозитории',
  REPO_AUTO_MERGE_OFF:
    'Изменения не приняты: ожидание сборки сняли или запрос закрыли. Откройте запрос в репозитории',
  REPO_DEPLOY_GONE:
    'Этого задания выкладки больше нет у последней сборки основной ветки — откройте «Выкатить» снова',
} satisfies Record<string, string>)

/** The words of the card of a merge and of «Выкатить» (§4.8, P-chat-merge, P-deploy). */
export const repoMergeTexts = Object.freeze({
  /** The review's fix of the board: the build of the client is not read by the platform. */
  afterMerge:
    'После принятия сборка вашего репозитория может выкатить изменения — так, как она настроена. Отменить можно новым запросом на слияние.',
  deployBody:
    'Запустится ручное задание вашей сборки на основной ветке — выкладку делает ваша сборка, так, как она настроена. Отката платформа не делает: отменить можно новым запросом на слияние.',
})
