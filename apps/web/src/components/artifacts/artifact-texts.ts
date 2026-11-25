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

/** «изменено 2 ч назад», «изменено вчера», «изменено 20 ноября»: when an artifact last changed. */
function updatedText(at: string, now: Date): string {
  const then = new Date(at)
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000)
  if (minutes < 1) return 'изменено только что'
  if (minutes < 60) return `изменено ${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `изменено ${hours} ч назад`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'изменено вчера'
  if (days < 7) return `изменено ${days} ${pluralRu(days, 'день', 'дня', 'дней')} назад`
  return `изменено ${dateFormat.format(then)}`
}

export const galleryTexts = Object.freeze({
  title: 'Артефакты',
  about:
    'Документы, холсты, презентации и изображения, которые вы делаете вместе с агентом. Страницы для посетителей — в разделе «Страницы».',
  create: 'Создать',
  search: 'Поиск по артефактам',
  filters: {
    all: 'Все',
    mine: 'Мои',
    shared: 'Доступные мне',
    trash: 'Корзина',
  },
  filtersLabel: 'Показать',
  kindLabel: 'Вид',
  anyKind: 'Все виды',
  project: (name: string) => `Проект «${name}»`,
  projectReset: 'Показать артефакты всех проектов',
  nothingFound: 'Ничего не нашлось.',
  resetFilters: 'Сбросить фильтры',
  sharedEmpty: 'Пока никто не поделился с вами артефактом.',
  trashEmpty: 'В корзине пусто.',
  failed: 'Не получилось загрузить артефакты. Обновите страницу.',
  updated: (at: string, now: Date = new Date()) => updatedText(at, now),
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
  more: 'Ещё',
  createFailed: 'Не получилось создать артефакт. Попробуйте ещё раз.',
})

export const emptyTexts = Object.freeze({
  title: 'Здесь будут ваши артефакты',
  lead: 'Документы, сайты и прототипы на холсте, презентации и картинки, которые вы делаете вместе с агентом.',
  templates: 'Или начните с шаблона',
})

export const createTexts = Object.freeze({
  title: 'Новый артефакт',
  close: 'Закрыть',
  kind: 'Вид',
  kindHints: {
    document: 'Текст по разделам',
    canvas: 'Сайт, прототип, калькулятор',
    slides: 'Слайды для показа',
    image: 'Пост, баннер, обложка',
  } as Readonly<Record<string, string>>,
  name: 'Название',
  namePlaceholder: 'Например, «Тексты для сайта»',
  nameRequired: 'Назовите артефакт',
  place: 'Где хранить',
  personal: 'Без проекта',
  empty: 'Создать пустой',
  backToAgent: 'Попросить агента',
  askAgent: 'Попросить агента',
  whatToDo: 'Что сделать?',
  askPlaceholder: {
    document: 'Например: подготовьте правила возврата для интернет-магазина одежды',
    canvas: 'Например: сделайте главную страницу сайта пекарни с меню и контактами',
    slides: 'Например: презентация компании на пять слайдов для новых клиентов',
    image: 'Например: пост для соцсетей о скидке 20% на выходных',
  } as Readonly<Record<string, string>>,
  askNote: 'Просьба откроется в новом чате — проверьте её и отправьте агенту.',
  /** The draft of the new chat: the kind first, so the agent makes the right one. */
  draft: (kind: string, request: string) => `${kind}: ${request}`,
  submit: 'Создать',
  failed: 'Не получилось создать артефакт. Попробуйте ещё раз.',
})

export const formatDateTime = (at: string | Date) => dateTime.format(new Date(at))

export const editorTexts = Object.freeze({
  heading: 'Заголовок раздела',
  style: 'Стиль текста',
  paragraph: 'Обычный текст',
  headingLevel: (level: number) => `Заголовок ${level - 2}`,
  bold: 'Жирный',
  italic: 'Курсив',
  strike: 'Зачёркнутый',
  bullets: 'Маркированный список',
  numbers: 'Нумерованный список',
  tasks: 'Список задач',
  quote: 'Цитата',
  table: 'Вставить таблицу',
  undo: 'Отменить',
  redo: 'Повторить',
  label: (heading: string) => `Текст раздела «${heading}»`,
})

export const documentTexts = Object.freeze({
  sections: 'Разделы',
  edit: 'Править',
  editLabel: (heading: string) => `Править раздел «${heading}»`,
  more: 'Ещё',
  section: 'Раздел',
  insertAfter: (heading: string) => `Добавить раздел после «${heading}»`,
  addNote: 'Добавить заметку к цитате',
  done: 'Готово',
  saving: 'Сохраняем…',
  saved: 'Сохранено',
  unsaved: 'Не сохранено',
  addSection: 'Добавить раздел',
  newHeading: 'Новый раздел',
  sectionActions: (heading: string) => `Действия с разделом «${heading}»`,
  remove: 'Удалить раздел',
  moveUp: 'Выше',
  moveDown: 'Ниже',
  untitled: 'Без заголовка',
  empty: 'В документе пока нет разделов.',
  agentWriting: 'Пишет агент',
  agentWritingNamed: (label: string) => `Пишет агент · ${label}`,
  checking: 'Агент пишет этот раздел — текст появится, как только мы его проверим',
  humanEditing: (name: string) => `Правит ${name}`,
  waitTitle: 'Агент пишет — вы ждёте',
  waitText: (label: string | null) =>
    label === null
      ? 'Этот раздел сейчас пишет агент. Ваша правка подождёт.'
      : `Этот раздел сейчас пишет агент «${label}». Ваша правка подождёт.`,
  wait: 'Подождать',
  takeBack: 'Забрать правку',
  divergedTitle: 'Разошлись',
  divergedLead: 'Раздел изменили, пока вы правили',
  divergedText:
    'Вы отошли больше чем на 30 секунд — раздел перестал быть занятым, и его успели изменить.',
  yourText: 'Ваш текст',
  otherText: 'Другой текст',
  removed: 'убрано:',
  added: 'добавлено:',
  keepMine: 'Оставить мой',
  takeOther: 'Взять другой',
  mergeByHand: 'Совместить вручную',
  bothKept: 'Обе версии сохранены в истории.',
  byHandNote: 'Ваш текст — ниже. Перенесите из него, что нужно, и нажмите «Готово».',
  failed: 'Не получилось сохранить правку. Попробуйте ещё раз.',
  loadFailed: 'Не получилось открыть артефакт.',
  notFound: 'Артефакт не найден, или к нему нет доступа.',
  title: 'Название артефакта',
  rename: 'Переименовать',
  trashed: 'Артефакт в корзине.',
})
