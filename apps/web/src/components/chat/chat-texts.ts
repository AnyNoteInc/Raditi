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
  /** The panel of the changes: their files, records, checks and preview. */
  preview: 'Изменения',
})

export const paneText = Object.freeze({
  /** The accessible name of the panel beside the dialog. */
  label: 'Предпросмотр и изменения диалога',
  tabs: 'Разделы панели',
  frameTitle: 'Предпросмотр сайта с изменениями диалога',
  /** The dialog has ended and its preview with it. */
  destroyed: 'Диалог закрыт, и его предпросмотр остановлен.',
  /** The preview is shown only when the client asks for it (owner's request of 27.10.2026). */
  ask: 'Предпросмотр — рабочая копия сайта с изменениями этого диалога. Покажем его, когда попросите.',
  /** The client's explicit call of the preview. */
  show: 'Показать предпросмотр',
  /** The preview of a stopped dialog is opened again. */
  reopen: 'Открыть предпросмотр',
  reset: 'Сбросить данные предпросмотра',
  /** No candidate yet: what the tabs of the changes show. */
  noChanges: 'Изменений пока нет. Они появятся здесь, когда агент закончит работу.',
  loadFailed: 'Не удалось загрузить изменения.',
  retry: 'Повторить',
  /** A candidate that the site moved on under. */
  stale: 'Сайт изменился после того, как эти изменения были готовы. Обновите рабочую копию.',
  /** The edge of the panel that is dragged (docs/plan/57-browser-tasks.md, Б29). */
  separator: 'Ширина панели',
  /**
   * The button of the head: the panel opens by itself when the changes appear, by this button at
   * any time (owner's request of 27.10.2026); the client can close it.
   */
  open: 'Открыть панель',
  /** The hint of that button: what the panel holds. */
  openHint: 'Предпросмотр, файлы, база данных и проверки',
  hide: 'Скрыть панель',
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
  /** The field of a new dialog while the site is not connected. */
  notConnected: `${feedRetryText.siteNotConnected}.`,
  /** The field while a release is installed on the site. */
  releasing: 'Написать можно будет, когда установка закончится.',
  /** The field after «Остановить», until core has ended the task. */
  stopping: 'Останавливаем задачу…',
  /** «Чат» works in the cloud browser: a site or a platform without it cannot take one. */
  chatOff: 'Режим «Чат» для этого сайта сейчас недоступен: облачный браузер не подключён.',
  /** «Работа» works on a copy of the site: a site without its files cannot take one. */
  workOff: 'Режим «Работа» недоступен: у сайта нет копии файлов.',
  modes: 'Режим диалога',
  /** «+» of the field: what can be added to the message. */
  add: 'Добавить',
  /** A command typed on «Новый диалог»: there is no dialog to run it in yet. */
  commandsInDialog: 'Команды работают внутри диалога. Сначала опишите, что поменять на сайте.',
  /** A command typed in full that cannot be run now, and the server gave no reason. */
  commandUnavailable: 'Эта команда сейчас недоступна.',
  /** The button in place of «Отправить» while the agent works: the same as `/cancel`. */
  stop: 'Остановить',
  /** The field of a dialog that has ended. */
  finished: 'Диалог завершён',
  /**
   * The other mode on the switch of a dialog that goes on: the mode is chosen when a dialog
   * starts, so the other one starts a new dialog.
   */
  otherMode: (label: string) =>
    `Откроет новый диалог в режиме «${label}»: режим начатого диалога не меняется.`,
})

export const listText = Object.freeze({
  empty: 'Диалогов пока нет. Опишите, что поменять на сайте, — диалог появится здесь.',
  more: 'Показать ещё',
  untitled: 'Диалог без названия',
  loading: 'Загружаем диалоги',
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

/**
 * «Ход работы»: what the agent wrote, ran and changed in a turn, as it goes (owner's decision of
 * 26.10.2026). The commands, the names of tools and the paths are the agent's own, shown as they
 * are; the words around them are these.
 */
export const activityText = Object.freeze({
  title: 'Ход работы',
  loading: 'Загружаем ход работы…',
  empty: 'Агент пока ничего не вывел.',
  failed: 'Не удалось загрузить ход работы. Попробуем ещё раз.',
  more: 'Загружаем дальше…',
  command: 'Команда',
  tool: 'Инструмент',
  question: 'Вопрос',
  /** How a command ended: its exit code, as the agent's CLI reported it. */
  exit: (code: number | null): string | null =>
    code === null ? null : code === 0 ? 'выполнена' : `ошибка, код ${code}`,
  toolDone: (ok: boolean) => (ok ? 'выполнен' : 'ошибка'),
  file: Object.freeze({
    add: 'Добавлен файл',
    update: 'Изменён файл',
    delete: 'Удалён файл',
  }),
})

/** Files attached to a message (docs/plan/57-browser-tasks.md, Б26). */
export const attachmentText = Object.freeze({
  /** The item of «+» that opens the dialog of the system. */
  upload: 'Загрузить файл',
  /** Under it: a file can be pasted into the field as well. */
  pasteHint: (keys: string) => `Или вставьте его в поле: ${keys}`,
  /** «+» of a field that takes no files: in «Работа» for now, in a dialog that has ended. */
  none: 'К этому сообщению файлы не прикрепить.',
  list: 'Файлы к сообщению',
  sent: 'Файлы сообщения',
  uploading: (percent: number) => `Загружаем… ${percent} %`,
  progress: (name: string) => `Загрузка ${name}`,
  failed: 'Не загрузилось.',
  retry: 'Повторить',
  retryNamed: (name: string) => `Повторить загрузку ${name}`,
  removeNamed: (name: string) => `Убрать ${name}`,
  cancelNamed: (name: string) => `Отменить загрузку ${name}`,
  /** The send button waits for the files. */
  wait: 'Дождитесь загрузки файлов',
  /** A file failed: the message waits until it is sent again or taken out. */
  fix: 'Повторите или уберите файлы, которые не загрузились',
  unnamed: 'Файл',
})

/** The way a new dialog works on the site (docs/plan/57-browser-tasks.md, Б9). */
/** How hard the model thinks, chosen when a dialog starts (owner's request of 26.10.2026). */
export const effortText = Object.freeze({
  label: 'Размышление',
  low: 'Низкое',
  high: 'Высокое',
  max: 'Максимальное',
  /** What each level is for: under its name in the menu. */
  lowHint: 'Быстрее и дешевле — для простых правок',
  highHint: 'Для большинства задач',
  maxHint: 'Дольше и дороже — для сложных задач',
  /** The level of a dialog that goes on changes from the agent's next turn. */
  changed: 'Уровень размышления изменится со следующего шага агента',
})

/**
 * What is done with a dialog as a whole (owner's request of 26.10.2026): its menu in the list and
 * in its head, the name written in place, the confirmation of «Удалить».
 */
export const dialogMenuText = Object.freeze({
  open: 'Действия с диалогом',
  rename: 'Переименовать',
  remove: 'Удалить',
  name: 'Название диалога',
  removeTitle: 'Удалить диалог?',
  removeBody:
    'Диалог пропадёт из списка. Если агент ещё работает, он остановится, а отложенные кредиты вернутся. То, что уже выпущено на сайт, останется.',
  /** The dialog's release can still be undone: the button goes with the dialog. */
  removeUndo:
    'Кнопка «Отменить выпуск» этого диалога тоже пропадёт: вернуть прежнюю версию можно будет только новым диалогом.',
  removeConfirm: 'Удалить',
  removeKeep: 'Оставить',
})

export const taskWayText = Object.freeze({
  label: 'Как агент будет работать',
  browser: 'В браузере',
  repository: 'Через копию сайта',
  browserNote:
    'В режиме «Чат» агент работает без копии файлов сайта: открывает сайт в облачном браузере, а вы видите каждый его шаг и можете помочь — например, войти в админку сами. Изменения в админке появляются на сайте сразу.',
  repositoryNote:
    'В режиме «Работа» агент получает копию файлов сайта из последней версии, вы смотрите результат в предпросмотре и сами выпускаете новую версию на сайт.',
  /** A site added without access to its files. */
  browserOnly:
    'Сайт добавлен без доступа к файлам: агент работает в админке сайта через браузер. Изменения появляются на сайте сразу.',
  /** The site's address is not https in production: the words of TASK_NOT_ACCEPTED browser_insecure. */
  insecure:
    'В браузере агент работает только с сайтами, которые открываются по защищённому адресу. Адрес сайта в кабинете поменять нельзя: добавьте сайт заново с адресом, который начинается с https://.',
  /**
   * The reminder under the field of a task in the browser: the admin's sign-in is saved in the
   * site's variables (Б36) or typed in the browser's own window, never in the chat.
   */
  noSecrets:
    'Не отправляйте в чат пароли и ключи: вход в админку сохраните в разделе «Переменные» или войдите сами в окне браузера',
})

/** The browser of a task beside its dialog (docs/plan/57-browser-tasks.md, Б12–Б17, Б27, Б29). */
export const browserText = Object.freeze({
  /** The accessible name of the panel beside the dialog. */
  label: 'Браузер задачи',
  view: 'Браузер',
  toolbar: 'Управление браузером',
  canvas: 'Страница сайта в браузере задачи',
  status: {
    connecting: 'Подключение',
    agent: 'Работает агент',
    waiting: 'Ждём вас',
    /** The agent answered and asked nothing: the browser waits for no one (26.10.2026). */
    idle: 'Агент ответил',
    user: 'Управляете вы',
    reconnecting: 'Переподключение',
    error: 'Ошибка',
    closed: 'Сессия закрыта',
    finished: 'Агент закончил',
  },
  viewOnly: 'Только просмотр',
  otherTab: 'Управление в другой вкладке',
  /** Beside the buttons of the control after «Остановить», until core has ended the task. */
  stopping: composerText.stopping,
  fullscreen: 'Во весь экран',
  exitFullscreen: 'Свернуть',
  fullscreenHint: 'Нажмите Esc, чтобы выйти из полноэкранного режима',
  more: 'Ещё',
  windowSize: 'Размер окна браузера',
  windowSizeLocked: 'Размер окна можно изменить, когда управляете вы.',
  size: (width: number, height: number) => `${width} × ${height}`,
  tabs: 'Вкладки',
  tabOf: (index: number, count: number) => `Вкладка ${index} из ${count}`,
  untitledTab: 'Без названия',
  address: 'Адрес страницы',
  go: 'Перейти',
  reload: 'Обновить страницу',
  manualHint:
    'Агент не видит страницу, пока управляете вы. Пароль вводите прямо здесь. Чтобы вернуться к кнопкам, дважды нажмите Esc.',
  keyboard: 'Клавиатура',
  keyboardInput: 'Ввод на страницу',
  connecting: 'Подключаемся к браузеру…',
  starting: 'Браузер откроется, когда агент начнёт работу.',
  reconnecting: 'Связь прервалась. Переподключаемся…',
  reconnectingNote:
    'Агент продолжает работу — прервался только показ страницы. Пока что на экране последний кадр.',
  failed: 'Не удалось показать браузер',
  failedNote: 'Работа агента от этого не останавливается: результат появится в диалоге.',
  retry: 'Повторить',
  closed: 'Браузер закрыт',
  closedIdle: 'Браузер закрыт: 30 минут без действий',
  closedExpired: 'Браузер закрыт по времени',
  closedCrashed: 'Браузер закрылся из-за сбоя',
  closedNote:
    'Чтобы продолжить, напишите агенту в диалоге — браузер откроется заново. Войти на сайт, возможно, придётся снова.',
  finishedNote: 'Агент закончил работу в браузере. Результат — в диалоге.',
  help: {
    login: 'Войдите на сайт',
    captcha: 'Пройдите проверку',
    confirm: 'Подтвердите действие',
    other: 'Агенту нужна ваша помощь',
  },
  helpNote: 'Нажмите «Взять управление» и сделайте это сами — прямо на этой странице.',
  helpSecret:
    'Пока управляете вы, агент не видит страницу и то, что вы вводите. Пароль не пишите в чат.',
  /** While the client controls: the plate in the feed and the live block. */
  controlPlate:
    'Управляете вы. Агент ждёт. Когда закончите, нажмите «Продолжить работу агента» — справа или здесь.',
  watch: 'Смотреть, что делает агент',
  refused: {
    agent_in_control: 'Сейчас браузером управляет агент.',
    not_holder:
      'Браузером управляют в другой вкладке. Нажмите «Взять управление», чтобы управлять здесь.',
    not_ready: 'Агент заканчивает действие на странице. Подождите несколько секунд.',
    address_denied: 'На эту страницу агенту и вам переходить нельзя.',
    busy: 'Слишком много действий сразу. Подождите немного.',
    other: 'Это действие сейчас не выполнить.',
  },
  dialog: {
    title: 'Страница спрашивает',
    note: 'Сейчас управляете вы, поэтому отвечаете вы. Пока работает агент, на такие вопросы отвечает он.',
    stay: 'Остаться',
    leave: 'Покинуть',
    ok: 'ОК',
    cancel: 'Отмена',
    answer: 'Ответ странице',
    leaveQuestion: 'Покинуть страницу? Изменения могут не сохраниться.',
  },
  chooser: {
    title: 'Выберите файл для загрузки на сайт',
    note: 'Страница просит файл. Выберите из вложений задачи или загрузите новый.',
    files: 'Вложения задачи',
    none: 'У задачи пока нет вложений.',
    newNote: 'Новый файл тоже сохранится во вложениях задачи.',
    upload: 'Загрузить новый',
    cancel: 'Отмена',
    confirm: 'Загрузить на сайт',
    loading: 'Загружаем вложения…',
    loadFailed: 'Не удалось загрузить вложения задачи.',
    meta: (type: string, size: string) => `${type} · ${size}`,
  },
  separator: 'Ширина панели браузера',
})

/** The links of an object a task in the browser left on the site (Б23, Б24). */
export const objectLinkText = Object.freeze({
  open: (kind: 'post' | 'page' | null) =>
    kind === 'page' ? 'Открыть страницу' : kind === 'post' ? 'Открыть запись' : 'Открыть на сайте',
  edit: 'Изменить в админке',
})
