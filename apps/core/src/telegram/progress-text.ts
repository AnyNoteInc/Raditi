import {
  todoListReadsRussian,
  todoProgressOf,
  type AgentEvent,
  type AgentTodoList,
  type TaskStatus,
} from '@repo/domain'

// The message of the work of the agent in Telegram (owner's request of 15.11.2026): one message,
// edited every few seconds while a pass goes on — a moving bar for the animation, what the agent
// does now and how long it works. Telegram has no animation of its own in a message: the bar moves
// one step at each edit, and «печатает…» stands above the field meanwhile. Russian, to «вы».

/** How often the message is edited: within the 5–10 seconds asked for. */
export const TELEGRAM_PROGRESS_EVERY_MS = 6_000
/** A pass longer than this keeps its last message without edits (a run ends anyway). */
export const TELEGRAM_PROGRESS_MAX_TICKS = 3_600

const BAR = 6
/** A block that runs along the bar and back. */
export function progressBar(tick: number): string {
  const span = BAR * 2 - 2
  const at = tick % span
  const position = at < BAR ? at : span - at
  return Array.from({ length: BAR }, (_, index) => (index === position ? '▰' : '▱')).join('')
}

/** «1 мин 05 с». */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0
    ? `${seconds} с`
    : `${minutes} мин ${String(seconds % 60).padStart(2, '0')} с`
}

/** What a tool of the platform does, in the client's words; null — say nothing of the tool. */
function toolText(tool: string): string {
  const name = tool.replace(/^raditi_/, '')
  if (name === 'search_web') return 'Ищет в интернете'
  if (name === 'webfetch') return 'Читает страницу в интернете'
  if (name === 'web_open') return 'Открывает страницу'
  if (name === 'web_upload') return 'Загружает файл на сайт'
  if (name === 'web_download') return 'Скачивает файл с сайта'
  if (name.startsWith('web_')) return 'Работает в браузере'
  if (name.startsWith('browser_')) return 'Проверяет предпросмотр в браузере'
  if (name.startsWith('page_')) return 'Работает со страницами'
  if (name.startsWith('doc_')) return 'Пишет документ'
  if (name === 'wp_rest' || name === 'restore') return 'Работает с содержимым сайта'
  if (name === 'site_info') return 'Смотрит сведения о сайте'
  return 'Работает с инструментами'
}

const cut = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  // Whole characters: half of an astral one is no text Telegram takes.
  let kept = ''
  for (const char of line) {
    if (kept.length + char.length > max - 1) break
    kept += char
  }
  return `${kept}…`
}

/**
 * The plan of the agent's work (docs/plan/89-agent-todos.md, ТД9, ТД11): what is done of it and
 * the item at work. A list the agent did not write in Russian is told by its count alone (rule
 * 10): the step at work, or all done.
 */
function todoLine(list: AgentTodoList): string {
  if (list.items.length === 0) return 'Обновляет план работы'
  const progress = todoProgressOf(list)
  if (progress.abandoned) return 'Агент отменил план'
  const { done, total } = progress
  if (!todoListReadsRussian(list.items))
    return done >= total
      ? `План: сделано ${total} из ${total}`
      : `План: шаг ${done + 1} из ${total}`
  const counted = `План: сделано ${done} из ${total}`
  return progress.current === null
    ? counted
    : `${counted} · сейчас: ${cut(list.items[progress.current]!.text, 80)}`
}

/** What the agent does now, by its last event of the turn; null — nothing to say of it. */
export function activityLine(event: AgentEvent | null): string | null {
  if (event === null) return null
  switch (event.type) {
    case 'draft':
      return event.kind === 'reasoning' ? 'Размышляет' : 'Пишет ответ'
    case 'reasoning':
      return 'Размышляет'
    case 'message':
      return 'Пишет ответ'
    case 'command':
      return `Выполняет команду: ${cut(event.command, 60)}`
    case 'tool_call':
      return toolText(event.tool)
    case 'file_change':
      return `${event.change === 'delete' ? 'Удаляет' : 'Правит'} файл ${cut(event.path, 60)}`
    case 'question':
      return 'Готовит вопрос'
    case 'todo_list':
      return todoLine(event)
    default:
      return null
  }
}

export interface ProgressFacts {
  tick: number
  status: TaskStatus
  /** The last event of the agent in this pass. */
  event: AgentEvent | null
  /** Since the words of the client. */
  elapsedMs: number
}

/** The words of the message (plain text: core escapes it). */
export function progressText(facts: ProgressFacts): string {
  const head = `${progressBar(facts.tick)}  Агент работает · ${elapsedText(facts.elapsedMs)}`
  const now =
    facts.status === 'queued'
      ? 'В очереди: агент скоро возьмётся за работу'
      : facts.status === 'preparing'
        ? 'Готовит рабочее место'
        : (activityLine(facts.event) ?? 'Разбирается в задаче')
  return `${head}\n${now}`
}
