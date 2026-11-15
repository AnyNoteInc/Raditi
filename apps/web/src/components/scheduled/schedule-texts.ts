// The words of «Запланированные задачи» in the cabinet (docs/plan/82-scheduled-tasks.md, Зп1–Зп10,
// Зп12, Зп28, Зп30, Зп36): Russian, on «вы». The words of schedules, runs, zones and refusals are
// the domain's (`@repo/domain/schedule`) and the server's; here — the screens' own.

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
  projectGroup: 'Проект',
  allProjects: 'Все проекты',
  nothingFound: 'Ничего не нашлось.',
  reset: 'Сбросить',
  failed: 'Не удалось загрузить задачи. Попробуйте ещё раз.',
  retry: 'Повторить',
  loading: 'Загрузка задач',
  list: 'Ваши запланированные задачи',
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
})

/** The page of one task (Зп6). */
export const schedulePageTexts = Object.freeze({
  back: 'Запланированные задачи',
  instructions: 'Инструкция',
  schedule: 'Когда запускается',
  project: 'Проект',
  effort: 'Размышление',
  notify: 'Уведомления',
  notifyOn: 'Сообщим, когда задача выполнится',
  notifyOff: 'О выполнении не сообщаем — только о вопросах и сбоях',
  cost: 'Стоимость',
  runs: 'Запуски',
  runsNote: 'Последние 50 запусков.',
  noRuns: 'Задача ещё не запускалась.',
  bySchedule: 'по расписанию',
  byHand: 'вручную',
  openChat: 'Открыть чат',
  openChatOf: (when: string) => `Открыть чат запуска: ${when}`,
  missedRange: (from: string, to: string) => `Пропущены запуски с ${from} по ${to}`,
  notFound: 'Задачи уже нет.',
  notFoundLead: 'Её удалили, или она не ваша.',
  toList: 'К запланированным задачам',
  failed: 'Не удалось загрузить задачу. Попробуйте ещё раз.',
  loading: 'Загрузка задачи',
  more: 'Ещё действия',
})

/** The window «Новая запланированная задача» and «Изменить задачу» (Зп7, Зп8, Зп12, Зп28, Зп30). */
export const scheduleDialogTexts = Object.freeze({
  createTitle: 'Новая запланированная задача',
  editTitle: 'Изменить задачу',
  inChat: 'Вместо этого настроить в чате',
  name: 'Название',
  namePlaceholder: 'Например, «Проверка сайта»',
  nameRequired: 'Назовите задачу',
  instructions: 'Что сделать агенту',
  instructionsPlaceholder:
    'Например: откройте сайт, пройдите главную и важные страницы и скажите, если что-то не так.',
  instructionsRequired: 'Напишите, что сделать агенту',
  secret: 'Похоже, в инструкции пароль или ключ — уберите его',
  needsProject: 'Этому шаблону нужен проект — выберите его',
  addProject: 'Добавьте проект',
  addProjectLead: 'Этому шаблону нужен сайт.',
  warning:
    'Задача выполняется без вас: агент не будет спрашивать подтверждения, пока работает. В админке сайта он только читает, а файлы сайта меняет в предпросмотре — на сайт изменения попадут после вашего выпуска. Каждый запуск тратит кредиты.',
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
  needsProject: 'Нужен проект',
  list: 'Шаблоны задач',
})
