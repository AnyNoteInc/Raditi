import { pluralRu } from '../plural.ts'
import type { PreviewUnavailableReason } from '../preview/preview-state.ts'
import type { ChatCommandId } from '../release/chat-commands.ts'
import type { VersionBump } from '../release/semver.ts'
import type {
  FeedBrowserReason,
  FeedCancelledBy,
  FeedCeilingReason,
  FeedCreditsState,
  FeedFailurePayload,
  FeedObjectKind,
  FeedObjectStatus,
  FeedReleaseOutcome,
  FeedReleaseReason,
  FeedResultPayload,
  FeedUpdateOutcome,
  FeedUndoReason,
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
 * Telegram: no markup, nothing but words. Besides the plural of a noun (`plural.ts`, which
 * imports nothing), types only are imported, so the module carries no other runtime dependency.
 */

export { pluralRu }

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

/**
 * The word of a dialog that waits for nothing — the agent answered and asked no question
 * (`awaiting_user` after a `feed.result`; owner's answer of 26.10.2026: «ожидает ввода также не
 * нужно», a chat like Claude Code) — in place of «Нужен ваш ответ»; the list has no hint for it.
 */
export const taskAnsweredLabel = 'Агент ответил'

/** The second line of a dialog in the list; null — the status has none. */
export const taskStatusListHint: Readonly<Record<TaskStatus, string | null>> = Object.freeze({
  queued: null,
  preparing: null,
  running: null,
  awaiting_user: 'Ответьте агенту',
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
  /** A task in the browser while the agent works in it (docs/plan/57-browser-tasks.md). */
  browser:
    'Агент работает в браузере задачи — за ним можно наблюдать. Страницу можно закрыть — результат появится в этом диалоге.',
  /** A task in the browser while the customer controls it. */
  browserControl: 'Вы управляете браузером, агент ждёт.',
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

/**
 * The third sentence of a failure and of a cancellation, by the trusted `credits`: what the pass
 * that ended so had set aside came back — the passes before it were charged when they ended
 * (owner's answer of 26.10.2026), so the sentence is about this request, not the whole dialog.
 */
export const feedCreditsText: Readonly<Record<FeedCreditsState, string>> = Object.freeze({
  returned: 'За этот запрос кредиты не списаны.',
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

/**
 * What stopping does to the money: every pass is charged when it ends (owner's answer of
 * 26.10.2026), so the work done up to the question stays charged, and what a task in the browser
 * did is on the site already — the sentence promises neither a refund nor an undo (28.10.2026).
 */
const NOTHING_MORE_IF_STOPPED = 'Если остановить задачу, больше ничего не спишем.'

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
      sentences.push('Если остановиться, больше ничего не спишем.')
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
      sentences.push(NOTHING_MORE_IF_STOPPED)
      break
    case 'gift':
      sentences.push(
        left > 0
          ? `Подарочные кредиты закончились посреди задачи: на неё ушло ${groupDigits(spent)} из ${groupDigits(held)}, а ${leftShortText(left)}.`
          : `Подарочные кредиты закончились посреди задачи: на неё ушли все ${groupDigits(held)}.`,
        'Работа сохранена.',
        'Выберите тариф — и продолжим с того же места.',
        'Если остановить задачу, больше ничего не спишем, а неистраченные подарочные кредиты вернутся.',
      )
      break
    case 'attempts':
      sentences.push(
        `Задача оказалась слишком большой: на неё уже ${spentText(spent)}.`,
        'Её лучше разбить на части или передать специалисту.',
        NOTHING_MORE_IF_STOPPED,
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
  /** `feed.request` of the kind `continue`: «Продолжить» after a question about credits. */
  continue: 'Вы попросили продолжить работу',
  /** `feed.request` of the kind `resume`: «Продолжить работу агента» in the browser. */
  resume: 'Вы вернули управление агенту',
  /** `feed.request` of a kind added later, when it carries no text. */
  otherRequest: 'Вы продолжили задачу.',
})

/** Titles of the cards and plates of the feed. */
export const feedCardTitle = Object.freeze({
  question: 'Вопрос агента',
  result: taskStatusLabel.done,
  /** A result that left the dialog open (`next: 'awaiting_user'`): the task has not ended. */
  answer: 'Ответ агента',
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

/**
 * The last sentence of a failure card when the dialog kept its candidate (`feed.failure` with
 * `next: 'awaiting_approval'`). What can be done with the changes is the candidate card's to say.
 */
export const feedFailureKeptText = 'Изменения, готовые до этого, мы сохранили.'

/**
 * The last sentence of a failure card when the dialog stays open (`feed.failure` with `next:
 * 'awaiting_user'`, owner's decision of 28.10.2026): the client writes, and the agent goes on.
 */
export const feedFailureOpenText =
  'Диалог не закрыт: напишите «продолжи», и агент продолжит с того места, где остановился.'

/**
 * The last sentence of a result that left the dialog open (`feed.result` with `next:
 * 'awaiting_user'`, owner's decision of 26.10.2026): nothing to release, the client writes on.
 */
export const feedResultOpenText =
  'Если нужно что-то ещё, напишите — агент продолжит в этом диалоге.'

/** The lines next to «Попробовать ещё» on the failure card. */
export const feedRetryText = Object.freeze({
  button: 'Попробовать ещё',
  hint: 'Повторная попытка может стоить больше кредитов.',
  /** The code allowed a retry, but the counted attempts are spent. */
  noAttempts: 'Больше попыток для этой задачи нет. Начните новый диалог или напишите нам.',
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
  noSecrets: 'Не отправляйте в чат пароли и ключи: доступы задаются в разделе «Переменные»',
  /** The refusal `TASK_TEXT_HAS_SECRET`: the text stays in the field. */
  secret:
    'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные»',
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

// ---------------------------------------------------------------------------------------------
// A candidate, the preview and the release (docs/plan/53-chat-preview-release.md)
// ---------------------------------------------------------------------------------------------

/** «1.4.0»: a version as the client reads it, without the letter of the tag. */
export const feedVersionText = (tag: string): string => tag.replace(/^v/, '')

/** Why this number is proposed. */
export const feedVersionBumpLabel: Readonly<Record<VersionBump, string>> = Object.freeze({
  patch: 'Исправления',
  minor: 'Новые возможности',
  major: 'Крупные изменения',
})

/** The card of a pass that left changes (`feed.candidate`). */
export const feedCandidateText = Object.freeze({
  title: 'Изменения готовы',
  hint: 'Посмотрите их в предпросмотре справа. Если всё в порядке, выпустите новую версию сайта.',
  /** Under the card while the dialog waits: words start a new pass on top of these changes. */
  revise: 'Если нужно что-то поправить, напишите — агент продолжит с этого места.',
  release: 'Выпустить новую версию',
})

/** «Предлагаем выпустить как версию 1.4.0». */
export const feedCandidateVersionText = (tag: string): string =>
  `Предлагаем выпустить как версию ${feedVersionText(tag)}`

/** Shown when a candidate changes records of the site. */
export const feedRecordsChangedText = (count: number): string =>
  `Изменится записей на сайте: ${groupDigits(count)}`

/** Shown when a candidate adds media files. */
export const feedMediaAddedText = (count: number): string =>
  `Добавится медиафайлов: ${groupDigits(count)}`

/** The customer's own command, as the feed shows it (`feed.request` of the kind `command`). */
export const feedCommandText: Readonly<Record<ChatCommandId, string>> = Object.freeze({
  release: 'Вы попросили выпустить новую версию',
  preview: 'Вы открыли предпросмотр',
  reset: 'Вы сбросили данные предпросмотра',
  update: 'Вы попросили обновить рабочую копию',
  // Never a row of the kind `command`: the press is written as `retry` (`feedRowText.retry`).
  retry: 'Вы попросили попробовать ещё раз',
  cancel: 'Вы отменили диалог',
  undo: 'Вы попросили отменить выпуск',
})

/** `feed.decision` of the kind `release`. */
export const feedDecisionText = (tag: string): string =>
  `Вы решили выпустить версию ${feedVersionText(tag)}.`

/** The title of the plate of a release by its outcome. */
export const feedReleaseTitle: Readonly<Record<FeedReleaseOutcome, string>> = Object.freeze({
  installed: 'Версия установлена',
  rolled_back: taskStatusLabel.rolled_back,
  failed: 'Версию не установили',
  unknown: 'Проверяем сайт',
  refused: 'Выпуск не начат',
})

/** The first sentence of the plate. */
export function feedReleaseText(outcome: FeedReleaseOutcome, tag: string): string {
  const version = feedVersionText(tag)
  switch (outcome) {
    case 'installed':
      return `Версия ${version} установлена на сайт.`
    case 'rolled_back':
      return `Версию ${version} установить не удалось, и мы вернули сайт к прежнему состоянию.`
    case 'failed':
      return `Версию ${version} установить не удалось. На сайте ничего не изменилось.`
    case 'unknown':
      return `Не удалось подтвердить, что версия ${version} установлена. Мы разбираемся; пока не закончим, новые версии на сайт не выкладываются.`
    case 'refused':
      return `Выпуск версии ${version} не начат. На сайте ничего не изменилось.`
  }
}

/** The second sentence: why it ended so; null in `reason` — none. */
export const feedReleaseReasonText: Readonly<Record<FeedReleaseReason, string>> = Object.freeze({
  conflict:
    'На сайте за это время изменились те же файлы или записи. Обновите рабочую копию и проверьте изменения ещё раз.',
  outdated: 'Сайт изменился после начала диалога. Обновите рабочую копию и выпустите версию снова.',
  not_started: 'Установка не началась вовремя. Попробуйте выпустить версию ещё раз.',
  site_check: 'После установки сайт не прошёл проверку.',
  technical: 'Произошёл технический сбой.',
  not_allowed: 'Выпускать версии могут только владелец и администраторы рабочего пространства.',
  checks_failed:
    'Проверки изменений не прошли. Откройте вкладку «Проверки», попросите исправить ошибки и выпустите версию снова.',
  site_inactive:
    'Сайт сейчас не подключён к Радити. Возобновите подключение и выпустите версию снова.',
  client_variable:
    'В изменениях записей есть значение переменной окружения сайта. Попросите убрать его и выпустите версию снова.',
  site_broken_before:
    'Сайт не отвечал как обычно ещё до установки, поэтому мы ничего на нём не меняли. Проверьте, что сайт открывается, и выпустите версию снова.',
  plugin_outdated:
    'Модуль «Радити» на сайте устарел и не умеет переносить такие изменения базы данных. Напишите нам — поможем обновить модуль.',
  slug_taken:
    'На сайте уже есть страница с адресом, который выбрал агент. Попросите агента выбрать другой адрес и выпустите версию снова.',
  values_unavailable:
    'Не удалось показать изменения базы данных перед выпуском. Напишите в диалог, чтобы агент собрал изменения заново, и выпустите версию снова.',
  created_id_in_code:
    'В коде изменений указан номер новой страницы из предпросмотра, а на сайте у неё будет другой номер. Попросите агента ссылаться на новую страницу по её адресу и выпустите версию снова.',
  site_unreachable:
    'Модуль «Радити» на сайте не ответил, поэтому мы не смогли сверить изменения базы данных. Проверьте, что сайт открывается, и выпустите версию снова.',
})

/**
 * What a rollback left on the site (`feed.release.kept`): new tables and columns stay — the
 * version before does not use them, and removing them would take what the site wrote into them;
 * a new page or post of the release stays too when someone changed it after the release or
 * something of the site already stands on it (comments, a menu item). The count is all the row
 * keeps — not which kind of record, nor why —, so the words name both. Empty — nothing.
 */
export function feedReleaseKeptText(
  kept: { records: number; tables: number } | undefined,
): string[] {
  if (!kept) return []
  return [
    kept.tables > 0
      ? 'Новые таблицы и поля базы данных остались на сайте: прежняя версия их не использует, а удаление стёрло бы то, что сайт успел в них записать.'
      : null,
    kept.records === 1
      ? 'Страница или запись, которую добавил выпуск, осталась на сайте: после выпуска её изменили или к ней уже что-то добавили, поэтому мы её не убрали. Если она не нужна, удалите её в админке сайта.'
      : kept.records > 1
        ? `Страницы и записи, которые добавил выпуск, остались на сайте (${groupDigits(kept.records)}): после выпуска их изменили или к ним уже что-то добавили, поэтому мы их не убрали. Если они не нужны, удалите их в админке сайта.`
        : null,
  ].filter((line): line is string => line !== null)
}

// ---------------------------------------------------------------------------------------------
// «Отменить выпуск» (docs/plan/53, «Отмена выпуска»)
// ---------------------------------------------------------------------------------------------

/** The press of the client (`feed.undo`, stage `confirmed`). */
export const feedUndoConfirmedText = (undone: string): string =>
  `Вы решили отменить выпуск ${feedVersionText(undone)}.`

/** The title of the plate of an undo by its outcome. */
export const feedUndoTitle: Readonly<Record<FeedReleaseOutcome, string>> = Object.freeze({
  installed: 'Выпуск отменён',
  rolled_back: 'Выпуск не отменили',
  failed: 'Выпуск не отменили',
  unknown: 'Проверяем сайт',
  refused: 'Отмена не начата',
})

/** The first sentence of the plate: `undone` — the version undone, `version` — the undo's own. */
export function feedUndoText(
  outcome: FeedReleaseOutcome,
  versions: { undone: string; version: string; returnsTo: string },
): string {
  const undone = feedVersionText(versions.undone)
  switch (outcome) {
    case 'installed':
      return `Сайт вернулся к версии ${feedVersionText(versions.returnsTo)}; теперь на нём версия ${feedVersionText(versions.version)}.`
    case 'rolled_back':
      return `Вернуть версию ${feedVersionText(versions.returnsTo)} не удалось, и сайт остался на версии ${undone}.`
    case 'failed':
      return `Отменить выпуск ${undone} не удалось. На сайте ничего не изменилось.`
    case 'unknown':
      return `Не удалось подтвердить, что выпуск ${undone} отменён. Мы разбираемся; пока не закончим, новые версии на сайт не выкладываются.`
    case 'refused':
      return `Отмена выпуска ${undone} не начата. На сайте ничего не изменилось.`
  }
}

/** The second sentence of an undo that did not end `installed`. */
export function feedUndoReasonText(reason: FeedUndoReason): string {
  switch (reason) {
    case 'conflict':
      return 'Пока мы готовили возврат, на сайте изменились файлы или записи, которые менял выпуск. Откройте «Отменить выпуск» ещё раз — мы проверим заново.'
    case 'undo_outdated':
    case 'outdated':
      return 'После этого выпуска на сайт установили другую версию.'
    case 'site_check':
      return 'После возврата сайт не прошёл проверку.'
    case 'site_broken_before':
      return 'Сайт не отвечал как обычно ещё до возврата, поэтому мы ничего на нём не меняли. Проверьте, что сайт открывается, и отмените выпуск снова.'
    case 'not_allowed':
      return 'Отменять выпуски могут только владелец и администраторы рабочего пространства.'
    case 'site_inactive':
      return 'Сайт сейчас не подключён к Радити. Возобновите подключение и отмените выпуск снова.'
    case 'site_unreachable':
      return 'Модуль «Радити» на сайте не ответил, поэтому мы не смогли сверить записи. Проверьте, что сайт открывается, и отмените выпуск снова.'
    case 'plugin_outdated':
      return feedReleaseReasonText.plugin_outdated
    case 'not_started':
      return 'Возврат не начался вовремя. Попробуйте отменить выпуск ещё раз.'
    default:
      return feedReleaseReasonText.technical
  }
}

/**
 * What an installed undo left as the site holds it: records someone changed or removed after the
 * release, new pages the site built on since. null — none.
 */
export function feedUndoKeptText(kept: number): string | null {
  return kept > 0
    ? `Не вернули записей: ${groupDigits(kept)} — после выпуска их изменили на сайте или к ним уже что-то добавили.`
    : null
}

/** The title of the plate of an «Обновить» that left no new revision (`feed.update`). */
export const feedUpdateTitle: Readonly<Record<FeedUpdateOutcome, string>> = Object.freeze({
  emptied: 'Изменения уже на сайте',
  conflict: 'Рабочую копию не обновили',
  current: 'Рабочая копия уже обновлена',
  withdrawn: 'Рабочую копию не обновили',
  failed: 'Рабочую копию не обновили',
})

/** What came of the «Обновить»; `conflicts` — files of the dialog the site changed too. */
export function feedUpdateText(outcome: FeedUpdateOutcome, conflicts: number): string {
  switch (outcome) {
    case 'emptied':
      return 'Все изменения этого диалога уже есть на сайте, выпускать их не нужно.'
    case 'conflict':
      return `На сайте за это время изменились те же места, что и в этом диалоге${conflicts > 0 ? ` (файлов: ${groupDigits(conflicts)})` : ''}, поэтому изменения не переносятся на новую версию сайта сами. Отмените этот диалог и опишите задачу в новом — агент сделает её на новой версии сайта.`
    case 'current':
      return 'Изменения этого диалога уже собраны на последней версии сайта.'
    case 'withdrawn':
      return 'Вы написали в диалог, пока мы обновляли рабочую копию, поэтому её не обновили. Когда агент закончит, попросите обновить её снова.'
    case 'failed':
      return 'Произошёл технический сбой. Попробуйте обновить рабочую копию ещё раз позже.'
  }
}

/** The panel to the right of a dialog. */
export const previewPanelText = Object.freeze({
  preview: 'Предпросмотр',
  files: 'Файлы',
  database: 'База данных',
  checks: 'Проверки',
  openInNewTab: 'Открыть в новой вкладке',
  /** While the preview is built or rebuilt. */
  building: 'Готовим предпросмотр…',
  /** The preview stopped after days without a look; opening it builds it again. */
  expired:
    'Предпросмотр остановлен, потому что его давно не открывали. Откройте его снова — мы его подготовим.',
  failed: 'Не удалось подготовить предпросмотр. Попробуйте сбросить его данные или напишите нам.',
})

/** Why there is no preview, by `unavailable_reason` (Р4, Р16): said plainly, never drawn. */
export const previewUnavailableText: Readonly<Record<PreviewUnavailableReason, string>> =
  Object.freeze({
    no_database:
      'Предпросмотр недоступен: у нас нет доступа к базе данных сайта. Изменения в файлах можно посмотреть на вкладке «Файлы».',
    no_core: 'Предпросмотр недоступен: в копии сайта нет файлов, без которых он не запускается.',
    not_supported: 'Для сайтов этого типа предпросмотр пока не работает.',
  })

// ---------------------------------------------------------------------------------------------
// A task in the browser (docs/plan/57-browser-tasks.md, Б15–Б24)
// ---------------------------------------------------------------------------------------------

/** The buttons of the browser of a task; the texts below name them. */
export const feedBrowserButtons = Object.freeze({
  take: 'Взять управление',
  resume: 'Продолжить работу агента',
  stop: 'Остановить',
})

const RESUME = `«${feedBrowserButtons.resume}»`

/** The title of a `browser` question by its reason. */
export const feedBrowserQuestionTitle: Readonly<Record<FeedBrowserReason, string>> = Object.freeze({
  login: 'Нужно войти на сайт',
  captcha: 'Нужно пройти проверку',
  confirm: 'Нужно ваше подтверждение',
  other: 'Нужна ваша помощь',
  control: 'Вы управляете браузером',
  unconfirmed: 'Результат не подтверждён',
})

/**
 * What the customer is asked to do, by the reason. The agent's own words of the request, when
 * the row has them, are shown under this text.
 */
export const feedBrowserQuestionText: Readonly<Record<FeedBrowserReason, string>> = Object.freeze({
  login: `Агенту нужно, чтобы вы вошли в админку сайта. Войдите в браузере задачи и нажмите ${RESUME}. Пароль агент не увидит.`,
  captcha: `Сайт просит подтвердить, что вы не робот. Пройдите проверку в браузере задачи и нажмите ${RESUME}.`,
  confirm: `Сайт просит подтверждения — например, код из письма или сообщения. Подтвердите в браузере задачи и нажмите ${RESUME}.`,
  other: `Агенту нужна ваша помощь в браузере задачи. Когда закончите, нажмите ${RESUME}.`,
  control: `Пока браузером управляете вы, агент не работает. Когда закончите, нажмите ${RESUME} или напишите, что сделать дальше.`,
  unconfirmed:
    'Агент закончил, но мы не нашли на сайте сохранённого результата. Проверьте сайт в браузере задачи и напишите агенту, что сделать дальше.',
})

/** An object of the site in a result, a failure or a cancellation, by its kind. */
export const feedObjectKindLabel: Readonly<Record<FeedObjectKind, string>> = Object.freeze({
  post: 'Запись',
  page: 'Страница',
})

/** The state the platform read on the site. */
export const feedObjectStatusLabel: Readonly<Record<FeedObjectStatus, string>> = Object.freeze({
  published: 'Опубликовано',
  scheduled: 'Запланировано',
  draft: 'Черновик',
  pending: 'Ждёт проверки',
  private: 'Скрыто от посетителей',
  trashed: 'В корзине',
  missing: 'Нет на сайте',
  unconfirmed: 'Состояние не подтверждено',
})

/** The lines around the objects of a row. */
export const feedObjectText = Object.freeze({
  /** Above the objects of a result. */
  result: 'Что на сайте',
  /** Above the objects of a failure or a cancellation: what the platform found there. */
  ended: 'Что сейчас на сайте',
  /** An object without a title. */
  untitled: 'Без названия',
  /** A kind this page does not know. */
  otherKind: 'Объект',
  open: 'Открыть на сайте',
  edit: 'Открыть в редакторе',
})
