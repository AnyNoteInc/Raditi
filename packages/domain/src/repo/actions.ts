import { z } from 'zod'

import { DomainError } from '../errors.ts'
import { repoCiRefusalTexts } from './ci.ts'
import { mergeRequestDescriptionMaxLength } from './merge-request-text.ts'

// What a button of the client does with the repository of a project, and what the agent may ask
// of it (docs/plan/84-projects.md, ПР13, ПР14, §4.1, §4.4): the arguments of a row of
// `repo_actions`, the job of core that runs it, the proposal the agent reserves, and the tools of
// the family `repo`.

/** `git.action` of the queue `git` (gitJobNames.action): one row of `repo_actions`, by its id. */
export const gitActionPayloadSchema = z.strictObject({ actionId: z.uuid() })

const title = z.string().trim().min(1).max(120)
const description = z.string().max(4000)

/**
 * `repo_actions.args` (§4.1): the token of the card itself — core checks its HMAC again (ПР15) —
 * and what the client wrote on the card. Nothing else is read from the row.
 */
export const repoActionArgsSchema = z.strictObject({
  token: z.string().min(1).max(2048),
  /** The merge request a first push opens: the agent's proposal as the client left it (ПР14). */
  mergeRequest: z
    .strictObject({
      title,
      description: z.string().max(mergeRequestDescriptionMaxLength),
      draft: z.boolean(),
      /** The reservation of `repo_request_merge` the card took it from; null — the client's own. */
      reservedId: z.uuid().nullable(),
    })
    .nullable(),
})
export type RepoActionArgs = z.infer<typeof repoActionArgsSchema>

/** `repo_reservations.payload` (§4.1): what `repo_request_merge` proposed. */
export const repoProposalPayloadSchema = z.strictObject({
  title,
  description,
  draft: z.boolean(),
})
export type RepoProposalPayload = z.infer<typeof repoProposalPayloadSchema>

/** The key of the diff of a turn in `raditi-artifacts` (ПР26): core writes it, web reads it. */
export const repoDiffKey = (taskId: string, turn: number): string =>
  `repo-diffs/${taskId.toLowerCase()}/${turn}.diff`

/** A diff larger than this is not kept for «Посмотреть изменения» (ПР26). */
export const REPO_DIFF_KEPT_BYTES = 2 * 1024 * 1024

/** At most one proposal of a merge request a turn (§4.4). */
export const REPO_PROPOSALS_PER_TURN = 1

// --- the tools of the family `repo` (§4.4) ---------------------------------------------------

export const repoStatusArgumentsSchema = z.strictObject({})
export const repoRequestMergeArgumentsSchema = z.strictObject({
  title,
  description,
  draft: z.boolean().optional(),
})

// --- refusals ---------------------------------------------------------------------------------

/** The turn already proposed its merge request (§4.4: at most one a turn). */
export const repoProposalLimit = (): DomainError =>
  new DomainError('REPO_PROPOSAL_LIMIT', 'This turn already proposed a merge request', 409)

/** There is nothing in the chat's branch to send: no turn left a change, or it was undone. */
export const repoNothingToPush = (): DomainError =>
  new DomainError('REPO_NOTHING_TO_PUSH', 'The branch of the chat has no changes to send', 409)

/** The branch at the client changed, and the changes of the chat do not go on top (ПР13). */
export const repoPushConflict = (): DomainError =>
  new DomainError('REPO_PUSH_CONFLICT', 'The changes do not go on top of the branch', 409)

/**
 * The changes touch build settings: they go only with the card «Агент хочет изменить настройки
 * сборки» (ПР16), never by «Отправить в ветку».
 */
export const repoCiChangeNeedsCard = (): DomainError =>
  new DomainError('REPO_CI_CHANGE', 'The changes touch build settings', 409)

/** The words of the refusals of a push the client reads, without a final period. */
export const repoPushRefusalTexts = Object.freeze({
  REPO_NOTHING_TO_PUSH: 'Отправлять пока нечего: в ветке чата нет новых изменений',
  REPO_PUSH_CONFLICT:
    'Изменения не отправлены: ветку изменили в репозитории, и они не легли поверх. Попросите агента повторить',
  REPO_CI_CHANGE:
    'Изменения затрагивают настройки сборки — отправьте их кнопкой «Разрешить и отправить» на карточке настроек сборки',
  ...repoCiRefusalTexts,
  REPO_CONFIRM_INVALID: 'Карточка устарела — откройте её снова',
  REPO_PROPOSAL_LIMIT: 'Запрос на слияние в этом ходе уже предложен',
  REPO_MR_CHANGED:
    'Запрос на слияние открылся не таким, как просили, — мы его закрыли. Попробуйте ещё раз',
} satisfies Record<string, string>)
