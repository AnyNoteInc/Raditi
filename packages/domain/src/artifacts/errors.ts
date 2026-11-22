import { DomainError } from '../errors.ts'

/**
 * The refusals of artifacts (docs/plan/88-artifacts.md, §7.2, Ар14–Ар19, Ар23). The English
 * message is for the logs and the agent — a tool answers it as a result with `isError`; the
 * client reads the Russian text of the code (`artifactRefusalTexts`). Details carry what the
 * caller needs to go on (the current block of a stale write, who holds a block), never a text of
 * a secret.
 */

export const artifactRefusalCodes = [
  'ARTIFACT_STALE',
  'ARTIFACT_FIND_NONE',
  'ARTIFACT_FIND_MANY',
  'ARTIFACT_BLOCK_HELD',
  'ARTIFACT_LEASE_LOST',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_KIND_REFUSED',
  'ARTIFACT_SECRET_SHAPE',
  'ARTIFACT_LIMIT',
  'ARTIFACT_FORBIDDEN',
  'ARTIFACT_OP_REUSED',
  'ARTIFACT_DATA_CLASS',
  'ARTIFACT_NOT_FOUND',
  'ARTIFACT_OP_INVALID',
  'ARTIFACT_COMMENT_UNAVAILABLE',
  'ARTIFACT_COMMENT_DISPATCH_TOO_LARGE',
  'ARTIFACT_PROJECT_UNAVAILABLE',
  'ARTIFACT_PROJECT_IN_TRASH',
  'ARTIFACT_SHARING_CLOSED',
  'ARTIFACT_LINK_GONE',
  'ARTIFACT_GRANT_REFUSED',
] as const
export type ArtifactRefusalCode = (typeof artifactRefusalCodes)[number]

/** Why a block is held (Ар16, Ар17): a person types, the agent's write is being checked, a claim. */
export const artifactHoldReasons = ['human', 'checking', 'claim'] as const
export type ArtifactHoldReason = (typeof artifactHoldReasons)[number]

const refusal = (code: ArtifactRefusalCode, message: string, status: number, details?: unknown) =>
  new DomainError(code, message, status, details)

/** `ifRev` differs: nothing changed; the details carry the current block. */
export const artifactStale = (current?: unknown): DomainError =>
  refusal(
    'ARTIFACT_STALE',
    'The block changed since you read it: nothing was written, here is its current text',
    409,
    current === undefined ? undefined : { current },
  )

export const artifactFindNone = (block: string): DomainError =>
  refusal('ARTIFACT_FIND_NONE', 'The quote to replace is not in the block: read it again', 409, {
    block,
  })

export const artifactFindMany = (block: string, count: number): DomainError =>
  refusal(
    'ARTIFACT_FIND_MANY',
    'The quote occurs more than once in the block: quote more of it',
    409,
    { block, count },
  )

export const artifactBlockHeld = (block: string, reason: ArtifactHoldReason): DomainError =>
  refusal(
    'ARTIFACT_BLOCK_HELD',
    reason === 'human'
      ? 'A person is editing this block: write elsewhere or later'
      : reason === 'checking'
        ? 'Another turn wrote this block and it is being checked: try later'
        : 'Another chat claimed this block: write elsewhere or later',
    409,
    { block, reason },
  )

export const artifactLeaseLost = (block: string): DomainError =>
  refusal(
    'ARTIFACT_LEASE_LOST',
    'Your claim on the block expired or a person took the edit: read it again',
    409,
    { block },
  )

export const artifactTooLarge = (limit: string): DomainError =>
  refusal('ARTIFACT_TOO_LARGE', `The write exceeds the bound ${limit}`, 413, { limit })

export const artifactKindRefused = (kind: string): DomainError =>
  refusal('ARTIFACT_KIND_REFUSED', `Artifacts of the kind ${kind} cannot be created now`, 400, {
    kind,
  })

/** The text is never repeated in the message or the details. */
export const artifactSecretShape = (): DomainError =>
  refusal(
    'ARTIFACT_SECRET_SHAPE',
    'The text looks like a password or a key: secrets belong in the workspace variables',
    400,
  )

export const artifactLimit = (limit: string): DomainError =>
  refusal('ARTIFACT_LIMIT', `The limit ${limit} is reached`, 409, { limit })

export const artifactForbidden = (): DomainError =>
  refusal('ARTIFACT_FORBIDDEN', 'Your role on this artifact does not allow this', 403)

export const artifactOpReused = (opId: string): DomainError =>
  refusal(
    'ARTIFACT_OP_REUSED',
    'This opId was used for another batch: give a new opId for a new batch',
    409,
    { opId },
  )

export const artifactDataClass = (): DomainError =>
  refusal('ARTIFACT_DATA_CLASS', 'This chat may not read the data of this artifact', 403)

/** Not there, deleted, or not open to the caller: never told apart. */
export const artifactNotFound = (): DomainError =>
  refusal('ARTIFACT_NOT_FOUND', 'No such artifact open to this chat', 404)

export const artifactCommentUnavailable = (): DomainError =>
  refusal('ARTIFACT_COMMENT_UNAVAILABLE', 'The comment is not open for replies', 409)

export const artifactCommentDispatchTooLarge = (): DomainError =>
  refusal('ARTIFACT_COMMENT_DISPATCH_TOO_LARGE', 'The selected notes do not fit one request', 409)

export const artifactProjectUnavailable = (): DomainError =>
  refusal('ARTIFACT_PROJECT_UNAVAILABLE', 'No such live project of the owner here', 409)

export const artifactProjectInTrash = (): DomainError =>
  refusal('ARTIFACT_PROJECT_IN_TRASH', 'The project of the artifact is in the trash', 409)

export const artifactSharingClosed = (): DomainError =>
  refusal('ARTIFACT_SHARING_CLOSED', 'Access of other users is not open yet', 403)

/** A link revoked, expired or never made — told apart from nothing else. */
export const artifactLinkGone = (): DomainError =>
  refusal('ARTIFACT_LINK_GONE', 'The link no longer opens anything', 404)

/** A role this kind does not open with (Ар25), or one not open yet (Ар36). */
export const artifactGrantRefused = (): DomainError =>
  refusal('ARTIFACT_GRANT_REFUSED', 'This access cannot be given to this artifact', 409)

export const artifactOpInvalid = (problem: string, details?: unknown): DomainError =>
  refusal('ARTIFACT_OP_INVALID', `The batch is invalid: ${problem}`, 400, details)

/** What the client reads for each refusal above (rule 10), without a final period. */
export const artifactRefusalTexts = Object.freeze({
  ARTIFACT_STALE: 'Этот блок уже изменили — посмотрите новую версию',
  ARTIFACT_FIND_NONE: 'Такого текста в блоке уже нет',
  ARTIFACT_FIND_MANY: 'Такой текст встречается в блоке несколько раз',
  ARTIFACT_BLOCK_HELD: 'Этот блок сейчас правят',
  ARTIFACT_LEASE_LOST: 'Правку этого блока забрали',
  ARTIFACT_TOO_LARGE: 'Слишком большой текст',
  ARTIFACT_KIND_REFUSED: 'Такой вид пока нельзя создать',
  ARTIFACT_SECRET_SHAPE: 'Похоже на пароль или ключ — храните его в «Настройки → Переменные»',
  ARTIFACT_LIMIT: 'Достигнут предел',
  ARTIFACT_FORBIDDEN: 'У вас нет прав на это действие',
  ARTIFACT_OP_REUSED: 'Эта правка уже была отправлена с другим содержимым',
  ARTIFACT_DATA_CLASS: 'Этот артефакт нельзя открыть в этом чате',
  ARTIFACT_NOT_FOUND: 'Артефакт не найден или к нему нет доступа',
  ARTIFACT_OP_INVALID: 'Правку не удалось применить',
  ARTIFACT_COMMENT_UNAVAILABLE: 'Заметка недоступна для ответа',
  ARTIFACT_COMMENT_DISPATCH_TOO_LARGE:
    'Заметки вместе с ответами не помещаются в один запрос. Выберите меньше заметок. Если не помещается одна заметка, отправьте нужную часть сообщением в чате',
  ARTIFACT_PROJECT_UNAVAILABLE:
    'Этот проект недоступен: он удалён, в архиве или в другом пространстве',
  ARTIFACT_PROJECT_IN_TRASH: 'Артефакт в проекте, который в корзине. Сначала верните проект',
  ARTIFACT_SHARING_CLOSED: 'Делиться артефактами пока нельзя',
  ARTIFACT_LINK_GONE: 'Ссылка больше не работает. Попросите владельца прислать новую',
  ARTIFACT_GRANT_REFUSED: 'Такой доступ к этому артефакту дать нельзя',
} satisfies Record<ArtifactRefusalCode, string>)

/** A quote can become ambiguous as well as stale; the note editor needs its own next step. */
export function artifactCommentRefusalText(code: string | null | undefined): string | undefined {
  switch (code) {
    case 'ARTIFACT_STALE':
      return 'Не удалось привязать заметку к выделенному месту. Выделите цитату заново.'
    case 'ARTIFACT_LIMIT':
      return 'Достигнут предел заметок для этого артефакта.'
    case 'ARTIFACT_COMMENT_UNAVAILABLE':
    case 'ARTIFACT_OP_REUSED':
    case 'ARTIFACT_SECRET_SHAPE':
      return `${artifactRefusalTexts[code]}.`
    default:
      return undefined
  }
}

/** «Этот блок сейчас правят» told by who holds it. */
export const artifactHoldTexts = Object.freeze({
  human: 'Этот блок сейчас правит человек',
  checking: 'Пишет агент…',
  claim: 'Пишет агент',
} satisfies Record<ArtifactHoldReason, string>)
