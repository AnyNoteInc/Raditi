/**
 * Why a task failed, as the customer is told — the closed catalogue of the feed design
 * (docs/research/2026-10-client-feed/feed-design.md, «Причины сбоя для клиента»). A feed row
 * stores the code only; the Russian text is chosen when the row is shown, so a corrected
 * wording also reaches old rows. Raw failure text never enters either.
 */
export const feedFailureCodes = [
  'technical',
  'timeout',
  'too_large',
  'task_limit',
  'credits_out',
  'agent_limits',
  'usage_limit',
  'forbidden_change',
  'secret_found',
  'site_files',
  'site_held',
  'content_refused',
  'unavailable',
  'not_accepted',
] as const
export type FeedFailureCode = (typeof feedFailureCodes)[number]

/** What an unknown code is read as, and what every unknown technical cause maps to. */
export const FEED_FAILURE_FALLBACK: FeedFailureCode = 'technical'

export const feedFailureText: Readonly<Record<FeedFailureCode, string>> = Object.freeze({
  technical: 'Не получилось выполнить задачу из-за технического сбоя.',
  timeout: 'Агент не уложился в 20 минут. Попробуйте разбить задачу на несколько небольших.',
  too_large:
    'Работа получилась слишком большой, и мы не смогли её сохранить. Попробуйте разбить задачу на несколько небольших.',
  task_limit:
    'Задача оказалась больше, чем получается сделать за один заход. Попробуйте разбить её на несколько небольших.',
  credits_out:
    'Лимиты закончились: кредитов не хватило, чтобы закончить задачу, и работа остановлена. Сколько кредитов осталось и когда начислятся новые — в разделе «Использование».',
  // The platform's own limit with the model provider (a window of the plan, an empty balance),
  // not the client's credits: nothing the client can do, so it is told whom to ask.
  agent_limits: 'Лимиты ИИ-агента закончились, и задача не выполнена. Обратитесь к администратору.',
  // A window of 5 hours or of the week of the workspace (plan 71): the row names which and when
  // it resets (`usageLimitText`); these words are for a row without them.
  usage_limit:
    'Лимит работы агента исчерпан. Продолжить можно после его сброса — когда он, сказано в разделе «Использование».',
  forbidden_change:
    'Агент попытался изменить то, что менять нельзя, и мы не сохранили его работу. Попробуйте описать задачу по-другому.',
  secret_found:
    'В изменениях нашлось что-то похожее на пароль или ключ, поэтому мы не сохранили работу агента. Попросите агента не добавлять пароли и ключи в файлы.',
  site_files:
    'С файлами этого сайта агент пока не умеет работать. Напишите нам — поможем разобраться.',
  site_held:
    'При работе с сайтом произошёл сбой, мы его разбираем. Новые задачи для этого сайта пока недоступны.',
  content_refused:
    'Мы не можем выполнить эту задачу: её не пропустила проверка безопасности. Начните новый чат и опишите задачу по-другому.',
  unavailable: 'Сейчас мы не можем взять задачу в работу. Попробуйте ещё раз немного позже.',
  not_accepted:
    'Задачи для этого сайта пока не принимаются. Напишите нам — расскажем, когда это изменится.',
})

/**
 * The failures a chat without a project can come to whose words above name a site or files
 * (docs/plan/61-chats-first.md, К18). `site_files` is of a repository, which such a chat has not.
 */
const feedFailureNoSiteText: Partial<Readonly<Record<FeedFailureCode, string>>> = Object.freeze({
  secret_found:
    'В работе агента нашлось что-то похожее на пароль или ключ, поэтому мы её не сохранили. Попробуйте описать задачу по-другому.',
  // A lease of its own, and no content write can hold it: the recovery sweep frees it within a
  // minute, and words written before that end in the same card, free of charge.
  site_held: 'Произошёл сбой, мы его разбираем. Подождите минуту, прежде чем писать дальше.',
  not_accepted: 'Задачи пока не принимаются. Напишите нам — расскажем, когда это изменится.',
})

/** The words of a failure, in a chat with a site or without one. */
export const feedFailureTextOf = (code: FeedFailureCode, withSite: boolean): string =>
  (withSite ? undefined : feedFailureNoSiteText[code]) ?? feedFailureText[code]

/**
 * Whether the code alone allows «Попробовать ещё», as the feed design has it. Today a retry is
 * offered only to a dialog that kept its candidate, after a narrower set of codes and with the
 * site not left in doubt — the server decides that (`retryVerdict`, `canRetry` of the task head).
 */
export const feedFailureRetry: Readonly<Record<FeedFailureCode, boolean>> = Object.freeze({
  technical: true,
  timeout: true,
  too_large: true,
  task_limit: true,
  credits_out: false,
  // A repeat meets the same exhausted limit until the administrator acts.
  agent_limits: false,
  // The same window refuses until its reset; «Продолжить» after it (Л15).
  usage_limit: false,
  forbidden_change: true,
  secret_found: true,
  site_files: false,
  site_held: false,
  content_refused: false,
  unavailable: true,
  not_accepted: false,
})

const moscowTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const moscowWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Moscow',
  weekday: 'short',
})
const weekdayRu: Readonly<Record<string, string>> = Object.freeze({
  Mon: 'пн',
  Tue: 'вт',
  Wed: 'ср',
  Thu: 'чт',
  Fri: 'пт',
  Sat: 'сб',
  Sun: 'вс',
})

/**
 * When a window resets, by the Moscow clock: «18:40» for the 5 hours, «пн, 10:15» for the week.
 */
export function usageWindowResetText(kind: '5h' | 'week', resetsAt: Date): string {
  const time = moscowTime.format(resetsAt)
  if (kind === '5h') return time
  return `${weekdayRu[moscowWeekday.format(resetsAt)] ?? ''}, ${time}`
}

/** The words of a refusal by a window of the workspace, with its reset (plan 71, §4.5). */
export function usageLimitText(kind: '5h' | 'week', resetsAt: Date | null): string {
  if (resetsAt === null) return feedFailureText.usage_limit
  const time = moscowTime.format(resetsAt)
  // Nothing goes on by itself (Л15): the client writes «продолжи» or presses «Продолжить».
  if (kind === '5h')
    return `Лимит на 5 часов исчерпан. Продолжить можно после ${time} — напишите «продолжи» или нажмите «Продолжить».`
  const day = weekdayRu[moscowWeekday.format(resetsAt)] ?? ''
  return `Недельный лимит исчерпан. Продолжить можно в ${day} после ${time} — напишите «продолжи» или нажмите «Продолжить».`
}

/**
 * The words of a page («Тарифы», «Использование») when a window refuses a new task: when new
 * tasks are taken again, by the Moscow clock.
 */
export function usageLimitPageText(kind: '5h' | 'week', resetsAt: Date | null): string {
  if (resetsAt === null) return 'Лимит работы агента исчерпан: новые задачи — после его сброса.'
  const time = moscowTime.format(resetsAt)
  if (kind === '5h') return `Лимит на 5 часов исчерпан: новые задачи — после ${time}.`
  const day = weekdayRu[moscowWeekday.format(resetsAt)] ?? ''
  return `Недельный лимит исчерпан: новые задачи — в ${day} после ${time}.`
}
