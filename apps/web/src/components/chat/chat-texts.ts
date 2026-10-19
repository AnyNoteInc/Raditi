import type { CandidateCheckStatus, ReleaseStatus } from '@repo/domain'
import { feedRetryText } from '@repo/domain/tasks/client-feed-labels'

import { plural } from '@/lib/plural'

// What the screens of a dialog say beyond the catalogue of the feed
// (packages/domain/src/tasks/client-feed-labels.ts): the words of the controls, the panel beside
// the dialog, the list and the release. Russian, on «вы», without the platform's own terms
// (rule 10). The rows of the feed, the statuses and the commands take their words from the
// catalogue; nothing here restates them.

/** The switch below the wide layout: the dialog, or the panel of its changes. */
export const viewSwitchText = Object.freeze({
  label: 'Что показать',
  dialog: 'Диалог',
  preview: 'Предпросмотр',
})

export const paneText = Object.freeze({
  /** The accessible name of the panel beside the dialog. */
  label: 'Изменения диалога',
  tabs: 'Разделы изменений',
  frameTitle: 'Предпросмотр сайта с изменениями диалога',
  /** The dialog has ended and its preview with it. */
  destroyed: 'Диалог закрыт, и его предпросмотр остановлен.',
  /** The preview of a stopped dialog is opened again. */
  reopen: 'Открыть предпросмотр',
  reset: 'Сбросить данные предпросмотра',
  /** No candidate yet: what the tabs of the changes show. */
  noChanges: 'Изменений пока нет. Они появятся здесь, когда агент закончит работу.',
  loadFailed: 'Не удалось загрузить изменения.',
  retry: 'Повторить',
  /** A candidate that the site moved on under. */
  stale: 'Сайт изменился после того, как эти изменения были готовы. Обновите рабочую копию.',
})

export const filesText = Object.freeze({
  files: 'Файлы',
  media: 'Медиафайлы',
  none: 'Файлы сайта не изменятся.',
  back: 'Ко всем файлам',
  loading: 'Загружаем изменения файла…',
  binary: 'Это не текстовый файл: его изменения здесь не показать.',
  tooLarge: 'Изменения файла слишком большие, чтобы показать их здесь.',
  missing: 'Не удалось найти изменения этого файла.',
  /** Read before the lines of a diff: the colour is not the only sign. */
  legend: 'Строки со знаком «+» добавятся, со знаком «−» — уйдут.',
  added: 'Добавлено:',
  removed: 'Удалено:',
})

/** The change of a file, as its badge says it. */
export const fileChangeLabel = Object.freeze({
  added: 'Новый',
  modified: 'Изменён',
  deleted: 'Удалён',
})

export const databaseText = Object.freeze({
  none: 'База данных сайта не изменится.',
  note: 'Так изменится база данных сайта, когда вы выпустите версию.',
  /** A plan without a description of its values (recorded before them, or taken back). */
  noValues:
    'Значения этих изменений сейчас не показать, поэтому выпустить их нельзя. Напишите в диалог, чтобы агент собрал изменения заново.',
  /** The cards of the plan do not fit even shortened: nothing is shown or released. */
  oversize:
    'Изменений базы данных слишком много, чтобы показать их здесь, поэтому выпустить их нельзя. Попросите агента разделить работу на несколько диалогов.',
  /** Something of a card is shortened. */
  shortened: 'Показано не всё изменение. Полностью его видно в предпросмотре.',
  /** A plan with new records or tables: what a failed release leaves. */
  returnNote:
    'Если версия не пройдёт проверку после установки, мы вернём сайт как было. Новые таблицы и поля останутся в базе данных: прежняя версия их не использует, а удаление стёрло бы то, что сайт успеет в них записать. Новая страница уйдёт в корзину, если её никто не изменил.',
  was: 'было',
  becomes: 'станет',
  notSet: 'не задано',
  title: 'Заголовок',
  excerpt: 'Описание',
  text: 'Текст',
  markupOnly: 'В тексте изменилось только оформление.',
  fieldMarkupOnly: 'изменилось только оформление',
  replaced: 'Текст заменён целиком.',
  linksAdded: 'Новые ссылки',
  linksRemoved: 'Убраны ссылки',
  linksIn: 'Ссылки в тексте',
  published: 'Будет опубликована сразу.',
  draft: 'Сохранится черновиком: опубликовать её можно в админке сайта.',
  maybeEmpty: 'может быть пустым',
  defaultValue: 'по умолчанию',
  defaultNow: 'по умолчанию — время записи',
  newTable: (table: string) => `Новая таблица в базе данных сайта «${table}»`,
  newColumns: (table: string) => `В таблицу «${table}» добавятся поля`,
  /** A non-unique index: what it is for, in the client's words. */
  index: (columns: string) => `Быстрый поиск по полям: ${columns}`,
  uniqueIndex: (columns: string) => `Значения полей ${columns} не повторяются`,
  /** The words of a card the description refused, by its reason. */
  refused: {
    client_variable:
      'В этом изменении есть значение переменной окружения сайта. Такое изменение выпустить нельзя: попросите агента переделать его.',
    too_many_links:
      'В этом изменении слишком много ссылок, чтобы показать их все. Такое изменение выпустить нельзя: попросите агента разделить его на части.',
    not_additive:
      'Это изменение структуры базы данных не только добавляет поля. Такое изменение выпустить нельзя: попросите агента переделать его.',
  },
})

/** The record a card is about, by the type of its reference: a page or a blog post. */
export const dbRecordWord = (type: string): string => (type === 'page' ? 'Страница' : 'Запись')

/** «Новая страница «Цены» по адресу /prices/» — a new record, its title and its address. */
export const dbNewRecordText = (type: string, title: string, slug: string): string =>
  type === 'page'
    ? `Новая страница «${title}» по адресу /${slug}/`
    : `Новая запись блога «${title}», адрес — ${slug}`

/** The words of the fields a text change writes: «заголовок и текст». */
export const dbFieldWords = Object.freeze({
  title: 'заголовок',
  content: 'текст',
  excerpt: 'описание',
})

/** A text of a table by a key the server sent: only the table's own keys, never its prototype's. */
export function ownText(table: Readonly<Record<string, string>>, key: string): string | null {
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null
}

/** The checks of a candidate, by `candidate_checks.kind`. */
const checkKindLabel: Readonly<Record<string, string>> = Object.freeze({
  php_lint: 'Файлы без ошибок в коде',
  preview_smoke: 'Сайт открывается в предпросмотре',
  agent_browser: 'Проверка агента в браузере',
})

/** The name of a check; a kind added later — «Проверка». */
export const checkKindText = (kind: string): string => ownText(checkKindLabel, kind) ?? 'Проверка'

export const checkStatusLabel: Readonly<Record<CandidateCheckStatus, string>> = Object.freeze({
  pending: 'Идёт',
  passed: 'Пройдена',
  failed: 'Не пройдена',
  stale: 'Устарела: изменения поменялись после неё',
})

export const checksText = Object.freeze({
  none: 'Проверок пока нет.',
  /** The screenshot the agent's browser took when it checked the changes (Р22). */
  screenshot: 'Снимок экрана, который сделал агент при проверке',
})

/**
 * What «Проверки» says when the preview runs otherwise than the site (Р2, Р18): another version
 * of PHP, or extensions the site has and the preview lacks. Empty — nothing to say.
 */
export function runtimeMatchText(match: {
  production: string
  preview: string | null
  missing: readonly string[]
}): string[] {
  const parts: string[] = []
  if (match.preview !== null && match.preview !== match.production)
    parts.push(
      `Предпросмотр работает на PHP ${match.preview}, а сайт — на PHP ${match.production}. Проверки в предпросмотре могут пройти не так, как пройдут на сайте.`,
    )
  if (match.missing.length > 0)
    parts.push(
      `На сайте есть расширения PHP, которых нет в предпросмотре: ${match.missing.join(', ')}. То, что от них зависит, в предпросмотре может не работать.`,
    )
  return parts
}

/** Where the cabinet reads the screenshot of a check (apps/web/src/app/api/tasks/…). */
export const checkScreenshotUrl = (taskId: string, checkId: string): string =>
  `/api/tasks/${encodeURIComponent(taskId)}/checks/${encodeURIComponent(checkId)}/screenshot`

/** The progress of a release while it is in work, by its status. */
export const releaseStatusText: Readonly<Partial<Record<ReleaseStatus, string>>> = Object.freeze({
  approved: 'Готовим выпуск',
  publishing: 'Сохраняем новую версию',
  published: 'Новая версия сохранена',
  deploying: 'Устанавливаем на сайт',
  verifying: 'Проверяем сайт',
  rolling_back: 'Возвращаем сайт как было',
})

/** The step a release reports, in words; another step — none (read with `ownText`). */
export const releaseStepText: Readonly<Record<string, string>> = Object.freeze({
  conflicts: 'Проверяем, не изменился ли сайт',
  backup: 'Делаем резервную копию',
  files: 'Устанавливаем файлы',
  db: 'Обновляем записи сайта',
  verify: 'Проверяем сайт',
  rollback: 'Возвращаем как было',
  reverify: 'Проверяем сайт после возврата',
})

export const releaseText = Object.freeze({
  title: 'Выпустить новую версию',
  loading: 'Готовим выпуск…',
  facts: 'Что войдёт в версию',
  agentSaid: 'Что сделал агент',
  database: 'Изменения базы данных',
  /** A bulk plan (rule 4) or a shortened description: the client looks at every change first. */
  reviewBulk: (count: number) =>
    `Это массовое изменение: ${count} ${plural(count, 'изменение', 'изменения', 'изменений')} базы данных. Посмотрите их все перед выпуском.`,
  reviewShortened:
    'Часть изменений базы данных показана не полностью. Посмотрите их в предпросмотре перед выпуском.',
  reviewed: 'Я посмотрел(а) все изменения базы данных',
  checks: 'Проверки',
  version: 'Номер версии',
  proposed: 'предлагаем',
  installed: (version: string) => `Сейчас на сайте версия ${version}.`,
  firstRelease: 'Это первая версия, которую выпустит Радити.',
  safety:
    'Перед установкой мы сохраним резервную копию. Если сайт после установки не пройдёт проверку, вернём его как было.',
  confirm: (version: string) => `Выпустить версию ${version}`,
  keep: 'Не выпускать',
  /** The candidate has no counted changes the platform could read. */
  noFacts: 'Изменения есть, но подсчитать их не получилось.',
  /** «Версия 1.4.0: устанавливаем на сайт» — a release under way, in the head of the dialog. */
  progress: (version: string, words: string) =>
    `Версия ${version}: ${words.charAt(0).toLocaleLowerCase('ru')}${words.slice(1)}`,
  /** The number was confirmed before for these very changes, and that release has ended. */
  used: (version: string) =>
    `Номер ${version} уже использовали для этих изменений. Выберите номер ещё раз.`,
})

/** «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): the button, the window, the head. */
export const undoText = Object.freeze({
  button: 'Отменить выпуск',
  /** Under the button of the card of the installed version. */
  until: (when: string) => `Можно отменить до ${when}.`,
  title: (version: string) => `Отменить выпуск ${version}?`,
  loading: 'Проверяем, что можно вернуть…',
  slow: 'Не удалось проверить сайт. Попробуйте ещё раз.',
  failed: {
    site_unreachable:
      'Модуль «Радити» на сайте не ответил, поэтому мы не смогли проверить записи. Проверьте, что сайт открывается, и попробуйте ещё раз.',
    repository: 'Не удалось прочитать версии сайта. Попробуйте ещё раз немного позже.',
    technical: 'Произошёл технический сбой. Попробуйте ещё раз немного позже.',
  },
  retry: 'Повторить',
  returns: (returnsTo: string, version: string, undone: string) =>
    `Сайт вернётся к версии ${returnsTo}, кроме того, что изменили на сайте после выпуска. Возврат выйдет как новая версия ${version}, а номер ${undone} останется в истории.`,
  files: 'Файлы',
  back: (count: number) => `Вернутся к прежнему виду: ${count}`,
  removed: (count: number) => `Удалятся файлы, которые добавил выпуск: ${count}`,
  restored: (count: number) => `Вернутся файлы, которые выпуск удалил: ${count}`,
  mediaKept: (count: number) => `Медиафайлы, которые добавил выпуск, останутся на сайте: ${count}`,
  more: (count: number) => `и ещё ${count}`,
  noFiles: 'Файлы сайта менять не нужно.',
  records: 'Записи сайта',
  noRecords: 'Выпуск не менял записи сайта.',
  notes: [
    'Новые заказы, заявки и комментарии не тронем: данные, которые сайт записал сам после выпуска, останутся.',
    'Перед возвратом сделаем свежую резервную копию.',
    'Отмена бесплатна. Кредиты, списанные за этот диалог, не возвращаются.',
  ],
  safety: (undone: string) =>
    `Если после возврата сайт не пройдёт проверку, вернём версию ${undone}.`,
  nothing: 'Всё, что изменил выпуск, на сайте уже изменили после него — возвращать нечего.',
  review: (count: number) =>
    `Вернётся записей: ${count}. Это массовое изменение — посмотрите их все перед отменой.`,
  reviewed: 'Я посмотрел(а) все записи, которые вернутся',
  confirm: (returnsTo: string) => `Вернуть версию ${returnsTo}`,
  keep: 'Не отменять',
  /** The confirmation was taken before, and that undo has ended: the number is spent. */
  used: (version: string) =>
    `Номер ${version} уже использовали для отмены. Мы предложим следующий — проверьте и подтвердите ещё раз.`,
  /** «Отмена выпуска 1.4.0: устанавливаем на сайт» — in the head while the undo goes on. */
  progress: (version: string, words: string) =>
    `Отмена выпуска ${version}: ${words.charAt(0).toLocaleLowerCase('ru')}${words.slice(1)}`,
  /** The live block of a closed dialog while its undo goes on. */
  live: (version: string) => `Отменяем выпуск ${version}`,
  /** The dialog in the list. */
  running: 'Отменяем выпуск',
  installed: 'Выпуск отменён',
})

export const cancelText = Object.freeze({
  title: 'Отменить диалог?',
  confirm: 'Отменить диалог',
  keep: 'Не отменять',
})

export const paletteText = Object.freeze({
  label: 'Команды',
  open: 'Команды',
  /** Read when the list opens: what is in it and how to move. */
  opened: (count: number, word: string) =>
    `${count} ${word}. Стрелки вверх и вниз — выбор, Enter — выполнить, Escape — закрыть.`,
  unavailable: 'Недоступна',
})

export const composerText = Object.freeze({
  label: 'Сообщение',
  newPlaceholder: 'Что поменять на сайте?',
  revisionPlaceholder: 'Что поправить?',
  send: 'Отправить',
  /** The field while the platform's question about credits is open. */
  ceiling: 'Сначала ответьте на вопрос выше: продолжите работу или остановите задачу.',
  /** The field of a new dialog while the site is not connected. */
  notConnected: `${feedRetryText.siteNotConnected}.`,
  /** The field while a release is installed on the site. */
  releasing: 'Написать можно будет, когда установка закончится.',
  chatLater: 'Режим «Чат» появится позже.',
  modes: 'Режим диалога',
  /** A command typed on «Новый диалог»: there is no dialog to run it in yet. */
  commandsInDialog: 'Команды работают внутри диалога. Сначала опишите, что поменять на сайте.',
  /** A command typed in full that cannot be run now, and the server gave no reason. */
  commandUnavailable: 'Эта команда сейчас недоступна.',
})

export const listText = Object.freeze({
  empty: 'Диалогов пока нет. Опишите, что поменять на сайте, — диалог появится здесь.',
  more: 'Показать ещё',
  untitled: 'Диалог без названия',
  loading: 'Загружаем диалоги',
})

export const creditsText = Object.freeze({
  title: 'Кредиты',
  details: 'Подробнее о кредитах',
})

export const dialogText = Object.freeze({
  notFound: 'Такого диалога нет',
  notFoundHint: 'Возможно, его открыли по старой ссылке. Все диалоги сайта — в списке.',
  toList: 'К диалогам',
  loading: 'Загружаем диалог',
  showChanges: 'Посмотреть изменения',
  stoppedHint: 'Останавливаем работу агента…',
  /** The steps of a finished turn, unfolded. */
  stages: 'Этапы работы',
  mode: 'Режим',
})
