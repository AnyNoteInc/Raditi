// The words of the section «Артефакты» in the cabinet (docs/plan/88-artifacts.md, Ар43–Ар50;
// boards Main, A-empty, A-create, C-doc, D-conflict, D-history, F-publish): Russian, «вы», no
// jargon (rule 10). The names of kinds are `artifactKindSpecs[kind].label`, of refusals —
// `artifactRefusalTexts`; the domain's `artifactTexts` holds the words several surfaces share.

/** «1 раздел», «2 раздела», «5 разделов». */
function pluralRu(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const dateTime = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
})

export const galleryTexts = Object.freeze({
  title: 'Артефакты',
  about:
    'Документы, холсты, макеты и таблицы, над которыми вы работаете вместе с агентом. Страницы для посетителей — в разделе «Страницы».',
  create: 'Создать',
  askAgent: 'Попросить агента в чате',
  search: 'Поиск по артефактам',
  filters: {
    all: 'Все',
    mine: 'Мои',
    projects: 'В проектах',
    shared: 'Доступные мне',
    trash: 'Корзина',
  },
  filtersLabel: 'Показать',
  kindLabel: 'Вид',
  projectLabel: 'Проект',
  sortLabel: 'Порядок',
  anyKind: 'Все',
  anyProject: 'Все',
  sorts: { newest: 'Сначала новые', oldest: 'Сначала старые', title: 'По названию' },
  layoutLabel: 'Вид списка',
  cards: 'Карточки',
  list: 'Список',
  nothingFound: 'Ничего не нашлось.',
  resetFilters: 'Сбросить фильтры',
  sharedEmpty: 'Пока никто не поделился с вами артефактом.',
  trashEmpty: 'В корзине пусто.',
  failed: 'Не получилось загрузить артефакты. Обновите страницу.',
  version: (no: number) => (no > 0 ? `версия ${no}` : 'без версий'),
  sections: (count: number) => `${count} ${pluralRu(count, 'раздел', 'раздела', 'разделов')}`,
  updated: (at: string) => `изменён ${dateFormat.format(new Date(at))}`,
  purgeOn: (at: string) => `Удалится ${dateFormat.format(new Date(at))}`,
  personal: 'Без проекта',
  open: (title: string) => `Открыть «${title}»`,
  actions: (title: string) => `Действия с «${title}»`,
  toTrash: 'В корзину',
  restore: 'Вернуть',
  trashed: (title: string) => `«${title}» в корзине: он удалится через 30 дней.`,
  restored: (title: string) => `«${title}» снова в списке.`,
  undo: 'Вернуть',
  emptyText: 'Пока пусто',
})

export const emptyTexts = Object.freeze({
  title: 'Здесь будут ваши артефакты',
  lead: 'Попросите агента сделать документ, макет сайта или таблицу — они появятся здесь, и вы будете менять их вместе. Страницы для посетителей — в разделе «Страницы».',
  templates: 'С чего начать',
})

export const createTexts = Object.freeze({
  title: 'Новый артефакт',
  kind: 'Вид',
  soon: 'Скоро',
  kindHints: {
    document: 'Текст по разделам',
    canvas: 'Несколько макетов рядом',
    mockup: 'Одна страница: прототип, калькулятор',
    table: 'Строки и столбцы',
    diagram: 'Блоки и стрелки',
    slides: 'Слайды',
    image: 'Баннер, пост, логотип',
    brand: 'Цвета, шрифты, тон',
    sitemap: 'Страницы сайта и связи между ними',
    report: 'Текст с графиками и таблицами',
  } as Record<string, string>,
  name: 'Название',
  namePlaceholder: 'Например, «Тексты для сайта»',
  nameRequired: 'Назовите артефакт',
  place: 'Где хранить',
  personal: 'Без проекта — только в «Моих»',
  start: 'С чего начать',
  empty: 'Пусто',
  fromTemplate: 'Из шаблона',
  askAgent: 'Попросить агента',
  whatToDo: 'Что сделать?',
  askPlaceholder: 'Например: подготовьте правила возврата для интернет-магазина одежды',
  askNote: 'Агент начнёт в новом чате; артефакт откроется рядом с чатом.',
  template: 'Шаблон',
  cancel: 'Отмена',
  submit: 'Создать',
  failed: 'Не получилось создать артефакт. Попробуйте ещё раз.',
})

export const formatDateTime = (at: string | Date) => dateTime.format(new Date(at))
