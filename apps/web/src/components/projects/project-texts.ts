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

/** P-create (ПР5), without the context for now (slice 84.10). */
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
  appliesHere: 'Агент учитывает инструкции и цель проекта',
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
  placeholder: 'Сообщение в новый чат проекта',
  applies: (instructions: boolean) =>
    instructions ? 'Агент учтёт инструкции и цель проекта' : 'Агент учтёт цель проекта',
  openProject: 'Открыть проект',
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
