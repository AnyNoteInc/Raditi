import type {
  FeedCancelledBy,
  FeedCeilingReason,
  FeedCreditsState,
  FeedFailurePayload,
  FeedResultPayload,
  FeedStep,
  TaskMode,
  TaskWaitingReason,
} from './client-feed.ts'
import type { TaskStatus } from './task-status.ts'

/**
 * What the platform itself says in a dialog — the catalogue the feed design calls
 * `feed-texts.ts` (docs/research/2026-10-client-feed/feed-design.md: «Подписи статусов»,
 * «Что такое „шаг“», «Причины сбоя для клиента» — the phrases about the site and the credits,
 * «Версии записей», «Экраны, которых нет на макетах»). The failure reasons live next door, in
 * client-feed-failures.ts.
 *
 * A feed row stores a code; the Russian text is chosen here when the row is shown, so a
 * corrected wording also reaches old rows. The texts are for the web cabinet and, later, for
 * Telegram: no markup, nothing but words. Types only are imported, so the module carries no
 * runtime dependency.
 */

/** The form of a Russian noun that goes with the number: 1 кредит, 2 кредита, 5 кредитов. */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const whole = Math.abs(Math.trunc(count))
  const lastTwo = whole % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  const last = whole % 10
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

// Thousands are set apart with a no-break space, so a number never wraps: «2 500».
const groupDigits = (count: number): string =>
  String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

// ---------------------------------------------------------------------------------------------
// Statuses and stages
// ---------------------------------------------------------------------------------------------

/** The word of a status in the header of a dialog and in the list — spec §7. */
export const taskStatusLabel: Readonly<Record<TaskStatus, string>> = Object.freeze({
  queued: 'Приняли, начинаем',
  preparing: 'Готовим',
  running: 'Агент работает',
  awaiting_user: 'Нужен ваш ответ',
  awaiting_approval: 'Ждёт вашего решения',
  deploying: 'Выкладываем',
  verifying: 'Проверяем',
  done: 'Готово',
  failed: 'Не получилось',
  rolled_back: 'Вернули как было',
  cancelled: 'Отменено',
})

/** The second line of a dialog in the list; null — the status has none. */
export const taskStatusListHint: Readonly<Record<TaskStatus, string | null>> = Object.freeze({
  queued: null,
  preparing: null,
  running: null,
  awaiting_user: 'Ответьте на вопрос',
  awaiting_approval: 'Посмотрите и примените',
  deploying: null,
  verifying: null,
  done: null,
  failed: null,
  rolled_back: null,
  cancelled: null,
})

/** Groups of the list: `awaiting` gathers `awaiting_user` and `awaiting_approval`. */
export const taskListGroupLabel = Object.freeze({
  awaiting: 'Ждёт вашего решения',
  today: 'Сегодня',
  earlier: 'Ранее',
})

export const taskModeLabel: Readonly<Record<TaskMode, string>> = Object.freeze({
  work: 'Работа',
  chat: 'Чат',
})

/** Nouns: the same words read as «in progress» and as «done». */
export const feedStepLabel: Readonly<Record<FeedStep, string>> = Object.freeze({
  work: 'Работа над задачей',
  save: 'Сохранение работы',
  site: 'Работа с содержимым сайта',
  files: 'Правки в файлах сайта',
})

// ---------------------------------------------------------------------------------------------
// The live block: drawn from the head of the task, never stored
// ---------------------------------------------------------------------------------------------

const FEED_QUEUED_TEXT =
  'Агент скоро возьмётся за работу. Страницу можно закрыть — результат появится в этом диалоге.'

/** Why the task waits in the queue, by `tasks.waiting`. */
export const feedWaitingText: Readonly<Record<TaskWaitingReason, string>> = Object.freeze({
  agents:
    'Ваша задача в очереди: сейчас все мощности ИИ-агента заняты. Начнём, как только возьмёмся, — результат появится в этом диалоге.',
  site: 'На сайте сейчас идёт другая работа. Начнём, когда она закончится.',
})

/** The text of the live block of a `queued` task. */
export const feedQueuedText = (waiting: TaskWaitingReason | null): string =>
  waiting === null ? FEED_QUEUED_TEXT : feedWaitingText[waiting]

/**
 * The text under the heading of the live block. `deploying`, `verifying` and `rolled_back`
 * have none: their block is the status label alone.
 */
export const feedLiveText = Object.freeze({
  preparing: 'Готовим рабочее место для агента. На сайте пока ничего не меняется.',
  running:
    'Агент работает в своём изолированном облаке. Обычно это занимает до 20 минут. Страницу можно закрыть — результат появится в этом диалоге.',
  /** `held` of the head while the task is `running`: in place of the stages and the timer. */
  held: 'При работе с сайтом произошёл сбой, мы его разбираем. Страницу можно закрыть — результат появится в этом диалоге.',
})

/** Time of work as the timer shows it: «2 мин 14 с»; under a minute — «14 с». */
export function feedDurationText(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const minutes = Math.floor(whole / 60)
  const rest = `${whole % 60} с`
  return minutes === 0 ? rest : `${minutes} мин ${rest}`
}

/** The one line a finished turn folds its stages into. */
export const feedWorkedText = (seconds: number): string =>
  `Агент работал ${feedDurationText(seconds)}`

// ---------------------------------------------------------------------------------------------
// Outcomes: what is known about the site and about the credits
// ---------------------------------------------------------------------------------------------

type EndedSite = FeedFailurePayload['site']
type ResultSite = FeedResultPayload['site']

/** The second sentence of a failure and of a cancellation, by the trusted `site`. */
export const feedEndedSiteText: Readonly<Record<EndedSite, string>> = Object.freeze({
  unchanged: 'На сайте ничего не изменилось.',
  restored: 'Правки, которые агент успел внести, мы вернули — сайт такой же, как до задачи.',
  check:
    'Часть правок могла остаться на сайте. Откройте сайт и проверьте; если что-то не так — напишите нам.',
})

const SITE_MAY_HAVE_CHANGED =
  'Часть правок могла попасть на сайт. Откройте сайт и проверьте; если что-то не так — напишите нам.'

/** The line about the site under «Готово»; null — the agent answered without changing it. */
export const feedDoneSiteText: Readonly<Record<ResultSite, string | null>> = Object.freeze({
  unchanged: null,
  changed: 'Правка уже на сайте.',
  check: SITE_MAY_HAVE_CHANGED,
})

/** The line about the site on the «Что изменится» card of `awaiting_approval`. */
export const feedApprovalSiteText: Readonly<Record<ResultSite, string>> = Object.freeze({
  unchanged: 'На сайте пока ничего не изменилось.',
  changed: 'Правки текста уже на сайте. Изменения в файлах ждут вашего решения.',
  check: SITE_MAY_HAVE_CHANGED,
})

/** Shown when `filesChanged` of a result is a number. */
export const feedFilesChangedText = (count: number): string =>
  `Изменено файлов: ${groupDigits(count)}`

/** The third sentence of a failure and of a cancellation, by the trusted `credits`. */
export const feedCreditsText: Readonly<Record<FeedCreditsState, string>> = Object.freeze({
  returned: 'Кредиты за эту задачу не списаны.',
  expired: 'Отложенные кредиты были из прошлого периода тарифа и в новый не переносятся.',
})

/** null — no sentence: nothing is promised that the code has not done. */
export const feedCreditsSentence = (credits: FeedCreditsState | null): string | null =>
  credits === null ? null : feedCreditsText[credits]

// ---------------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------------

/** Why the task was stopped, by `by` of the row. */
export const feedCancelledText: Readonly<Record<FeedCancelledBy, string>> = Object.freeze({
  not_available:
    'Эта задача требует изменений в файлах сайта, а применять их из кабинета пока нельзя.',
  queue_timeout: 'Не смогли взяться за задачу за сутки и отменили её.',
  customer: 'Вы остановили задачу.',
  declined: 'Вы решили не применять изменения.',
  stopped: 'Вы остановили задачу.',
  no_answer: 'Задача отменена: мы не дождались ответа.',
})

/** The last line of the plate of a task cancelled after a day in the queue. */
export const FEED_QUEUE_TIMEOUT_CLOSING = 'Отправьте задачу снова, когда будет удобно.'

/** A participant whose account no longer exists. */
export const FEED_REMOVED_AUTHOR = 'Участник'

/**
 * The reason on the «Отменено» plate. `stoppedBy` is the name of another participant who
 * stopped the task: given only when the workspace has several and the author is not the
 * reader. null — a way of cancelling this code does not know: the plate stands alone.
 */
export function feedCancelledSentence(
  by: FeedCancelledBy | null,
  stoppedBy?: string,
): string | null {
  if (by === null) return null
  // The sentence brings its own full stop: «Иван П.» must not end in two.
  const name = stoppedBy?.trim().replace(/[.\s]+$/u, '') ?? ''
  if ((by === 'customer' || by === 'stopped') && name !== '') return `Задачу остановил(а) ${name}.`
  return feedCancelledText[by]
}

// ---------------------------------------------------------------------------------------------
// The platform's question about credits (`feed.question`, kind `ceiling`)
// ---------------------------------------------------------------------------------------------

/** «37 кредитов», «1 кредит», «2 500 кредитов» — the number with its noun. */
export const creditsCountText = (count: number): string =>
  `${groupDigits(count)} ${pluralRu(count, 'кредит', 'кредита', 'кредитов')}`

// After «до» and «из»: «до 1 кредита», «до 45 кредитов».
const creditsUpToText = (count: number): string =>
  `${groupDigits(count)} ${pluralRu(count, 'кредита', 'кредитов', 'кредитов')}`
const spentText = (count: number): string =>
  `${pluralRu(count, 'ушёл', 'ушло', 'ушло')} ${creditsCountText(count)}`
const ofHeldText = (count: number): string =>
  `${groupDigits(count)} ${pluralRu(count, 'отложенного', 'отложенных', 'отложенных')}`
const allHeldText = (count: number): string =>
  `${pluralRu(count, 'ушёл весь', 'ушли все', 'ушли все')} ${groupDigits(count)} ` +
  `${pluralRu(count, 'отложенный', 'отложенных', 'отложенных')} ` +
  pluralRu(count, 'кредит', 'кредита', 'кредитов')
const leftShortText = (count: number): string =>
  `${pluralRu(count, 'оставшегося', 'оставшихся', 'оставшихся')} ${groupDigits(count)} не хватает на следующий шаг`

/** The three numbers of a `ceiling` row, in credits. */
export interface FeedCeilingNumbers {
  reason: FeedCeilingReason
  /** Spent on the task. */
  spent: number
  /** Held for it. */
  held: number
  /** Left of the hold. */
  left: number
}

/**
 * What billing knows when the question is shown; a row stores none of it. Each part is
 * optional, and a sentence that needs a missing part is left out.
 */
export interface FeedCeilingOffer {
  /** `step`: how many credits the next attempt would hold. */
  nextHold?: number
  /** `credits`: the pack on sale; `price` is the amount as shown, without the currency sign. */
  pack?: { credits: number; price: string }
  /** `credits`: the next period starts before the wait ends; `date` as shown («18 октября»). */
  renewal?: { date: string; credits: number }
}

const NOT_APPLIED_IF_STOPPED =
  'Если остановить задачу, кредиты за неё не спишутся, а изменения не будут применены.'

/**
 * The text of the platform's question — docs/research/2026-10-credits/credits-design.md §5.2,
 * cases B1 (`step`), B2, B2б and B3 (`credits`), B4 (`gift`) and B6 (`attempts`).
 */
export function feedCeilingText(
  question: FeedCeilingNumbers,
  offer: FeedCeilingOffer = {},
): string {
  const { spent, held, left } = question
  const sentences: string[] = []
  switch (question.reason) {
    case 'step':
      sentences.push(
        `Задача оказалась больше обычной: на неё уже ${spentText(spent)} из ${ofHeldText(held)}.`,
        'Продолжить?',
      )
      if (offer.nextHold !== undefined)
        sentences.push(
          `Отложим ещё до ${creditsUpToText(offer.nextHold)} и спишем только то, что уйдёт на работу.`,
        )
      sentences.push(
        'Если остановиться, кредиты за эту задачу не спишутся, а изменения не будут применены.',
      )
      break
    case 'credits':
      sentences.push(
        left > 0
          ? `Лимиты закончились посреди задачи: на неё ${spentText(spent)} из ${ofHeldText(held)}, а ${leftShortText(left)}.`
          : `Лимиты закончились посреди задачи: на неё ${allHeldText(held)}.`,
        'Работа сохранена.',
      )
      if (offer.pack)
        sentences.push(
          `Купите пакет — ${creditsCountText(offer.pack.credits)} за ${offer.pack.price} ₽ — и продолжим с того же места.`,
        )
      if (offer.renewal)
        sentences.push(
          `Или дождитесь ${offer.renewal.date}: начислим ${creditsCountText(offer.renewal.credits)} по тарифу, и задачу можно будет продолжить.`,
        )
      sentences.push(NOT_APPLIED_IF_STOPPED)
      break
    case 'gift':
      sentences.push(
        left > 0
          ? `Подарочные кредиты закончились посреди задачи: на неё ушло ${groupDigits(spent)} из ${groupDigits(held)}, а ${leftShortText(left)}.`
          : `Подарочные кредиты закончились посреди задачи: на неё ушли все ${groupDigits(held)}.`,
        'Работа сохранена.',
        'Выберите тариф — и продолжим с того же места.',
        'Если остановить задачу, подарочные кредиты вернутся, а изменения не будут применены.',
      )
      break
    case 'attempts':
      sentences.push(
        `Задача оказалась слишком большой: на неё уже ${spentText(spent)}.`,
        'Её лучше разбить на части или передать специалисту.',
        NOT_APPLIED_IF_STOPPED,
      )
      break
  }
  return sentences.join(' ')
}

/** The buttons of the question: the way on, when there is one, and the way out. */
export const feedCeilingButtons: Readonly<
  Record<FeedCeilingReason, { readonly next: string; readonly stop: string }>
> = Object.freeze({
  step: { next: 'Продолжить', stop: 'Остановиться' },
  credits: { next: 'Купить пакет', stop: 'Остановить задачу' },
  gift: { next: 'Выбрать тариф', stop: 'Остановить задачу' },
  attempts: { next: 'Передать специалисту', stop: 'Остановить задачу' },
})

// ---------------------------------------------------------------------------------------------
// Rows the reader cannot show as they are, and the customer's own presses
// ---------------------------------------------------------------------------------------------

/** What a row reads as when it is not the customer's words or the agent's. */
export const feedRowText = Object.freeze({
  /** `newer`: a type, a version or a question this page does not know yet. */
  newer: 'Здесь появилось новое сообщение. Обновите страницу, чтобы его увидеть.',
  /** `unreadable`: a reload would not help, and the text does not advise one. */
  unreadable: 'Не удалось показать это сообщение. Напишите нам, если оно важно.',
  /** `feed.request` of the kind `retry`. */
  retry: 'Вы попросили попробовать ещё раз',
  /** `feed.request` of a kind added later, when it carries no text. */
  otherRequest: 'Вы продолжили задачу.',
})

/** Titles of the cards and plates of the feed. */
export const feedCardTitle = Object.freeze({
  question: 'Вопрос агента',
  result: taskStatusLabel.done,
  approval: 'Что изменится',
  failure: taskStatusLabel.failed,
  cancelled: taskStatusLabel.cancelled,
  rolledBack: taskStatusLabel.rolled_back,
})

/** The lines of the agent's question card and of the field under it. */
export const feedQuestionText = Object.freeze({
  /** Under the card. */
  waiting: 'Агент продолжит, когда вы ответите.',
  /** Under the card when there are several questions. */
  oneMessage: 'Ответьте одним сообщением.',
  placeholder: 'Ваш ответ',
  send: 'Ответить',
  /** An answer to a question that already has one. */
  answered: 'На этот вопрос уже ответили.',
})

/** The lines next to «Попробовать ещё» on the failure card. */
export const feedRetryText = Object.freeze({
  button: 'Попробовать ещё',
  hint: 'Повторная попытка может стоить больше кредитов.',
  /** The code allowed a retry, but the counted attempts are spent. */
  noAttempts: 'Больше попыток для этой задачи нет. Начните новый диалог или напишите нам.',
  /** The daily limit refused the press. */
  dailyLimit: 'Лимит на сегодня исчерпан. Попробовать ещё раз можно будет завтра.',
  /** The site is not connected. */
  siteNotConnected: 'Сайт ещё не подключён. Задачи можно будет ставить после подключения',
})

/** The input area of a dialog. */
export const feedInputText = Object.freeze({
  /** The hint of the field while the agent works; read from the field itself. */
  disabled: 'Написать можно будет, когда агент закончит или задаст вопрос.',
  /** In place of the field when the task has ended. */
  finished: 'Диалог завершён. Чтобы попросить что-то ещё, начните новый.',
  newDialog: 'Новый диалог',
  /** The two standing lines under the field. */
  mistakes: 'ИИ может допускать ошибки. Проверяйте важное.',
  noSecrets: 'Не отправляйте в чат пароли и ключи: доступы задаются в разделе «Настройки»',
  /** The refusal `TASK_TEXT_HAS_SECRET`: the text stays in the field. */
  secret:
    'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Настройки»',
})

/** The message is longer than `limit` characters (`feedLimits.requestText`). */
export const feedTooLongText = (limit: number): string =>
  `Сообщение слишком длинное — сократите его до ${Math.trunc(limit)} знаков`

/** States of the feed itself and of the list of dialogs. */
export const feedStateText = Object.freeze({
  /** A poll failed: what is shown stays. */
  pollFailed: 'Не удалось обновить диалог. Пробуем ещё раз…',
  /** The button after three failed polls. */
  refresh: 'Обновить',
  listFailed: 'Не удалось загрузить диалоги.',
  listRetry: 'Повторить',
  /** The link of the «not found» screen. */
  toProjects: 'К проектам',
  openSite: 'Открыть сайт',
})
