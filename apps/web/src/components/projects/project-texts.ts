import { formatMoscowDay } from '@/lib/moscow-date'
import { plural } from '@/lib/plural'

import { sameMoscowDay } from '@/components/chat/chat-format'

// The words of «Проекты» (docs/plan/84-projects.md, ПР3–ПР6, ПР20, ПР30, §4.8): on «вы», a chat is
// «чат», never «сессия».

export const PROJECTS_HREF = '/projects'
export const projectHref = (projectId: string) => `${PROJECTS_HREF}/${projectId}`

export const projectsText = Object.freeze({
  title: 'Проекты',
  newProject: 'Новый проект',
  search: 'Поиск по проектам',
  sortLabel: 'Порядок проектов',
  sort: { recent: 'Недавние', name: 'По названию', created: 'По дате создания' },
  tabsLabel: 'Показать проекты',
  tabs: { all: 'Все', starred: 'Избранное', archive: 'Архив', trash: 'Корзина' },
  loading: 'Загружаем проекты',
  failed: 'Не удалось загрузить проекты. Обновите страницу.',
  nothingFound: 'Ничего не нашлось.',
  emptyTab: {
    starred: 'В избранном пока ничего нет — отметьте проект звёздочкой.',
    archive: 'В архиве пусто.',
    trash: 'Корзина пуста.',
  },
  resetSearch: 'Сбросить поиск',
  chats: (count: number) => `${count} ${plural(count, 'чат', 'чата', 'чатов')}`,
  archivedMark: 'в архиве',
  purgeOn: (at: Date) => `Удалится навсегда ${formatMoscowDay(at)}`,
  open: (name: string) => `Открыть проект «${name}»`,
  menu: (name: string) => `Действия с проектом «${name}»`,
  star: 'В избранное',
  unstar: 'Убрать из избранного',
  starLabel: (name: string) => `Проект «${name}» в избранное`,
  unstarLabel: (name: string) => `Убрать проект «${name}» из избранного`,
  rename: 'Переименовать',
  archive: 'В архив',
  unarchive: 'Вернуть из архива',
  remove: 'Удалить',
  removeHint: 'В корзину на 30 дней',
  restore: 'Вернуть',
  removeTitle: (name: string) => `Удалить проект «${name}»?`,
  removeBody:
    'Проект и его чаты 30 дней полежат в корзине — оттуда их можно вернуть. Потом они удалятся навсегда. Агент остановится, если сейчас работает в чате этого проекта.',
  removeKeep: 'Не удалять',
  removeConfirm: 'В корзину',
  renameTitle: 'Переименовать проект',
  nameLabel: 'Название проекта',
  save: 'Сохранить',
  cancel: 'Отмена',
  removed: (name: string) => `Проект «${name}» в корзине.`,
  restored: (name: string) => `Проект «${name}» возвращён.`,
  archived: (name: string) => `Проект «${name}» в архиве.`,
  unarchived: (name: string) => `Проект «${name}» снова в списке.`,
})

/** P-empty (ПР4): the list before the first project. */
export const projectsEmptyText = Object.freeze({
  title: 'Хотите создать проект?',
  lead: 'Загружайте материалы, задавайте свои инструкции и держите чаты по одному делу в одном месте.',
  start: 'Новый проект',
  examplesTitle: 'Начать с примера',
  examples: [
    {
      name: 'Сайт и его обновления',
      goal: 'Держать сайт в порядке: новые страницы, цены и тексты — в одном тоне.',
      icon: 'globe',
    },
    {
      name: 'Отчёты и таблицы',
      goal: 'Сводки за месяц и таблицы, которые можно сразу отправить бухгалтеру.',
      icon: 'usage',
    },
    {
      name: 'Рассылки и тексты',
      goal: 'Письма клиентам и посты для соцсетей на месяц вперёд.',
      icon: 'document',
    },
  ],
} as const)

/** P-create (ПР5); its context — `contextText`. */
export const projectCreateText = Object.freeze({
  title: 'Создание проекта',
  name: 'Над чем вы работаете?',
  namePlaceholder: 'Например, сайт пекарни',
  goal: 'Чего вы хотите достичь?',
  goalHint: 'Необязательно',
  goalPlaceholder: 'Например, обновить сайт к зиме: новое меню и онлайн-заказ тортов',
  cancel: 'Отмена',
  create: 'Создать проект',
  nameRequired: 'Назовите проект',
})

/** The page of a project (ПР6; Main, P-project, P-phone). */
export const projectPageText = Object.freeze({
  back: 'Все проекты',
  placeholder: (name: string) => `Новый чат в проекте «${name}»`,
  appliesHere: 'Агент учитывает инструкции, цель, контекст и память проекта',
  chats: 'Чаты проекта',
  noChats: 'Здесь появятся чаты этого проекта.',
  hints: [
    'Опишите, чего вы хотите добиться в первом чате',
    'Добавьте инструкции — агент будет читать их в каждом чате проекта',
  ],
  archived: 'Проект в архиве — верните его, чтобы начать чат.',
  unarchive: 'Вернуть из архива',
  instructions: 'Инструкции',
  instructionsAdd: 'Добавить',
  instructionsEdit: 'Изменить',
  instructionsEmpty: 'Агент читает их в каждом чате проекта',
  instructionsLabel: 'Инструкции проекта',
  instructionsHint: 'Как отвечать, что учитывать, чего не делать. Без паролей и ключей.',
  instructionsCount: (count: number, limit: number) => `${count} из ${limit}`,
  instructionsTitle: 'Инструкции проекта',
  privacy: 'Приватный',
  privacyHint: 'Видите только вы',
  created: 'Проект создан',
  notFound: 'Такого проекта нет',
  notFoundBody: 'Возможно, его удалили. Вернуть проект из корзины можно на странице «Проекты».',
})

/** The pill of a project in the field of a new chat (ПР30; C-new-chat-menu, C-phone-new-chat). */
export const projectPickerText = Object.freeze({
  none: 'Без проекта',
  noneHint: 'Обычный чат — без инструкций и материалов проекта',
  label: 'Проект для чата',
  pill: (name: string) => `Проект: ${name}`,
  search: 'Найти проект',
  projects: 'Проекты',
  starred: 'в избранном',
  instructions: 'Инструкции',
  plain: 'Без инструкций',
  newProject: 'Новый проект',
  nothingFound: 'Ничего не нашлось',
  heading: (name: string) => `Новый чат в проекте «${name}»`,
  /** The project of the address while the list of projects is on its way. */
  loading: 'Загружаем проект…',
  headingLoading: 'Новый чат в проекте',
  placeholder: 'Сообщение в новый чат проекта',
  applies: (instructions: boolean) =>
    instructions ? 'Агент учтёт инструкции и цель проекта' : 'Агент учтёт цель проекта',
  openProject: 'Открыть проект',
})

/**
 * «Контекст» of a project (ПР8, ПР24, §4.8; P-create, P-create-menu, P-context-menu, P-context,
 * P-context-text, P-phone-sheet): the files and texts the agent reads in every chat of the project.
 */
export const contextText = Object.freeze({
  title: 'Контекст',
  optional: 'необязательно',
  add: 'Добавить',
  addContext: 'Добавить контекст',
  addTitle: 'Добавить в контекст',
  addLabel: 'Добавить в контекст проекта',
  createHint: 'Файлы и тексты. Агент читает их в каждом чате проекта.',
  dropHint: 'Перетащите файлы сюда',
  device: 'Загрузить с устройства',
  deviceHint: 'Документы, таблицы, фото и код',
  files: 'Файлы…',
  folder: 'Папку…',
  text: 'Добавить текстовое содержимое',
  textHint: 'Заметка или текст до 100 000 знаков',
  githubLink: 'Ссылка на GitHub',
  githubLinkHint: 'Публичный репозиторий — только чтение',
  gitlab: 'Подключить GitLab',
  gitlabHint: 'Код, запросы на слияние и сборки',
  github: 'Подключить GitHub',
  githubHint: 'Код, запросы на слияние и сборки',
  soon: 'Скоро',
  limits: 'Файлы до 20 МБ, всего до 100 МБ на проект',
  lead: 'Агент видит эти материалы в каждом чате проекта и сам находит в них нужное. Картинки он не видит — может только поставить их на страницу; PDF, таблицы и тексты читает.',
  used: (percent: number) => `Занято ${percent} % места`,
  usedOf: (bytes: number, limit: number) =>
    `${Math.ceil(bytes / (1024 * 1024))} из ${Math.round(limit / (1024 * 1024))} МБ`,
  usedLabel: 'Занятое место',
  list: 'Файлы и тексты',
  empty: 'Здесь будут файлы и тексты проекта: брендбук, прайс, заметки.',
  rowEmpty: 'Файлы и тексты, которые агент читает в каждом чате проекта',
  more: (count: number) => `и ещё ${count} ${plural(count, 'файл', 'файла', 'файлов')}`,
  open: 'Открыть контекст проекта',
  kindText: 'Текст',
  added: (at: Date) => `добавлен ${formatMoscowDay(at)}`,
  download: (name: string) => `Скачать «${name}»`,
  remove: (name: string) => `Убрать «${name}»`,
  removed: (name: string) => `«${name}» больше не в контексте.`,
  removeFailed: 'Не удалось убрать файл. Попробуйте ещё раз.',
  uploading: (percent: number) => `Загружается… ${percent} %`,
  progress: (name: string) => `Загрузка «${name}»`,
  retry: 'Повторить',
  retryNamed: (name: string) => `Загрузить «${name}» ещё раз`,
  failed: 'Не удалось загрузить файл.',
  loading: 'Загружаем контекст',
  loadFailed: 'Не удалось загрузить контекст. Обновите страницу.',
  done: 'Готово',
  close: 'Закрыть',
  waitUploads: 'Дождитесь, пока загрузятся файлы.',
  textTitle: 'Добавить текстовое содержимое',
  textName: 'Название',
  textNamePlaceholder: 'Например, ответы на отзывы',
  textBody: 'Текст',
  textNote: 'Текст сохранится файлом и попадёт в контекст проекта. Без паролей и ключей.',
  textCount: (count: number, limit: number) =>
    `${count.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')}`,
  textNameRequired: 'Назовите текст',
  textBodyRequired: 'Напишите текст',
  textCancel: 'Отмена',
  textAdd: 'Добавить',
  mentionLabel: 'Файлы контекста проекта',
  mentionNone: 'В контексте проекта нет файлов.',
})

/** «Перенести в проект…» and «Убрать из проекта» of a chat (ПР2). */
export const moveText = Object.freeze({
  move: 'Перенести в проект…',
  takeOut: 'Убрать из проекта',
  title: 'Перенести в проект',
  lead: 'Со следующего ответа агент учтёт инструкции нового проекта.',
  current: 'сейчас здесь',
  noProjects: 'Проектов пока нет — создайте первый на странице «Проекты».',
  cancel: 'Отмена',
  crumb: (name: string) => `Проект «${name}»`,
})

/** «обновлён 12 мин назад», «вчера», «10 нояб.»: when a project last changed, for its card. */
export function projectUpdatedText(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000)
  if (minutes < 1) return 'обновлён только что'
  if (minutes < 60) return `обновлён ${minutes} мин назад`
  if (sameMoscowDay(at, now)) return `обновлён ${Math.floor(minutes / 60)} ч назад`
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  if (sameMoscowDay(at, yesterday)) return 'обновлён вчера'
  const days = Math.ceil(minutes / (24 * 60))
  if (days < 7) return `обновлён ${days} ${plural(days, 'день', 'дня', 'дней')} назад`
  return `обновлён ${formatMoscowDay(at)}`
}

/**
 * «Память» of a project and of the account (docs/plan/84-projects.md, ПР18, ПР28, §4.8;
 * P-memory-empty, P-memory): one name for what waits for the client — «Предложено».
 */
export const memoryText = Object.freeze({
  title: 'Память',
  accountTitle: 'Память аккаунта',
  open: 'Посмотреть',
  openLabel: 'Открыть память проекта',
  rowEmpty: 'Пока пусто. Скажите агенту «запомни…»',
  entries: (count: number) => `${count} ${plural(count, 'запись', 'записи', 'записей')}`,
  proposedCount: (count: number) =>
    `${count} ${plural(count, 'предложена', 'предложены', 'предложено')}`,
  lead: 'Агент читает сохранённые записи в каждом чате проекта как фон. Ваши слова в чате важнее.',
  accountLead:
    'Агент читает эти записи в ваших чатах без проекта как фон — и в проектах, где включена память аккаунта. Ваши слова в чате важнее.',
  emptyTitle: 'Память пока пуста',
  empty: 'Скажите агенту «запомни…» — или он сам предложит сохранить важное по ходу чатов.',
  proposed: 'Предложено',
  proposedHint: 'Агент их не учитывает, пока вы не сохраните',
  saved: 'Сохранено',
  add: 'Добавить запись',
  save: 'Сохранить',
  drop: 'Не надо',
  kept: 'Сохранено',
  dropped: 'Не сохранено',
  forgotten: 'Удалено',
  forget: 'Удалить',
  edit: 'Изменить',
  editLabel: (text: string) => `Изменить запись «${text}»`,
  removeLabel: (text: string) => `Удалить запись «${text}»`,
  cancel: 'Отмена',
  kindLabel: 'Вид записи',
  kinds: {
    preference: 'Предпочтение',
    fact: 'Факт',
    decision: 'Решение',
    reference: 'Ссылка',
  },
  textLabel: 'Текст записи',
  count: (count: number, limit: number) => `${count} из ${limit}`,
  textRequired: 'Напишите запись',
  proposedIn: (title: string | null) =>
    title ? `предложено в чате «${title}»` : 'предложено агентом',
  fromChat: (title: string | null) => (title ? `из чата «${title}»` : 'из чата'),
  byClient: 'добавлено вами',
  updateProposed: 'Агент предлагает изменить запись',
  updateNow: (text: string) => `Сейчас: ${text}`,
  forgetProposed: 'Агент предлагает забыть эту запись',
  useAccount: 'Использовать память аккаунта',
  useAccountHint:
    'Агент учитывает в этом проекте и то, что запомнил в чатах без проекта. Память других проектов сюда не попадает.',
  seeAccount: 'Посмотреть память аккаунта',
  clear: 'Очистить память',
  clearTitle: 'Очистить память?',
  clearBody: 'Все записи удалятся навсегда. Чаты останутся.',
  clearConfirm: 'Очистить',
  off: 'Память агента выключена — агент не читает и не пишет записи.',
  offLink: 'Включить в настройках',
  full: (limit: number) => `В памяти ${limit} записей — удалите ненужные, чтобы добавить новую.`,
  loading: 'Загружаем память',
  loadFailed: 'Не удалось загрузить память. Обновите страницу.',
  failed: 'Не удалось сохранить. Попробуйте ещё раз.',
  close: 'Закрыть',
  done: 'Готово',
  when: (at: Date, now: Date) => {
    if (sameMoscowDay(at, now)) return 'сегодня'
    if (sameMoscowDay(at, new Date(now.getTime() - 24 * 60 * 60 * 1000))) return 'вчера'
    return formatMoscowDay(at)
  },
  /** «Настройки → Общее → Память агента». */
  settingsTitle: 'Память агента',
  settingsSwitch: 'Агент запоминает важное',
  settingsHint:
    'Агент записывает короткие записки — ваши предпочтения, факты и решения — и учитывает их в следующих чатах. Выключите, и он не будет ни читать, ни писать память; записи останутся.',
  settingsHref: '/settings#memory',
})
