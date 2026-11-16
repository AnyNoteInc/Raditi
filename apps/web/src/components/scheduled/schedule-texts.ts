// The words of «Запланированные задачи» in the cabinet (docs/plan/82-scheduled-tasks.md, Зп1–Зп10,
// Зп12, Зп28, Зп30, Зп36): Russian, on «вы». The words of schedules, runs, zones and refusals are
// the domain's (`@repo/domain/schedule`) and the server's; here — the screens' own.

import { plural } from '@/lib/plural'

export const scheduledTexts = Object.freeze({
  title: 'Запланированные задачи',
  // The tooltip of the heading (Зп2).
  about:
    'Агент выполняет их сам по расписанию. Каждый запуск — новый чат и тратит кредиты, как обычный чат.',
  tabs: 'Запланированные задачи',
  yours: 'Ваши',
  templates: 'Шаблоны',
  newTask: 'Новая задача',
  newTaskMenu: 'Как настроить новую задачу',
  byHand: 'Настроить вручную',
  inChat: 'Настроить в чате',
  search: 'Найти задачу',
  searchField: 'Поиск задач',
  clearSearch: 'Очистить поиск',
  filter: 'Фильтр задач',
  sort: 'Порядок задач',
  showGroup: 'Показать',
  nothingFound: 'Ничего не нашлось.',
  reset: 'Сбросить',
  failed: 'Не удалось загрузить задачи. Попробуйте ещё раз.',
  retry: 'Повторить',
  loading: 'Загрузка задач',
  list: 'Ваши запланированные задачи',
  // The filter of the projects (Зп3; docs/plan/84-projects.md, ПР19): only when the tasks are of
  // more than one.
  projectGroup: 'Проект',
  allProjects: 'Все проекты',
  noProject: 'Без проекта',
})

/** The filter buttons of «Ваши» (Зп3). */
export const scheduleTagLabels = Object.freeze({
  all: 'Все',
  enabled: 'Включены',
  paused: 'На паузе',
  completed: 'Завершены',
  failed: 'С ошибкой',
} as const)

/** The order of «Ваши» (Зп3): by the next run first. */
export const scheduleSortLabels = Object.freeze({
  next: 'По следующему запуску',
  name: 'По названию',
  newest: 'Сначала новые',
} as const)

/** The list before the first task (Зп4). */
export const scheduledEmptyTexts = Object.freeze({
  title: 'Запланированных задач пока нет.',
  lead: 'Опишите, что агенту делать и когда, — он выполнит это сам, а результат придёт в новый чат.',
  orTemplate: 'Или начните с шаблона',
})

/** A row of «Ваши» and the page of a task (Зп5, Зп6). */
export const scheduleRowTexts = Object.freeze({
  next: (when: string) => `Следующий запуск: ${when}`,
  paused: 'На паузе',
  completed: (date: string) => `Завершена ${date}`,
  manualOnly: 'Запускается только вручную',
  lastRun: 'Последний запуск',
  noRuns: 'Ещё не запускалась',
  switchLabel: (name: string) => `Включить задачу «${name}»`,
  more: (name: string) => `Действия с задачей «${name}»`,
  runNow: 'Запустить сейчас',
  edit: 'Изменить',
  delete: 'Удалить',
  deleteTitle: (name: string) => `Удалить задачу «${name}»?`,
  deleteText: 'Чаты прошлых запусков останутся.',
  cancel: 'Отмена',
  deleted: 'Задача удалена',
  pausedNotice: 'Задача приостановлена',
  resumed: 'Задача включена',
  close: 'Закрыть',
  /** The project of a task (ПР19). */
  project: (name: string) => `Проект: ${name}`,
  noProject: 'Без проекта',
  /** Its project is in «Архив» or the trash. */
  goneName: (name: string) => `${name} (в архиве или удалён)`,
  projectGone: (name: string) => `Проект: ${name} (в архиве или удалён)`,
})

/** The page of one task (Зп6). */
export const schedulePageTexts = Object.freeze({
  back: 'Запланированные задачи',
  instructions: 'Инструкция',
  schedule: 'Когда запускается',
  effort: 'Размышление',
  notify: 'Уведомления',
  notifyOn: 'Сообщим, когда задача выполнится',
  notifyOff: 'О выполнении не сообщаем — только о вопросах и сбоях',
  cost: 'Стоимость',
  runs: 'Запуски',
  /** Said only when the page shows as many runs as it keeps: fewer are all there are. */
  runsNote: 'Последние 50 запусков.',
  noRuns: 'Задача ещё не запускалась.',
  bySchedule: 'по расписанию',
  byHand: 'вручную',
  openChat: 'Открыть чат',
  openChatOf: (when: string) => `Открыть чат запуска: ${when}`,
  /** Missed runs in a row, from the first to the last of them (Зп6). */
  missedRange: (from: string, to: string) => `Пропущены запуски с ${from} по ${to}`,
  /**
   * Missed runs in a row, from the first of them, of a row written before the server kept the last
   * one (Зп6).
   */
  missedSince: (count: number, from: string) =>
    `${plural(count, 'Пропущен', 'Пропущены', 'Пропущено')} ${count} ${plural(count, 'запуск', 'запуска', 'запусков')}, начиная с ${from}`,
  /** The visible label of the switch of the page, beside the state of the task (Зп6). */
  switchOn: 'Включена',
  switchPaused: 'На паузе',
  /** Off for a reason the state line names: completed, or stopped by the platform. */
  switchOff: 'Выключена',
  notFound: 'Задачи уже нет.',
  notFoundLead: 'Её удалили, или она не ваша.',
  toList: 'К запланированным задачам',
  failed: 'Не удалось загрузить задачу. Попробуйте ещё раз.',
  /** A reading after the task was shown failed: the page stays as it was. */
  stale: 'Не удалось обновить задачу — на странице то, что было известно раньше.',
  loading: 'Загрузка задачи',
  more: 'Ещё действия',
  project: 'Проект',
})

/** The window «Новая запланированная задача» and «Изменить задачу» (Зп7, Зп8, Зп12, Зп28, Зп30). */
export const scheduleDialogTexts = Object.freeze({
  createTitle: 'Новая запланированная задача',
  editTitle: 'Изменить задачу',
  inChat: 'Вместо этого настроить в чате',
  name: 'Название',
  namePlaceholder: 'Например, «Отзывы за неделю»',
  nameRequired: 'Назовите задачу',
  nameSecret: 'Похоже, в названии пароль или ключ — уберите его',
  instructions: 'Что сделать агенту',
  instructionsPlaceholder:
    'Например: найди новые отзывы о нашей кофейне и коротко перескажи, что хвалят и на что жалуются.',
  instructionsRequired: 'Напишите, что сделать агенту',
  /** Under the instructions of a template with a place to fill in, from the first look (Зп59). */
  placeholderHint: 'Замените текст в квадратных скобках своим',
  secret: 'Похоже, в инструкции пароль или ключ — уберите его',
  // Rule 10, in place of the quote of Зп28 (Зп56).
  warning:
    'Задача выполняется без вас: агент не будет спрашивать подтверждения, пока работает. На сайтах он только читает — ничего не отправляет, не сохраняет и не покупает, страницы из раздела «Страницы» не публикует и не меняет, к подключённым сервисам, которым нужен ваш ключ доступа, не обращается. Что нужно изменить, он подготовит и спросит вас в чате запуска. Каждый запуск тратит кредиты.',
  when: 'Когда запускать',
  schedule: (index: number) => `Время запуска ${index}`,
  frequency: 'Как часто',
  time: 'Время',
  date: 'Дата',
  minute: 'Минута часа',
  minuteOption: (minute: number) => String(minute).padStart(2, '0'),
  dayOfMonth: 'Число месяца',
  days: 'Дни недели',
  daysRequired: 'Выберите хотя бы один день',
  dateRequired: 'Укажите дату',
  addTime: 'Добавить время',
  remove: 'Убрать',
  removeLabel: (index: number) => `Убрать время запуска ${index}`,
  next: (when: string) => `Следующий запуск: ${when}`,
  manualOnly: 'Задача запустится, только когда вы нажмёте «Запустить сейчас».',
  notify: 'Уведомлять, когда задача выполнится',
  notifyHint: 'О вопросах агента и сбоях сообщим в любом случае.',
  more: 'Дополнительные настройки',
  timezone: 'Часовой пояс',
  timezoneOfBrowser: (label: string) => `${label} — пояс этого браузера`,
  cancel: 'Отмена',
  create: 'Создать',
  save: 'Сохранить',
  created: 'Задача создана',
  saved: 'Изменения сохранены',
  /** The window opened in a project (ПР19, P-schedule). */
  fixedProject: (name: string) => `Проект: ${name}`,
  fixedProjectTail: ', задача закреплена за этим проектом',
  // In a project with a repository, beside the warning (ПР19, P-schedule).
  repositoryWarning:
    'Задача выполняется без вас: агент не принимает изменения в основную ветку, не выкатывает и не меняет настройки сборки — он подготовит изменения, а запрос на слияние вы откроете сами.',
  projectRun:
    'Каждый запуск — новый чат в этом проекте: агент учтёт его инструкции, контекст и память.',
  templates: 'Начать с шаблона',
  templatesLabel: 'Шаблоны задач проекта',
})

/** «Запланировано» of the column of a project and its window (ПР19, P-schedule-list). */
export const projectScheduleTexts = Object.freeze({
  title: 'Запланировано',
  add: 'Добавить',
  addLabel: 'Добавить запланированную задачу в проект',
  open: 'Посмотреть',
  openLabel: 'Посмотреть запланированные задачи проекта',
  empty: 'Задачи, которые агент выполняет сам по расписанию.',
  loading: 'Загружаем запланированные задачи',
  retry: 'Ещё раз',
  line: (name: string, when: string) => `${name} · ${when}`,
  more: (count: number) => `и ещё ${count} ${plural(count, 'задача', 'задачи', 'задач')}`,
  lead: 'Задачи запускаются сами, без вас. Каждый запуск — новый чат в этом проекте.',
  none: 'В этом проекте пока нет запланированных задач.',
  lastRuns: 'Последний запуск',
  allIn: 'Все задачи рабочего пространства — в разделе',
  allLink: '«Задачи»',
  close: 'Закрыть',
  failed: 'Не удалось загрузить задачи. Попробуйте ещё раз.',
  archived: 'Проект в архиве — верните его, чтобы добавить задачу.',
})

/** «Включить задачу» of the chat (ПР19). */
export const scheduleConfirmTexts = Object.freeze({
  title: 'Включить задачу',
  lead: 'Задачу настроил агент. Она запустится без вас, поэтому включить её можете только вы — проверьте текст и расписание.',
  instructions: 'Что сделать агенту',
  schedule: 'Когда запускать',
  confirm: 'Включить задачу',
  confirmed: 'Задача включена',
  changed: 'Задача изменилась — посмотрите её ещё раз.',
})

/** «Стоимость» of the window and of the page (Зп30). */
export const scheduleCostTexts = Object.freeze({
  each: (average: number) =>
    `Каждый запуск тратит кредиты, как обычный чат, — в среднем около ${average}.`,
  week: (credits: number) => `Так выйдет примерно ${credits} в неделю`,
  limit: (limit: number) => `; ваш недельный лимит — ${limit}.`,
  over: 'Остальным чатам останется меньше.',
})

/** The draft of a new chat that sets a task up with the agent (Зп10). */
export const scheduleChatDraft = Object.freeze({
  start: 'Помогите настроить запланированную задачу',
})

/** «Уже настроен» of a template already used (Зп9). */
export const scheduleTemplateTexts = Object.freeze({
  used: 'Уже настроен',
  list: 'Шаблоны задач',
})
