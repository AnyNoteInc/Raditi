import { terminalTaskStatuses, type TaskStatus } from '../tasks/task-status.ts'
import type { CandidateStatus } from './candidate.ts'
import type { PreviewStatus } from '../preview/preview-state.ts'

/**
 * The commands of a chat (docs/plan/53-chat-preview-release.md, Р34; docs/plan/61-chats-first.md,
 * §5.14): `/` at the start of the input opens the list. The server decides which of its commands
 * are available (`task.commands`), a command of the page itself needs no verdict; what is typed
 * never reaches the agent, a command it carries out sends the words of the platform. Labels are
 * what the client reads (rule 10). The id of «Отменить выпуск» stays `undo` for the rows written
 * with it (К28): only its slash moved.
 */
export const chatCommandIds = [
  'release',
  'preview',
  'update',
  'reset',
  'undo',
  'init',
  'compact',
  'turn_undo',
  'turn_redo',
  'retry',
  'cancel',
  'new',
  'sessions',
  'export',
  'models',
  'details',
  'thinking',
  'themes',
  'help',
] as const
export type ChatCommandId = (typeof chatCommandIds)[number]

/** The commands the page runs by itself: no verdict of the server, and no row in the feed. */
type ClientCommandId =
  'new' | 'sessions' | 'export' | 'models' | 'details' | 'thinking' | 'themes' | 'help'
/** The commands the server gives a verdict on. */
export type ServerCommandId = Exclude<ChatCommandId, ClientCommandId>

/** The groups of the list, in its order (К27). */
export type ChatCommandGroup = 'site' | 'agent' | 'chat'
export const chatCommandGroupLabel: Readonly<Record<ChatCommandGroup, string>> = Object.freeze({
  site: 'Сайт',
  agent: 'Агент',
  chat: 'Чат',
})

export interface ChatCommand {
  /** What is typed: `/release`. */
  readonly slash: string
  /** Other words for it, as OpenCode has them. */
  readonly aliases?: readonly string[]
  readonly label: string
  readonly description: string
  /** Other words without the repository: there are no files there. */
  readonly descriptionPlain?: string
  readonly group: ChatCommandGroup
  /** `client` — no verdict of the server, and it works on a new chat too (but for `session`). */
  readonly scope: 'server' | 'client'
  /**
   * `repository` — not listed in a chat without it (К27), `session` — takes a chat that exists,
   * `compaction` — takes the compaction of the CLI (docs/plan/61-chats-first.md, §5.14).
   */
  readonly needs?: 'repository' | 'session' | 'compaction'
}

export const chatCommands: Readonly<Record<ChatCommandId, ChatCommand>> = Object.freeze({
  release: Object.freeze({
    slash: '/release',
    label: 'Выпустить новую версию',
    description: 'Установить проверенные изменения на сайт: с резервной копией и проверкой после.',
    group: 'site',
    scope: 'server',
    needs: 'repository',
  }),
  preview: Object.freeze({
    slash: '/preview',
    label: 'Открыть предпросмотр',
    description: 'Показать рабочую копию сайта с изменениями этого чата.',
    group: 'site',
    scope: 'server',
    needs: 'repository',
  }),
  update: Object.freeze({
    slash: '/update',
    label: 'Обновить рабочую копию',
    description: 'Перенести изменения этого чата на текущую версию сайта.',
    group: 'site',
    scope: 'server',
    needs: 'repository',
  }),
  reset: Object.freeze({
    slash: '/reset',
    label: 'Сбросить данные предпросмотра',
    description: 'Вернуть рабочую копию к последним изменениям агента.',
    group: 'site',
    scope: 'server',
    needs: 'repository',
  }),
  undo: Object.freeze({
    slash: '/rollback',
    label: 'Отменить выпуск',
    description: 'Вернуть файлы и записи к версии до выпуска этого чата.',
    group: 'site',
    scope: 'server',
    needs: 'repository',
  }),
  init: Object.freeze({
    slash: '/init',
    label: 'Описать проект для агента',
    description: 'Агент изучит код и подготовит правила работы с проектом.',
    group: 'site',
    scope: 'server',
    needs: 'repository',
  }),
  compact: Object.freeze({
    slash: '/compact',
    aliases: ['/summarize'],
    label: 'Сжать переписку',
    description: 'Агент заменит длинную историю кратким пересказом и продолжит с ним.',
    group: 'agent',
    scope: 'server',
    needs: 'compaction',
  }),
  turn_undo: Object.freeze({
    slash: '/undo',
    label: 'Отменить последний запрос',
    description:
      'Изменения файлов вернутся. То, что агент сделал на сайте через браузер, останется.',
    descriptionPlain: 'Агент забудет последний запрос и ответ на него.',
    group: 'agent',
    scope: 'server',
  }),
  turn_redo: Object.freeze({
    slash: '/redo',
    label: 'Вернуть отменённый запрос',
    description: 'Снова применить то, что вы отменили.',
    group: 'agent',
    scope: 'server',
  }),
  retry: Object.freeze({
    slash: '/retry',
    label: 'Попробовать ещё',
    description: 'Повторить просьбу, на которой работа оборвалась.',
    group: 'agent',
    scope: 'server',
    needs: 'repository',
  }),
  cancel: Object.freeze({
    slash: '/cancel',
    label: 'Отменить чат',
    description: 'Завершить чат и остановить агента.',
    group: 'agent',
    scope: 'server',
  }),
  new: Object.freeze({
    slash: '/new',
    aliases: ['/clear'],
    label: 'Новый чат',
    description: 'Начать другой разговор.',
    group: 'chat',
    scope: 'client',
  }),
  sessions: Object.freeze({
    slash: '/sessions',
    aliases: ['/resume', '/continue'],
    label: 'Все чаты',
    description: 'Перейти к списку чатов.',
    group: 'chat',
    scope: 'client',
  }),
  export: Object.freeze({
    slash: '/export',
    label: 'Скачать переписку',
    description: 'Сохранить чат текстовым файлом.',
    group: 'chat',
    scope: 'client',
    needs: 'session',
  }),
  models: Object.freeze({
    slash: '/models',
    aliases: ['/mo'],
    label: 'Модель и размышление',
    description: 'Посмотреть модель и выбрать уровень размышления.',
    group: 'chat',
    scope: 'client',
  }),
  details: Object.freeze({
    slash: '/details',
    label: 'Подробности работы',
    description: 'Показывать или скрывать команды и инструменты агента.',
    group: 'chat',
    scope: 'client',
  }),
  thinking: Object.freeze({
    slash: '/thinking',
    label: 'Размышления агента',
    description: 'Показывать или скрывать ход мыслей агента.',
    group: 'chat',
    scope: 'client',
  }),
  themes: Object.freeze({
    slash: '/themes',
    label: 'Оформление',
    description: 'Светлая, тёмная или как в системе.',
    group: 'chat',
    scope: 'client',
  }),
  help: Object.freeze({
    slash: '/help',
    label: 'Справка',
    description: 'Что умеют команды.',
    group: 'chat',
    scope: 'client',
  }),
})

/** The commands the server gives a verdict on, in the list's order. */
export const serverCommandIds = chatCommandIds.filter(
  (id): id is ServerCommandId => chatCommands[id].scope === 'server',
)

/**
 * Named here and not working yet (docs/plan/61-chats-first.md, §6: `/compact` — 61.24): no row in
 * the list and no verdict, and typed it is refused and never sent. The slice of a command takes it
 * off this list.
 */
export const chatCommandsToCome = ['compact'] as const
export type CommandToCome = (typeof chatCommandsToCome)[number]

/** A command the server gives a verdict on today. */
export type OfferedCommandId = Exclude<ServerCommandId, CommandToCome>
export const isCommandToCome = (id: ChatCommandId): id is CommandToCome =>
  (chatCommandsToCome as readonly ChatCommandId[]).includes(id)

export const offeredCommandIds = serverCommandIds.filter(
  (id): id is OfferedCommandId => !isCommandToCome(id),
)

/** What may be typed for a command. */
const slashesOf = (id: ChatCommandId): readonly string[] => [
  chatCommands[id].slash,
  ...(chatCommands[id].aliases ?? []),
]

/** The command a whole input stands for, or null: only a command alone, without words. */
export function parseChatCommand(text: string): ChatCommandId | null {
  const value = text.trim()
  return chatCommandIds.find((id) => slashesOf(id).includes(value)) ?? null
}

/** Commands of the list for what is typed after `/`, in the list's order. */
export function matchChatCommands(input: string): ChatCommandId[] {
  if (!input.startsWith('/')) return []
  const typed = input.slice(1).trim().toLowerCase()
  return chatCommandIds.filter((id) => slashesOf(id).some((slash) => slash.startsWith(`/${typed}`)))
}

// ---------------------------------------------------------------------------------------------
// Availability: decided by the server
// ---------------------------------------------------------------------------------------------

/** The one sentence the product has for a paused, disconnected or archived project (К39). */
export const CLOSED_PROJECT_TEXT = 'Сайт на паузе или отключён.'

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
  /**
   * The project of the chat is paused, disconnected or archived: the chat is read, not worked in
   * (docs/plan/61-chats-first.md, К39). «Отменить чат» stops, and «Отменить выпуск» answers
   * `site_inactive` by itself.
   */
  'project_closed',
  /** `/init`: the agent studies the code of the project, and this chat has none (К31). */
  'no_repository',
  // `/undo` and `/redo` (docs/plan/61-chats-first.md, §5.14).
  'nothing_to_undo',
  /** The last turn cannot be undone: the working copy moved on to a new version of the site. */
  'undo_past_update',
  /** The last turn wrote to the site itself. */
  'content_written',
  'nothing_to_redo',
  'nothing_to_compact',
] as const
export type ChatCommandRefusal = (typeof chatCommandRefusals)[number]

export const chatCommandRefusalText: Readonly<Record<ChatCommandRefusal, string>> = Object.freeze({
  not_allowed: 'Выпускать и отменять версии могут владелец и администраторы.',
  no_candidate: 'Пока нечего выпускать: изменений ещё нет.',
  busy: 'Подождите: агент ещё работает.',
  release_in_progress: 'Версия уже выпускается.',
  needs_update: 'Сайт изменился после начала чата. Сначала обновите рабочую копию.',
  checks_failed: 'Проверки изменений не прошли.',
  no_preview: 'У этого чата пока нет предпросмотра.',
  preview_not_ready: 'Предпросмотр ещё готовится.',
  preview_failed:
    'Предпросмотр не удалось подготовить. Сбросьте данные предпросмотра — мы соберём его заново.',
  preview_unavailable: 'Предпросмотр недоступен.',
  up_to_date: 'Рабочая копия уже на текущей версии сайта.',
  finished: 'Чат завершён.',
  awaiting_answer: 'Сначала ответьте на вопрос в чате.',
  database_not_releasable:
    'Изменения базы данных в этой версии выпустить нельзя. Почему — сказано в разделе «База данных».',
  no_release: 'В этом чате не устанавливали версий.',
  not_installed:
    'После этой версии на сайт установили другую. Отменить можно только последнюю установленную версию.',
  already_undone: 'Этот выпуск уже отменён.',
  undo_expired:
    'Отменить выпуск можно в течение 7 дней после установки. Опишите в новом чате, что нужно вернуть.',
  site_held: 'Мы ещё проверяем сайт после прошлой установки. Отменить выпуск пока нельзя.',
  site_inactive:
    'Сайт сейчас не подключён к Радити. Возобновите подключение, чтобы отменить выпуск.',
  nothing_to_retry: 'Повторять нечего: работа агента не обрывалась.',
  project_closed: CLOSED_PROJECT_TEXT,
  no_repository: 'В этом чате нет кода проекта.',
  nothing_to_undo: 'Отменять пока нечего.',
  undo_past_update:
    'Этот запрос отменить нельзя: после него рабочая копия перешла на новую версию сайта.',
  content_written: 'Этот запрос отменить нельзя: он изменил содержимое сайта.',
  nothing_to_redo: 'Возвращать нечего.',
  nothing_to_compact: 'Сжимать пока нечего.',
})

export interface ChatCommandFacts {
  taskStatus: TaskStatus
  /** The chat works with the repository; without it the list leaves out the site's commands (К27). */
  repository: boolean
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
  /**
   * The client pressed `/cancel` and core has not closed the chat yet: a chat with a browser is
   * closed by core in any status (docs/plan/57, Б24), so it may still wait with a candidate. No
   * command but `/cancel` is taken then, `/release` above all.
   */
  cancelPending: boolean
  /**
   * Anyone acted in the browser of this chat (`browser_sessions.wrote_at`): what was done there
   * is on the site, and no undo of a release gives it back.
   */
  browserWrote: boolean
  /**
   * The project of the chat is paused, disconnected or archived (`siteClosed`); `onboarding` is
   * not closed, and a chat without a project never is.
   */
  projectClosed: boolean
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
  id: OfferedCommandId
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

function refusalOf(id: OfferedCommandId, facts: ChatCommandFacts): ChatCommandRefusal | null {
  const { taskStatus: status, candidate, preview } = facts
  if (id === 'undo') return undoRefusal(facts)
  // Before the ended chat below: `/preview` of a chat that has ended is closed with its project.
  if (facts.projectClosed && id !== 'cancel') return 'project_closed'
  if (terminalTaskStatuses.includes(status))
    return id === 'preview' && preview ? previewRefusal(preview.status, 'ended') : 'finished'
  if (facts.cancelPending && id !== 'cancel') return 'finished'
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
    // A pass of the agent on the words of the platform: it goes as the next words would (К31).
    case 'init':
      if (!facts.repository) return 'no_repository'
      if (facts.releaseInProgress || RELEASING.includes(status)) return 'release_in_progress'
      return BUSY.includes(status) ? 'busy' : null
    // Closed until their slices: 61.21 and 61.23 give them facts of their own.
    case 'turn_undo':
      return 'nothing_to_undo'
    case 'turn_redo':
      return 'nothing_to_redo'
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
    // The preview asked for while it is made is shown as soon as it is ready (owner's request of
    // 27.10.2026: it is shown only when the client asks); nothing to reset in it yet.
    case 'pending':
    case 'building':
      return use === 'open' ? null : 'preview_not_ready'
    case 'unavailable':
    case 'destroyed':
      return 'preview_unavailable'
  }
}

/** Every command of the server with its verdict, in the list's order. */
export function chatCommandAvailability(facts: ChatCommandFacts): ChatCommandAvailability[] {
  return offeredCommandIds.map((id) => {
    const refusal = refusalOf(id, facts)
    return { id, available: refusal === null, refusal }
  })
}
