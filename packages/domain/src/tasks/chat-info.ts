import type { ReasoningEffort } from '../llm/model-class.ts'
import { pluralRu } from '../plural.ts'

// `/usage`, `/status` and `/context` of a chat (owner's request of 15.11.2026: «добавь в агент, а
// также добавь в телеграмм команду /usage /status /context»). The server reads the facts once
// (`readChatInfo` of @repo/trpc); the cabinet and the bot of Telegram tell them in the same words,
// Russian and to «вы» (rule 10). Nothing here reaches the agent, and nothing is charged.

/** The credits of the workspace of the chat, and what the chat itself took. */
export interface ChatUsageInfo {
  /** The tariff the workspace has; null — none. */
  plan: string | null
  /** What is left on the three accounts. */
  total: number
  tariff: number
  gift: number
  pack: number
  /** The window of the week (docs/plan/71-usage-limits.md); null — no limit. */
  week: { limit: number; used: number; left: number; resetsAt: Date | null } | null
  /** Credits this chat took, refunds deducted; null — no chat yet (a new one). */
  chat: number | null
}

/** Where the chat stands. */
export interface ChatStatusInfo {
  title: string | null
  /** The word of its status, as the header of the chat says it. */
  status: string
  /** The model of the last turn, as its card names it; null — no turn yet. */
  model: string | null
  effort: ReasoningEffort
  /** Messages that wait for the agent to finish (docs/plan/75). */
  queued: number
  /** The browser of the agent is open. */
  browser: boolean
}

/** How full the context of the agent is: the size of its last request to the model. */
export interface ChatContextInfo {
  /** Tokens of the last request with its answer; null — the agent has not worked in the chat. */
  used: number | null
  /** What a request of that model holds; null — not known. */
  window: number | null
}

export interface ChatInfo {
  usage: ChatUsageInfo
  /** null — a new chat: there is nothing to tell yet. */
  status: ChatStatusInfo | null
  context: ChatContextInfo | null
}

export type ChatInfoKind = 'usage' | 'status' | 'context'

// Thousands set apart with a no-break space, so a number never wraps: «2 500».
const digits = (count: number): string =>
  String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

const credits = (count: number): string =>
  `${digits(count)} ${pluralRu(count, 'кредит', 'кредита', 'кредитов')}`

/** «850», «182 тыс.», «1 млн», «1,2 млн». */
export function tokensShort(count: number): string {
  if (count < 1000) return digits(count)
  if (count < 1_000_000) return `${digits(Math.round(count / 1000))} тыс.`
  const millions = Math.round(count / 100_000) / 10
  return `${String(millions).replace('.', ',')} млн`
}

const MOSCOW = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
})

/** «18 ноября в 14:00 по Москве». */
function moscowMoment(at: Date): string {
  const parts = MOSCOW.formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? ''
  return `${part('day')} ${part('month')} в ${part('hour')}:${part('minute')} по Москве`
}

const effortWord: Readonly<Record<ReasoningEffort, string>> = Object.freeze({
  low: 'низкое',
  high: 'высокое',
  max: 'максимальное',
})

export const chatInfoTitle: Readonly<Record<ChatInfoKind, string>> = Object.freeze({
  usage: 'Использование',
  status: 'Состояние чата',
  context: 'Контекст агента',
})

export const chatInfoText = Object.freeze({
  /** Where the full picture is, said with the link by the bot: «Настройки» → «Использование». */
  usageMore: 'Подробнее — в разделе «Использование» настроек:',
  newChat: 'Чат ещё не начат: напишите, что сделать.',
})

function usageLines(usage: ChatUsageInfo): string[] {
  const accounts = [
    usage.plan === null ? null : `тариф «${usage.plan}» — ${digits(usage.tariff)}`,
    usage.gift > 0 ? `подарок — ${digits(usage.gift)}` : null,
    usage.pack > 0 || usage.plan === null ? `пакет — ${digits(usage.pack)}` : null,
  ].filter((part): part is string => part !== null)
  const lines = [`Осталось ${credits(usage.total)}: ${accounts.join(', ')}.`]
  if (usage.week !== null) {
    const { limit, used, left, resetsAt } = usage.week
    lines.push(
      `За неделю потрачено ${digits(used)} из ${digits(limit)}, осталось ${digits(left)}.` +
        (resetsAt === null ? '' : ` Лимит обновится ${moscowMoment(resetsAt)}.`),
    )
  }
  if (usage.chat !== null) lines.push(`Этот чат: ${credits(usage.chat)}.`)
  return lines
}

function statusLines(status: ChatStatusInfo | null): string[] {
  if (status === null) return [chatInfoText.newChat]
  const model =
    status.model === null
      ? `Размышление — ${effortWord[status.effort]}.`
      : `Модель — ${status.model}, размышление — ${effortWord[status.effort]}.`
  return [
    ...(status.title === null ? [] : [`Чат «${status.title}».`]),
    `${status.status}.`,
    model,
    ...(status.queued > 0
      ? [
          `В очереди ${digits(status.queued)} ${pluralRu(status.queued, 'сообщение', 'сообщения', 'сообщений')} — агент возьмёт их, когда закончит.`,
        ]
      : []),
    ...(status.browser ? ['Браузер агента открыт.'] : []),
  ]
}

function contextLines(context: ChatContextInfo | null): string[] {
  if (context === null || context.used === null)
    return ['Агент в этом чате ещё не работал — контекст пуст.']
  const { used, window } = context
  const share = window === null ? null : Math.min(100, Math.round((used / window) * 100))
  return [
    window === null
      ? `Последний запрос агента к модели — ${tokensShort(used)} токенов.`
      : `Занято ${tokensShort(used)} из ${tokensShort(window)} токенов — ${share} %.`,
    'Когда контекст заполнится, агент сам сожмёт переписку. Сжать сейчас — команда /compact.',
  ]
}

/** The title and the lines of one of the three commands. */
export function chatInfoLines(
  kind: ChatInfoKind,
  info: ChatInfo,
): { title: string; lines: string[] } {
  const title = chatInfoTitle[kind]
  switch (kind) {
    case 'usage':
      return { title, lines: usageLines(info.usage) }
    case 'status':
      return { title, lines: statusLines(info.status) }
    case 'context':
      return { title, lines: contextLines(info.context) }
  }
}
