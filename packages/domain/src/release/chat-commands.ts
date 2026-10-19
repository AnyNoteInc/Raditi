import { terminalTaskStatuses, type TaskStatus } from '../tasks/task-status.ts'
import type { CandidateStatus } from './candidate.ts'
import type { PreviewStatus } from '../preview/preview-state.ts'

/**
 * The commands of a dialog (docs/plan/53-chat-preview-release.md, Р34): `/` at the start of the
 * input opens the list. The server decides which are available (`task.commands`); the text of a
 * command never reaches the agent. Labels are what the client reads (rule 10).
 */
export const chatCommandIds = [
  'release',
  'preview',
  'reset',
  'update',
  'retry',
  'cancel',
  'undo',
] as const
export type ChatCommandId = (typeof chatCommandIds)[number]

export interface ChatCommand {
  /** What is typed: `/release`. */
  readonly slash: string
  readonly label: string
  readonly description: string
}

export const chatCommands: Readonly<Record<ChatCommandId, ChatCommand>> = Object.freeze({
  release: Object.freeze({
    slash: '/release',
    label: 'Выпустить новую версию',
    description: 'Установить проверенные изменения на сайт: с резервной копией и проверкой после.',
  }),
  preview: Object.freeze({
    slash: '/preview',
    label: 'Открыть предпросмотр',
    description: 'Показать рабочую копию сайта с изменениями этого диалога.',
  }),
  reset: Object.freeze({
    slash: '/reset',
    label: 'Сбросить данные предпросмотра',
    description:
      'Вернуть рабочую копию к последним изменениям агента: то, что вы меняли в ней сами, пропадёт.',
  }),
  update: Object.freeze({
    slash: '/update',
    label: 'Обновить рабочую копию',
    description: 'Перенести изменения этого диалога на текущую версию сайта.',
  }),
  retry: Object.freeze({
    slash: '/retry',
    label: 'Попробовать ещё',
    description:
      'Повторить просьбу, на которой работа оборвалась. Изменения, готовые до этого, останутся.',
  }),
  cancel: Object.freeze({
    slash: '/cancel',
    label: 'Отменить диалог',
    description: 'Закрыть диалог без выпуска: изменения на сайт не попадут.',
  }),
  undo: Object.freeze({
    slash: '/undo',
    label: 'Отменить выпуск',
    description:
      'Вернуть сайт к версии до этого выпуска: файлы и записи, которые он изменил. Можно в течение 7 дней после установки.',
  }),
})

/** The command a whole input stands for, or null: only a command alone, without words. */
export function parseChatCommand(text: string): ChatCommandId | null {
  const value = text.trim()
  return chatCommandIds.find((id) => chatCommands[id].slash === value) ?? null
}

/** Commands of the list for what is typed after `/`, in the list's order. */
export function matchChatCommands(input: string): ChatCommandId[] {
  if (!input.startsWith('/')) return []
  const typed = input.slice(1).trim().toLowerCase()
  return chatCommandIds.filter((id) => id.startsWith(typed))
}

// ---------------------------------------------------------------------------------------------
// Availability: decided by the server
// ---------------------------------------------------------------------------------------------

export const chatCommandRefusals = [
  /** Only an owner or an admin of the workspace releases (Р25). */
  'not_allowed',
  'no_candidate',
  /** The agent is at work. */
  'busy',
  'release_in_progress',
  /** The site changed since the dialog started: «Обновить» first. */
  'needs_update',
  'checks_failed',
  'no_preview',
  'preview_not_ready',
  /** The build of the preview failed: a reset builds it again. */
  'preview_failed',
  'preview_unavailable',
  /** The working copy is already on the current version of the site. */
  'up_to_date',
  /** The dialog has ended. */
  'finished',
  /**
   * The dialog waits for an answer to a question (`awaiting_user`): its candidate is neither
   * released nor carried onto the current version meanwhile.
   */
  'awaiting_answer',
  /**
   * The changes of the database cannot be released as the panel «База данных» shows them: no
   * values, too many to show, or a change it refused (`dbPlanViewRefusal`).
   */
  'database_not_releasable',
  // «Отменить выпуск» (docs/plan/53, «Отмена выпуска»).
  /** No version of this dialog was installed. */
  'no_release',
  /** Another version was installed after the one of this dialog. */
  'not_installed',
  'already_undone',
  /** Seven days have passed since the installation. */
  'undo_expired',
  /** The site waits for the operator after an installation whose outcome is not known. */
  'site_held',
  /** The site is paused, disconnected or archived. */
  'site_inactive',
  /** «Попробовать ещё»: no failure of the agent's work waits for a retry. */
  'nothing_to_retry',
] as const
export type ChatCommandRefusal = (typeof chatCommandRefusals)[number]

export const chatCommandRefusalText: Readonly<Record<ChatCommandRefusal, string>> = Object.freeze({
  not_allowed: 'Выпускать и отменять версии могут владелец и администраторы.',
  no_candidate: 'Пока нечего выпускать: изменений ещё нет.',
  busy: 'Подождите: агент ещё работает.',
  release_in_progress: 'Версия уже выпускается.',
  needs_update: 'Сайт изменился после начала диалога. Сначала обновите рабочую копию.',
  checks_failed: 'Проверки изменений не прошли.',
  no_preview: 'У этого диалога пока нет предпросмотра.',
  preview_not_ready: 'Предпросмотр ещё готовится.',
  preview_failed:
    'Предпросмотр не удалось подготовить. Сбросьте данные предпросмотра — мы соберём его заново.',
  preview_unavailable: 'Предпросмотр недоступен.',
  up_to_date: 'Рабочая копия уже на текущей версии сайта.',
  finished: 'Диалог завершён.',
  awaiting_answer: 'Сначала ответьте на вопрос в диалоге.',
  database_not_releasable:
    'Изменения базы данных в этой версии выпустить нельзя. Почему — сказано в разделе «База данных».',
  no_release: 'В этом диалоге не устанавливали версий.',
  not_installed:
    'После этой версии на сайт установили другую. Отменить можно только последнюю установленную версию.',
  already_undone: 'Этот выпуск уже отменён.',
  undo_expired:
    'Отменить выпуск можно в течение 7 дней после установки. Опишите в новом диалоге, что нужно вернуть.',
  site_held: 'Мы ещё проверяем сайт после прошлой установки. Отменить выпуск пока нельзя.',
  site_inactive:
    'Сайт сейчас не подключён к Радити. Возобновите подключение, чтобы отменить выпуск.',
  nothing_to_retry: 'Повторять нечего: работа агента не обрывалась.',
})

export interface ChatCommandFacts {
  taskStatus: TaskStatus
  /** The reader's role in the workspace of the site. */
  role: 'owner' | 'admin' | 'member'
  /** The candidate of the dialog that is not superseded or released; null — none. */
  candidate: {
    status: Extract<CandidateStatus, 'current' | 'stale'>
    /** The tree of its base equals the tree of `main`. */
    baseIsMain: boolean
    checksFailed: boolean
  } | null
  preview: { status: PreviewStatus } | null
  releaseInProgress: boolean
  /** What «Отменить выпуск» is decided by; null — no version of this dialog was installed. */
  undo: UndoCommandFacts | null
  /**
   * Why «Попробовать ещё» is not offered, in the words of a command (`retryCommandRefusal` of
   * `retryVerdict`); null — it is.
   */
  retry: ChatCommandRefusal | null
}

/**
 * The latest installed release of the dialog (not an undo) and the site around it (docs/plan/53,
 * «Отмена выпуска»). Read with the facts of the dialog; `expired` is decided by the reader's
 * clock against `undoDeadline` of the installation.
 */
export interface UndoCommandFacts {
  /** The site runs this release now (`sites.installed_release_id`). */
  installedNow: boolean
  /** An undo of it was installed. */
  undone: boolean
  /** Seven days have passed since it was installed. */
  expired: boolean
  /** A release or an undo of the site is under way (this dialog's own undo included). */
  siteReleasing: boolean
  /** The site waits for the operator (`site_leases.held_for_operator`). */
  siteHeld: boolean
  siteActive: boolean
}

export interface ChatCommandAvailability {
  id: ChatCommandId
  available: boolean
  /** null when available. */
  refusal: ChatCommandRefusal | null
}

const BUSY: readonly TaskStatus[] = ['queued', 'preparing', 'running']
const RELEASING: readonly TaskStatus[] = ['deploying', 'verifying']

/**
 * «Отменить выпуск»: an owner or an admin, of the version this dialog installed, while the site
 * runs it, within seven days, once, with the site free and connected. The dialog is closed by
 * then (`done`); between the installation and its charge it stands in `verifying` for a moment.
 */
function undoRefusal(facts: ChatCommandFacts): ChatCommandRefusal | null {
  const undo = facts.undo
  if (facts.role === 'member') return 'not_allowed'
  if (undo === null) return 'no_release'
  if (undo.undone) return 'already_undone'
  if (!undo.installedNow) return 'not_installed'
  if (undo.expired) return 'undo_expired'
  if (undo.siteReleasing) return 'release_in_progress'
  if (undo.siteHeld) return 'site_held'
  if (!undo.siteActive) return 'site_inactive'
  return facts.taskStatus === 'done' ? null : 'busy'
}

function refusalOf(id: ChatCommandId, facts: ChatCommandFacts): ChatCommandRefusal | null {
  const { taskStatus: status, candidate, preview } = facts
  if (id === 'undo') return undoRefusal(facts)
  if (terminalTaskStatuses.includes(status))
    return id === 'preview' && preview ? previewRefusal(preview.status, 'ended') : 'finished'
  switch (id) {
    case 'release':
      if (facts.role === 'member') return 'not_allowed'
      if (facts.releaseInProgress || RELEASING.includes(status)) return 'release_in_progress'
      if (BUSY.includes(status)) return 'busy'
      if (candidate === null) return 'no_candidate'
      if (status !== 'awaiting_approval') return 'awaiting_answer'
      if (candidate.status === 'stale' || !candidate.baseIsMain) return 'needs_update'
      if (candidate.checksFailed) return 'checks_failed'
      return null
    case 'preview':
      return preview === null ? 'no_preview' : previewRefusal(preview.status, 'open')
    case 'reset':
      if (BUSY.includes(status)) return 'busy'
      if (facts.releaseInProgress || RELEASING.includes(status)) return 'release_in_progress'
      return preview === null ? 'no_preview' : previewRefusal(preview.status, 'reset')
    case 'update':
      if (BUSY.includes(status)) return 'busy'
      if (facts.releaseInProgress || RELEASING.includes(status)) return 'release_in_progress'
      if (candidate === null) return 'no_candidate'
      // core carries a candidate over only while the dialog waits with it (`candidate.rebase`).
      if (status !== 'awaiting_approval') return 'awaiting_answer'
      return candidate.status === 'stale' || !candidate.baseIsMain ? null : 'up_to_date'
    case 'retry':
      return facts.retry
    case 'cancel':
      return facts.releaseInProgress || RELEASING.includes(status) ? 'release_in_progress' : null
  }
}

/**
 * What a preview in `status` lets a command do: `open` — `/preview` in a live dialog, `reset` —
 * `/reset`, `ended` — `/preview` of a dialog that has ended, which nothing resets any more.
 */
function previewRefusal(
  status: PreviewStatus,
  use: 'open' | 'reset' | 'ended',
): ChatCommandRefusal | null {
  switch (status) {
    case 'ready':
      return null
    // Opening a stopped preview builds it again (`expired → building`); so does a reset.
    case 'expired':
      return null
    // A reset rebuilds a broken preview; opening it does not.
    case 'failed':
      return use === 'reset' ? null : use === 'open' ? 'preview_failed' : 'preview_unavailable'
    case 'pending':
    case 'building':
      return 'preview_not_ready'
    case 'unavailable':
    case 'destroyed':
      return 'preview_unavailable'
  }
}

/** Every command with its verdict, in the list's order. */
export function chatCommandAvailability(facts: ChatCommandFacts): ChatCommandAvailability[] {
  return chatCommandIds.map((id) => {
    const refusal = refusalOf(id, facts)
    return { id, available: refusal === null, refusal }
  })
}
