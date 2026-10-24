import { describe, expect, it } from 'vitest'
import { previewUnavailableReasons } from '../preview/preview-state.ts'
import { chatCommandIds } from '../release/chat-commands.ts'
import { versionBumps } from '../release/semver.ts'
import {
  feedBrowserReasons,
  feedCancelledBys,
  feedCeilingReasons,
  feedCreditsStates,
  feedLimits,
  feedObjectKinds,
  feedObjectStatuses,
  feedReleaseOutcomes,
  feedReleaseReasons,
  feedSteps,
  taskModes,
  taskWaitingReasons,
} from './client-feed.ts'
import * as labels from './client-feed-labels.ts'
import {
  creditsCountText,
  FEED_QUEUE_TIMEOUT_CLOSING,
  FEED_REMOVED_AUTHOR,
  feedApprovalSiteText,
  feedBrowserButtons,
  feedBrowserQuestionText,
  feedBrowserQuestionTitle,
  feedObjectKindLabel,
  feedObjectStatusLabel,
  feedObjectText,
  feedCandidateText,
  feedCandidateVersionText,
  feedCommandText,
  feedDecisionText,
  feedMediaAddedText,
  feedRecordsChangedText,
  feedReleaseKeptText,
  feedReleaseReasonText,
  feedReleaseText,
  feedReleaseTitle,
  feedVersionBumpLabel,
  feedVersionText,
  previewPanelText,
  previewUnavailableText,
  feedCancelledSentence,
  feedCancelledText,
  feedCardTitle,
  feedCeilingButtons,
  feedCeilingText,
  feedCreditsSentence,
  feedCreditsText,
  feedDoneSiteText,
  feedDurationText,
  feedEndedSiteText,
  feedFilesChangedText,
  feedInputText,
  feedLiveText,
  feedQuestionText,
  feedQueuedText,
  feedRetryText,
  feedRowText,
  feedStateText,
  feedStepLabel,
  feedTooLongText,
  feedWaitingText,
  feedWorkedText,
  pluralRu,
  taskListGroupLabel,
  taskModeLabel,
  taskStatusLabel,
  taskStatusListHint,
} from './client-feed-labels.ts'
import { isFeedText } from './client-feed-text.ts'
import { taskStatuses } from './task-status.ts'

const sorted = (values: readonly string[]) => [...values].sort()

/** Every string of a table, however deep; null marks «no text» and is left out. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(stringsOf)
}

const pack = { credits: 100, price: '1 990' }
const renewal = { date: '18 октября', credits: 300 }

/** What the functions of the catalogue return, over the inputs that change the wording. */
const composed: string[] = [
  ...[null, ...taskWaitingReasons].map(feedQueuedText),
  ...[0, 14, 134, 1200].flatMap((seconds) => [feedDurationText(seconds), feedWorkedText(seconds)]),
  feedFilesChangedText(3),
  ...feedCancelledBys.flatMap((by) => [
    feedCancelledSentence(by) ?? '',
    feedCancelledSentence(by, 'Анна Петрова') ?? '',
  ]),
  ...feedCeilingReasons.flatMap((reason) =>
    [
      { spent: 37, held: 45, left: 8 },
      { spent: 12, held: 12, left: 0 },
      { spent: 1, held: 21, left: 1 },
      { spent: 3, held: 4, left: 1 },
      { spent: 0, held: 1, left: 1 },
    ].flatMap((numbers) => [
      feedCeilingText({ reason, ...numbers }),
      feedCeilingText({ reason, ...numbers }, { nextHold: 45, pack, renewal }),
    ]),
  ),
  feedTooLongText(feedLimits.requestText),
  ...[0, 1, 2, 5, 21, 2500].map(creditsCountText),
  ...['v0.0.1', 'v1.4.0', 'v12.0.0'].flatMap((tag) => [
    feedCandidateVersionText(tag),
    feedDecisionText(tag),
    ...feedReleaseOutcomes.map((outcome) => feedReleaseText(outcome, tag)),
  ]),
  feedRecordsChangedText(3),
  feedMediaAddedText(2500),
]

const tables = Object.values(labels).filter((value) => typeof value !== 'function')
const allTexts = [...tables.flatMap(stringsOf), ...composed]

describe('totality of the catalogue', () => {
  it('has a label for each of the eleven statuses', () => {
    expect(taskStatuses).toHaveLength(11)
    expect(sorted(Object.keys(taskStatusLabel))).toEqual(sorted(taskStatuses))
    expect(sorted(Object.keys(taskStatusListHint))).toEqual(sorted(taskStatuses))
    for (const status of taskStatuses) expect(taskStatusLabel[status]).not.toBe('')
  })

  it('gives a second list line only to the two statuses that wait for the customer', () => {
    const withHint = taskStatuses.filter((status) => taskStatusListHint[status] !== null)
    expect(withHint).toEqual(['awaiting_user', 'awaiting_approval'])
  })

  it('has a text for every stage, waiting reason, mode, credits state and way of cancelling', () => {
    expect(sorted(Object.keys(feedStepLabel))).toEqual(sorted(feedSteps))
    expect(sorted(Object.keys(feedWaitingText))).toEqual(sorted(taskWaitingReasons))
    expect(sorted(Object.keys(taskModeLabel))).toEqual(sorted(taskModes))
    expect(sorted(Object.keys(feedCreditsText))).toEqual(sorted(feedCreditsStates))
    expect(sorted(Object.keys(feedCancelledText))).toEqual(sorted(feedCancelledBys))
    expect(sorted(Object.keys(feedCeilingButtons))).toEqual(sorted(feedCeilingReasons))
  })

  it('names the groups of the list and the modes of a task', () => {
    expect(taskListGroupLabel).toEqual({
      awaiting: 'Ждёт вашего решения',
      today: 'Сегодня',
      earlier: 'Ранее',
    })
    expect(taskModeLabel).toEqual({ work: 'Работа', chat: 'Чат' })
  })

  it('has a phrase about the site for every state an outcome may carry', () => {
    expect(sorted(Object.keys(feedEndedSiteText))).toEqual(['check', 'restored', 'unchanged'])
    expect(sorted(Object.keys(feedDoneSiteText))).toEqual(['changed', 'check', 'unchanged'])
    expect(sorted(Object.keys(feedApprovalSiteText))).toEqual(['changed', 'check', 'unchanged'])
  })

  it('has a question text for every ceiling reason', () => {
    for (const reason of feedCeilingReasons)
      expect(feedCeilingText({ reason, spent: 10, held: 12, left: 2 })).not.toBe('')
  })

  it('has a text for every command, version kind, release outcome and reason, and preview gap', () => {
    expect(sorted(Object.keys(feedCommandText))).toEqual(sorted(chatCommandIds))
    expect(sorted(Object.keys(feedVersionBumpLabel))).toEqual(sorted(versionBumps))
    expect(sorted(Object.keys(feedReleaseTitle))).toEqual(sorted(feedReleaseOutcomes))
    expect(sorted(Object.keys(feedReleaseReasonText))).toEqual(sorted(feedReleaseReasons))
    expect(sorted(Object.keys(previewUnavailableText))).toEqual(sorted(previewUnavailableReasons))
    expect(Object.keys(previewPanelText)).toEqual(
      expect.arrayContaining(['preview', 'files', 'database', 'checks', 'openInNewTab']),
    )
    expect(feedCandidateText.release).toBe('Выпустить новую версию')
  })

  it('says what a rollback left on the site', () => {
    expect(feedReleaseKeptText(undefined)).toEqual([])
    expect(feedReleaseKeptText({ records: 0, tables: 0 })).toEqual([])
    const [tables, records] = feedReleaseKeptText({ records: 1, tables: 2 })
    expect(tables).toMatch(/^Новые таблицы и поля базы данных остались на сайте/)
    // The row keeps a count alone: the words name a page and a post, and both reasons.
    expect(records).toBe(
      'Страница или запись, которую добавил выпуск, осталась на сайте: после выпуска её изменили или к ней уже что-то добавили, поэтому мы её не убрали. Если она не нужна, удалите её в админке сайта.',
    )
    expect(feedReleaseKeptText({ records: 3, tables: 0 })).toEqual([
      'Страницы и записи, которые добавил выпуск, остались на сайте (3): после выпуска их изменили или к ним уже что-то добавили, поэтому мы их не убрали. Если они не нужны, удалите их в админке сайта.',
    ])
  })

  it('shows a version without the letter of the tag', () => {
    expect(feedVersionText('v1.4.0')).toBe('1.4.0')
    expect(feedReleaseText('installed', 'v2.0.0')).toBe('Версия 2.0.0 установлена на сайт.')
    expect(feedDecisionText('v0.0.1')).toBe('Вы решили выпустить версию 0.0.1.')
  })

  it('freezes every table', () => {
    for (const table of tables)
      if (typeof table === 'object' && table !== null) expect(Object.isFrozen(table)).toBe(true)
  })
})

describe('every text of the catalogue', () => {
  it('collects a meaningful number of texts', () => {
    expect(allTexts.length).toBeGreaterThan(120)
  })

  it.each(allTexts.map((text) => [text]))('is fit for a customer: %s', (text) => {
    expect(text.trim()).toBe(text)
    expect(text).not.toBe('')
    // Rule 10 and the design: no Latin letter, no code name, no service marker.
    expect(text).not.toMatch(/[A-Za-z_]/)
    expect(text).not.toContain('[[')
    expect(text).not.toMatch(/\s{2,}|\n/)
    // What a feed row may show: no invisible or control characters.
    expect(isFeedText(text)).toBe(true)
    // On «вы», never on «ты».
    expect(text).not.toMatch(/(?<![а-яё])(?:ты|тебя|тебе|тобой|твой|твоя|твоё|твои)(?![а-яё])/iu)
    // No half-substituted template.
    expect(text).not.toMatch(/[{}]|undefined|NaN|null/)
    expect(text).not.toMatch(/НДС|чек/u)
    // A sentence, a label or a count: ends with a letter, a digit, a mark or «»».
    expect(text).toMatch(/[а-яёА-ЯЁ\d.?…»]$/u)
  })

  it('opens and closes guillemets in pairs', () => {
    for (const text of allTexts) expect(text.split('«').length, text).toBe(text.split('»').length)
  })
})

describe('status labels', () => {
  it('reads exactly as the table of spec §7 and of the design', () => {
    expect(taskStatusLabel).toEqual({
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
    expect(taskStatusListHint.awaiting_user).toBe('Ответьте на вопрос')
    expect(taskStatusListHint.awaiting_approval).toBe('Посмотрите и примените')
  })

  it('titles the cards with the words of their statuses', () => {
    expect(feedCardTitle.result).toBe('Готово')
    expect(feedCardTitle.failure).toBe('Не получилось')
    expect(feedCardTitle.cancelled).toBe('Отменено')
    expect(feedCardTitle.rolledBack).toBe('Вернули как было')
    expect(feedCardTitle.approval).toBe('Что изменится')
    expect(feedCardTitle.question).toBe('Вопрос агента')
  })

  it('names the stages with nouns', () => {
    expect(feedStepLabel).toEqual({
      work: 'Работа над задачей',
      save: 'Сохранение работы',
      site: 'Работа с содержимым сайта',
      files: 'Правки в файлах сайта',
    })
  })
})

describe('the live block', () => {
  it('chooses the queue text by the waiting reason, not by time', () => {
    expect(feedQueuedText(null)).toBe(
      'Агент скоро возьмётся за работу. Страницу можно закрыть — результат появится в этом диалоге.',
    )
    expect(feedQueuedText('agents')).toBe(
      'Ваша задача в очереди: сейчас все мощности ИИ-агента заняты. Начнём, как только возьмёмся, — результат появится в этом диалоге.',
    )
    expect(feedQueuedText('site')).toBe(
      'На сайте сейчас идёт другая работа. Начнём, когда она закончится.',
    )
  })

  it('promises no notification and no start time while the pool is busy', () => {
    expect(feedWaitingText.agents).not.toMatch(/напишем|примерно|бесплатно/u)
  })

  it('says «обычно», not «не больше», about the twenty minutes', () => {
    expect(feedLiveText.running).toBe(
      'Агент работает в своём изолированном облаке. Обычно это занимает до 20 минут. Страницу можно закрыть — результат появится в этом диалоге.',
    )
    expect(feedLiveText.preparing).toBe(
      'Готовим рабочее место для агента. На сайте пока ничего не меняется.',
    )
    expect(feedLiveText.held).toBe(
      'При работе с сайтом произошёл сбой, мы его разбираем. Страницу можно закрыть — результат появится в этом диалоге.',
    )
  })

  it.each([
    [0, '0 с'],
    [14, '14 с'],
    [60, '1 мин 0 с'],
    [134, '2 мин 14 с'],
    [134.9, '2 мин 14 с'],
    [1200, '20 мин 0 с'],
    [-5, '0 с'],
    [Number.NaN, '0 с'],
  ])('shows %s seconds as «%s»', (seconds, text) => {
    expect(feedDurationText(seconds)).toBe(text)
  })

  it('folds a finished turn into one line', () => {
    expect(feedWorkedText(134)).toBe('Агент работал 2 мин 14 с')
  })
})

describe('what is known about the site and the credits', () => {
  it('promises an unchanged site only in its own words', () => {
    expect(feedEndedSiteText.unchanged).toBe('На сайте ничего не изменилось.')
    expect(feedEndedSiteText.restored).toBe(
      'Правки, которые агент успел внести, мы вернули — сайт такой же, как до задачи.',
    )
    expect(feedEndedSiteText.check).toBe(
      'Часть правок могла остаться на сайте. Откройте сайт и проверьте; если что-то не так — напишите нам.',
    )
  })

  it('says nothing about the site when a finished task left it as it was', () => {
    expect(feedDoneSiteText.unchanged).toBeNull()
    expect(feedDoneSiteText.changed).toBe('Правка уже на сайте.')
    expect(feedDoneSiteText.check).toBe(
      'Часть правок могла попасть на сайт. Откройте сайт и проверьте; если что-то не так — напишите нам.',
    )
  })

  it('tells a pending change of files from a change of text already on the site', () => {
    expect(feedApprovalSiteText.unchanged).toBe('На сайте пока ничего не изменилось.')
    expect(feedApprovalSiteText.changed).toBe(
      'Правки текста уже на сайте. Изменения в файлах ждут вашего решения.',
    )
    expect(feedApprovalSiteText.check).toBe(feedDoneSiteText.check)
    expect(feedFilesChangedText(3)).toBe('Изменено файлов: 3')
  })

  it('has no sentence about credits when the row knows nothing', () => {
    expect(feedCreditsSentence(null)).toBeNull()
    expect(feedCreditsSentence('returned')).toBe('Кредиты за эту задачу не списаны.')
    expect(feedCreditsSentence('expired')).toBe(
      'Отложенные кредиты были из прошлого периода тарифа и в новый не переносятся.',
    )
  })
})

describe('cancellation', () => {
  it('reads each way of cancelling in the words of the design', () => {
    expect(feedCancelledSentence('not_available')).toBe(
      'Эта задача требует изменений в файлах сайта, а применять их из кабинета пока нельзя.',
    )
    expect(feedCancelledSentence('queue_timeout')).toBe(
      'Не смогли взяться за задачу за сутки и отменили её.',
    )
    expect(FEED_QUEUE_TIMEOUT_CLOSING).toBe('Отправьте задачу снова, когда будет удобно.')
    expect(feedCancelledSentence('customer')).toBe('Вы остановили задачу.')
    expect(feedCancelledSentence('stopped')).toBe('Вы остановили задачу.')
    expect(feedCancelledSentence('declined')).toBe('Вы решили не применять изменения.')
    expect(feedCancelledSentence('no_answer')).toBe('Задача отменена: мы не дождались ответа.')
  })

  it('leaves the plate without a reason for a way of cancelling it does not know', () => {
    expect(feedCancelledSentence(null)).toBeNull()
    expect(feedCancelledSentence(null, 'Анна')).toBeNull()
  })

  it('names another participant who stopped the task', () => {
    expect(feedCancelledSentence('customer', 'Анна Петрова')).toBe(
      'Задачу остановил(а) Анна Петрова.',
    )
    expect(feedCancelledSentence('stopped', '  Иван ')).toBe('Задачу остановил(а) Иван.')
    expect(feedCancelledSentence('stopped', FEED_REMOVED_AUTHOR)).toBe(
      'Задачу остановил(а) Участник.',
    )
  })

  it('ignores the name where nobody pressed a button, and an empty name', () => {
    expect(feedCancelledSentence('queue_timeout', 'Анна')).toBe(feedCancelledText.queue_timeout)
    expect(feedCancelledSentence('declined', 'Анна')).toBe(feedCancelledText.declined)
    expect(feedCancelledSentence('customer', '  ')).toBe(feedCancelledText.customer)
    expect(feedCancelledSentence('stopped', '.')).toBe(feedCancelledText.stopped)
    expect(feedCancelledSentence('stopped', ' . . ')).toBe(feedCancelledText.stopped)
  })

  it('does not end a name that has its own full stop with two', () => {
    expect(feedCancelledSentence('stopped', 'Иван П.')).toBe('Задачу остановил(а) Иван П.')
    expect(feedCancelledSentence('customer', 'Иван П. ')).toBe('Задачу остановил(а) Иван П.')
    expect(feedCancelledSentence('stopped', 'А. С. Пушкин')).toBe(
      'Задачу остановил(а) А. С. Пушкин.',
    )
  })
})

describe('pluralRu', () => {
  const credits = (count: number) => pluralRu(count, 'кредит', 'кредита', 'кредитов')

  it.each([
    [0, 'кредитов'],
    [1, 'кредит'],
    [2, 'кредита'],
    [3, 'кредита'],
    [4, 'кредита'],
    [5, 'кредитов'],
    [11, 'кредитов'],
    [12, 'кредитов'],
    [14, 'кредитов'],
    [20, 'кредитов'],
    [21, 'кредит'],
    [22, 'кредита'],
    [25, 'кредитов'],
    [100, 'кредитов'],
    [101, 'кредит'],
    [111, 'кредитов'],
    [112, 'кредитов'],
    [122, 'кредита'],
    [2500, 'кредитов'],
  ])('%s → %s', (count, form) => {
    expect(credits(count)).toBe(form)
  })

  it('sets thousands apart with a no-break space', () => {
    expect(creditsCountText(1)).toBe('1 кредит')
    expect(creditsCountText(263)).toBe('263 кредита')
    expect(creditsCountText(2500)).toBe('2 500 кредитов')
  })
})

describe('the platform question about credits', () => {
  it('B1: the step is reached — both numbers and the next hold', () => {
    expect(
      feedCeilingText({ reason: 'step', spent: 37, held: 45, left: 8 }, { nextHold: 45 }),
    ).toBe(
      'Задача оказалась больше обычной: на неё уже ушло 37 кредитов из 45 отложенных. Продолжить? Отложим ещё до 45 кредитов и спишем только то, что уйдёт на работу. Если остановиться, кредиты за эту задачу не спишутся, а изменения не будут применены.',
    )
  })

  it('B1 without the next hold leaves that sentence out', () => {
    expect(feedCeilingText({ reason: 'step', spent: 37, held: 45, left: 8 })).toBe(
      'Задача оказалась больше обычной: на неё уже ушло 37 кредитов из 45 отложенных. Продолжить? Если остановиться, кредиты за эту задачу не спишутся, а изменения не будут применены.',
    )
  })

  it('B2: credits ran out, something is left of the hold', () => {
    expect(feedCeilingText({ reason: 'credits', spent: 10, held: 12, left: 2 }, { pack })).toBe(
      'Лимиты закончились посреди задачи: на неё ушло 10 кредитов из 12 отложенных, а оставшихся 2 не хватает на следующий шаг. Работа сохранена. Купите пакет — 100 кредитов за 1 990 ₽ — и продолжим с того же места. Если остановить задачу, кредиты за неё не спишутся, а изменения не будут применены.',
    )
  })

  it('B2б: nothing is left — «все», and only then', () => {
    const text = feedCeilingText({ reason: 'credits', spent: 12, held: 12, left: 0 }, { pack })
    expect(text).toBe(
      'Лимиты закончились посреди задачи: на неё ушли все 12 отложенных кредитов. Работа сохранена. Купите пакет — 100 кредитов за 1 990 ₽ — и продолжим с того же места. Если остановить задачу, кредиты за неё не спишутся, а изменения не будут применены.',
    )
    expect(feedCeilingText({ reason: 'credits', spent: 10, held: 12, left: 2 })).not.toContain(
      'все',
    )
  })

  it('B3: the next period is near — the date and the credits of the tariff', () => {
    expect(
      feedCeilingText({ reason: 'credits', spent: 10, held: 12, left: 2 }, { pack, renewal }),
    ).toContain(
      'и продолжим с того же места. Или дождитесь 18 октября: начислим 300 кредитов по тарифу, и задачу можно будет продолжить. Если остановить задачу,',
    )
  })

  it('names no pack and no date that billing did not give', () => {
    const text = feedCeilingText({ reason: 'credits', spent: 10, held: 12, left: 2 })
    expect(text).toBe(
      'Лимиты закончились посреди задачи: на неё ушло 10 кредитов из 12 отложенных, а оставшихся 2 не хватает на следующий шаг. Работа сохранена. Если остановить задачу, кредиты за неё не спишутся, а изменения не будут применены.',
    )
    expect(text).not.toMatch(/₽|пакет|дождитесь/u)
  })

  it('B4: the gift ran out', () => {
    expect(feedCeilingText({ reason: 'gift', spent: 31, held: 35, left: 4 })).toBe(
      'Подарочные кредиты закончились посреди задачи: на неё ушло 31 из 35, а оставшихся 4 не хватает на следующий шаг. Работа сохранена. Выберите тариф — и продолжим с того же места. Если остановить задачу, подарочные кредиты вернутся, а изменения не будут применены.',
    )
    expect(feedCeilingText({ reason: 'gift', spent: 35, held: 35, left: 0 })).toBe(
      'Подарочные кредиты закончились посреди задачи: на неё ушли все 35. Работа сохранена. Выберите тариф — и продолжим с того же места. Если остановить задачу, подарочные кредиты вернутся, а изменения не будут применены.',
    )
  })

  it('B6: the third attempt is spent', () => {
    expect(feedCeilingText({ reason: 'attempts', spent: 114, held: 120, left: 6 })).toBe(
      'Задача оказалась слишком большой: на неё уже ушло 114 кредитов. Её лучше разбить на части или передать специалисту. Если остановить задачу, кредиты за неё не спишутся, а изменения не будут применены.',
    )
  })

  it('agrees the verb and the nouns with the numbers', () => {
    expect(feedCeilingText({ reason: 'credits', spent: 1, held: 21, left: 1 })).toContain(
      'на неё ушёл 1 кредит из 21 отложенного, а оставшегося 1 не хватает на следующий шаг.',
    )
    expect(feedCeilingText({ reason: 'credits', spent: 3, held: 4, left: 1 })).toContain(
      'на неё ушло 3 кредита из 4 отложенных,',
    )
    expect(feedCeilingText({ reason: 'credits', spent: 21, held: 21, left: 0 })).toContain(
      'на неё ушёл весь 21 отложенный кредит.',
    )
    expect(feedCeilingText({ reason: 'credits', spent: 3, held: 3, left: 0 })).toContain(
      'на неё ушли все 3 отложенных кредита.',
    )
    expect(feedCeilingText({ reason: 'attempts', spent: 0, held: 5, left: 5 })).toContain(
      'на неё уже ушло 0 кредитов.',
    )
    expect(
      feedCeilingText({ reason: 'step', spent: 2, held: 5, left: 3 }, { nextHold: 21 }),
    ).toContain('Отложим ещё до 21 кредита и спишем')
    expect(
      feedCeilingText(
        { reason: 'credits', spent: 5, held: 5, left: 0 },
        { renewal: { date: '1 ноября', credits: 2500 } },
      ),
    ).toContain('начислим 2 500 кредитов по тарифу')
  })

  it('offers a way on and a way out for every reason', () => {
    expect(feedCeilingButtons.step).toEqual({ next: 'Продолжить', stop: 'Остановиться' })
    expect(feedCeilingButtons.credits).toEqual({ next: 'Купить пакет', stop: 'Остановить задачу' })
    expect(feedCeilingButtons.gift).toEqual({ next: 'Выбрать тариф', stop: 'Остановить задачу' })
    expect(feedCeilingButtons.attempts).toEqual({
      next: 'Передать специалисту',
      stop: 'Остановить задачу',
    })
  })
})

describe('the neutral lines of the reader and of the input area', () => {
  it('advises a reload only where a reload helps', () => {
    expect(feedRowText.newer).toBe(
      'Здесь появилось новое сообщение. Обновите страницу, чтобы его увидеть.',
    )
    expect(feedRowText.unreadable).toBe(
      'Не удалось показать это сообщение. Напишите нам, если оно важно.',
    )
    expect(feedRowText.unreadable).not.toMatch(/обнов/iu)
  })

  it('reads the customer’s presses', () => {
    expect(feedRowText.retry).toBe('Вы попросили попробовать ещё раз')
    expect(feedRowText.continue).toBe('Вы попросили продолжить работу')
    expect(feedRowText.resume).toBe('Вы вернули управление агенту')
    expect(feedRowText.otherRequest).toBe('Вы продолжили задачу.')
  })

  it('quotes the question card and the answer field', () => {
    expect(feedQuestionText).toEqual({
      waiting: 'Агент продолжит, когда вы ответите.',
      oneMessage: 'Ответьте одним сообщением.',
      placeholder: 'Ваш ответ',
      send: 'Ответить',
      answered: 'На этот вопрос уже ответили.',
    })
  })

  it('quotes the lines next to «Попробовать ещё»', () => {
    expect(feedRetryText).toEqual({
      button: 'Попробовать ещё',
      hint: 'Повторная попытка может стоить больше кредитов.',
      noAttempts: 'Больше попыток для этой задачи нет. Начните новый диалог или напишите нам.',
      siteNotConnected: 'Сайт ещё не подключён. Задачи можно будет ставить после подключения',
    })
  })

  it('quotes the input area', () => {
    expect(feedInputText).toEqual({
      disabled: 'Написать можно будет, когда агент закончит или задаст вопрос.',
      finished: 'Диалог завершён. Чтобы попросить что-то ещё, начните новый.',
      newDialog: 'Новый диалог',
      mistakes: 'ИИ может допускать ошибки. Проверяйте важное.',
      noSecrets: 'Не отправляйте в чат пароли и ключи: доступы задаются в разделе «Настройки»',
      secret:
        'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Настройки»',
    })
  })

  it('names the limit of a message in the too-long line', () => {
    expect(feedTooLongText(feedLimits.requestText)).toBe(
      'Сообщение слишком длинное — сократите его до 4000 знаков',
    )
  })

  it('quotes the states of the feed and of the list', () => {
    expect(feedStateText).toEqual({
      pollFailed: 'Не удалось обновить диалог. Пробуем ещё раз…',
      refresh: 'Обновить',
      listFailed: 'Не удалось загрузить диалоги.',
      listRetry: 'Повторить',
      toProjects: 'К проектам',
      openSite: 'Открыть сайт',
    })
  })
})

describe('a task in the browser', () => {
  it('has a title and a text for every reason of a browser question', () => {
    expect(sorted(Object.keys(feedBrowserQuestionTitle))).toEqual(sorted(feedBrowserReasons))
    expect(sorted(Object.keys(feedBrowserQuestionText))).toEqual(sorted(feedBrowserReasons))
  })

  it('names the buttons of the owner and asks to press the one that gives control back', () => {
    expect(feedBrowserButtons).toEqual({
      take: 'Взять управление',
      resume: 'Продолжить работу агента',
      stop: 'Остановить',
    })
    for (const reason of ['login', 'captcha', 'confirm', 'other', 'control'] as const)
      expect(feedBrowserQuestionText[reason]).toContain('«Продолжить работу агента»')
  })

  it('promises nothing about the site it did not read there', () => {
    expect(feedBrowserQuestionText.unconfirmed).toMatch(/не нашли на сайте/u)
    expect(feedBrowserQuestionText.unconfirmed).not.toMatch(/вернули|отменили|откат/iu)
  })

  it('has a label for every kind and state of an object of the site', () => {
    expect(sorted(Object.keys(feedObjectKindLabel))).toEqual(sorted(feedObjectKinds))
    expect(sorted(Object.keys(feedObjectStatusLabel))).toEqual(sorted(feedObjectStatuses))
    expect(feedObjectText.untitled).toBe('Без названия')
  })
})
