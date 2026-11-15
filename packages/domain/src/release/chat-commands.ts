import { terminalTaskStatuses, type TaskStatus } from '../tasks/task-status.ts'

/**
 * The commands of a chat (docs/plan/53-chat-preview-release.md, Р34; docs/plan/61-chats-first.md,
 * §5.14): `/` at the start of the input opens the list. The server decides which of its commands
 * are available (`task.commands`), a command of the page itself needs no verdict; what is typed
 * never reaches the agent, a command it carries out sends the words of the platform. Labels are
 * what the client reads (rule 10). The commands of a site — `/release`, `/preview`, `/update`,
 * `/reset`, `/rollback`, `/init`, `/retry` — are gone with projects (docs/plan/83-remove-projects.md,
 * БП7); rows of the feed written with them are read by `historicFeedCommandIds`.
 */
export const chatCommandIds = [
  'compact',
  'turn_undo',
  'turn_redo',
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
export type ChatCommandGroup = 'agent' | 'chat'
export const chatCommandGroupLabel: Readonly<Record<ChatCommandGroup, string>> = Object.freeze({
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
  readonly group: ChatCommandGroup
  /** `client` — no verdict of the server, and it works on a new chat too (but for `session`). */
  readonly scope: 'server' | 'client'
  /** `session` — takes a chat that exists. */
  readonly needs?: 'session'
}

export const chatCommands: Readonly<Record<ChatCommandId, ChatCommand>> = Object.freeze({
  compact: Object.freeze({
    slash: '/compact',
    aliases: ['/summarize'],
    label: 'Сжать переписку',
    description: 'Агент заменит длинную историю кратким пересказом и продолжит с ним.',
    group: 'agent',
    scope: 'server',
  }),
  turn_undo: Object.freeze({
    slash: '/undo',
    label: 'Отменить последний запрос',
    description: 'Агент забудет последний запрос и ответ на него.',
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

export const chatCommandRefusals = [
  /** The agent is at work. */
  'busy',
  /** The dialog has ended. */
  'finished',
  /** The dialog waits for an answer to a question first. */
  'awaiting_answer',
  // `/undo` and `/redo` (docs/plan/61-chats-first.md, §5.14).
  'nothing_to_undo',
  'nothing_to_redo',
  'nothing_to_compact',
  /** The client took the browser of the chat over: the agent waits, and they have to say so. */
  'browser_with_client',
  /** The driver has no compaction: the command is not listed, and typed it runs nothing. */
  'no_compaction',
] as const
export type ChatCommandRefusal = (typeof chatCommandRefusals)[number]

export const chatCommandRefusalText: Readonly<Record<ChatCommandRefusal, string>> = Object.freeze({
  busy: 'Подождите: агент ещё работает.',
  finished: 'Чат завершён.',
  awaiting_answer: 'Сначала ответьте на вопрос в чате.',
  nothing_to_undo: 'Отменять пока нечего.',
  nothing_to_redo: 'Возвращать нечего.',
  nothing_to_compact: 'Сжимать пока нечего.',
  browser_with_client: 'Сначала закончите в браузере и нажмите «Продолжить работу агента».',
  no_compaction: 'Эта команда сейчас недоступна.',
})

export interface ChatCommandFacts {
  taskStatus: TaskStatus
  /** The reader's role in the workspace. */
  role: 'owner' | 'admin' | 'member'
  /**
   * The client pressed `/cancel` and core has not closed the chat yet: no command but `/cancel`
   * is taken then.
   */
  cancelPending: boolean
  /**
   * Why `/undo` takes no turn now, past the status of the chat; null — it takes the last one
   * (docs/plan/61-chats-first.md, §5.14).
   */
  turnUndo: TurnUndoRefusal | null
  /** Why `/redo` brings nothing back; null — it brings back the turn `/undo` took. */
  turnRedo: TurnRedoRefusal | null
  /** The driver of the platform can compact a session (`AgentCapabilities.compaction`). */
  compaction: boolean
  /** Why a command of the agent runs no turn now for the browser of the chat; null — nothing waits. */
  agentBrowser: AgentBrowserRefusal | null
  /** Why `/compact` shortens nothing now, past the status of the chat; null — it may. */
  compactRefusal: CompactRefusal | null
}

/** The refusals of `/undo` the facts of its turn decide. */
export type TurnUndoRefusal = Extract<ChatCommandRefusal, 'nothing_to_undo' | 'awaiting_answer'>

/** The refusal of `/redo` the facts of its turn decide. */
export type TurnRedoRefusal = Extract<ChatCommandRefusal, 'nothing_to_redo'>

/** The refusals of a command of the agent the browser of the chat decides. */
export type AgentBrowserRefusal = Extract<
  ChatCommandRefusal,
  'awaiting_answer' | 'browser_with_client'
>

/** The refusals of `/compact` the facts of its session decide, `agentBrowser` among them. */
export type CompactRefusal = Extract<
  ChatCommandRefusal,
  'nothing_to_compact' | 'awaiting_answer' | 'browser_with_client'
>

export interface ChatCommandAvailability {
  id: ServerCommandId
  available: boolean
  /** null when available. */
  refusal: ChatCommandRefusal | null
}

const BUSY: readonly TaskStatus[] = ['queued', 'preparing', 'running']

function refusalOf(id: ServerCommandId, facts: ChatCommandFacts): ChatCommandRefusal | null {
  const status = facts.taskStatus
  // Before everything else: the page drops this refusal alone, so no other may hang in the list.
  if (id === 'compact' && !facts.compaction) return 'no_compaction'
  if (terminalTaskStatuses.includes(status)) return 'finished'
  if (facts.cancelPending && id !== 'cancel') return 'finished'
  switch (id) {
    // A pass with the reserve of the next words; a failure of it costs nothing (К30).
    case 'compact':
      return BUSY.includes(status) ? 'busy' : facts.compactRefusal
    case 'turn_undo':
      return BUSY.includes(status) ? 'busy' : facts.turnUndo
    case 'turn_redo':
      return facts.turnRedo
    case 'cancel':
      return null
  }
}

/** Every command of the server with its verdict, in the list's order. */
export function chatCommandAvailability(facts: ChatCommandFacts): ChatCommandAvailability[] {
  return serverCommandIds.map((id) => {
    const refusal = refusalOf(id, facts)
    return { id, available: refusal === null, refusal }
  })
}

/**
 * Every command a `feed.request` of the kind `command` was ever written with: those of the server
 * now and those of the site that went with projects (docs/plan/83-remove-projects.md, БП7). The
 * feed reads old rows with them; nothing new is written with the gone ones.
 */
export const historicFeedCommandIds = [
  'release',
  'preview',
  'update',
  'reset',
  'undo',
  'init',
  'compact',
  'turn_undo',
  'turn_redo',
  'cancel',
] as const
