// The words of the pages in the cabinet (docs/plan/69-pages.md, Ст13–Ст16, Ст30;
// docs/plan/73-pages-sites.md, Дер1–Дер8): Russian, «вы».

export const pageKindLabels = Object.freeze({
  html: 'Страница',
  markdown: 'Страница из текста',
  doc: 'Документ',
} as const)

export const pageStateLabels = Object.freeze({
  pending: 'Ещё не опубликована',
  live: 'Опубликована',
  taken_down: 'Снята',
} as const)

/** A date as the client reads it: «14 декабря», with the year only when it is not this one. */
export function pageDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'Europe/Moscow',
  }).format(date)
}

export const pageTexts = Object.freeze({
  title: 'Страницы',
  // The tooltip of the heading (docs/plan/73-pages-sites.md, Дер7; the owner's «давай», В10).
  about:
    'Страницы и сайты, которые агент сделал для вашего рабочего пространства. Ссылку на опубликованную можно переслать — откроется без входа.',
  newChat: 'Новый чат',
  disabled: 'Страницы здесь не настроены.',
  nothingFound: 'Ничего не нашлось.',
  resetFilters: 'Сбросить фильтры',
  search: 'Найти по названию',
  open: 'Открыть',
  copy: 'Скопировать ссылку',
  copied: 'Ссылка скопирована',
  more: (title: string) => `Действия со страницей «${title}»`,
  openPage: (title: string) => `Открыть страницу «${title}»`,
  setPassword: 'Поставить пароль…',
  changePassword: 'Сменить пароль…',
  clearPassword: 'Снять пароль',
  takeDown: 'Снять с публикации',
  restore: 'Вернуть на публикацию',
  byOperator: 'Снята поддержкой',
  withPassword: 'с паролем',
  version: (version: number) => `v${version}`,
  failed: 'Не получилось. Попробуйте ещё раз.',
})

/** A site of pages in the cabinet (docs/plan/73-pages-sites.md, Дер30, §7.4). */
export const treeTexts = Object.freeze({
  rename: 'Переименовать…',
  readdress: 'Изменить адрес…',
  move: 'Переместить…',
  up: 'Выше',
  down: 'Ниже',
  saved: 'Сохранено',
  titleLabel: 'Название страницы',
  segmentLabel: 'Адрес страницы',
  segmentHint: 'Латинские буквы, цифры и дефис',
  parentLabel: 'Внутри страницы',
  redirectNote: 'Старый адрес будет вести на новый.',
  dialogTitle: {
    rename: (title: string) => `Переименовать «${title}»`,
    readdress: (title: string) => `Адрес страницы «${title}»`,
    move: (title: string) => `Переместить «${title}»`,
  },
  pages: (count: number) =>
    `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'страница' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'страницы' : 'страниц'}`,
  expand: (title: string) => `Показать страницы сайта «${title}»`,
  collapse: (title: string) => `Скрыть страницы сайта «${title}»`,
  takeDownSite: 'Снять сайт с публикации',
  deleteSite: 'Удалить сайт…',
})

/** The shared files of a site (docs/plan/73-pages-sites.md, Дер34). */
export const fileTexts = Object.freeze({
  action: 'Файлы сайта…',
  title: (title: string) => `Файлы сайта «${title}»`,
  loading: 'Загружаем…',
  empty: 'У сайта пока нет общих файлов.',
  note: 'Общие файлы — стили, скрипты, картинки и шрифты, которые страницы сайта берут со своего адреса. Их кладёт агент: попросите его в чате.',
  size: (bytes: number) =>
    bytes < 1024
      ? `${bytes} Б`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} КБ`
        : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`,
  delete: 'Удалить',
  deleteLabel: (path: string) => `Удалить файл ${path}`,
  deleted: 'Файл удалён',
  close: 'Закрыть',
})

/** The own name of a site (docs/plan/73-pages-sites.md, Дер32). */
export const nameTexts = Object.freeze({
  action: 'Адрес сайта…',
  title: (title: string) => `Адрес сайта «${title}»`,
  label: 'Имя сайта',
  hint: 'От 3 до 25 латинских букв, цифр и дефисов',
  placeholder: 'имя',
  note: 'Прежний адрес продолжит вести на сайт. Адрес с именем легко угадать — закройте сайт паролем, если он не для всех.',
  needsPlan: 'Своё имя сайта доступно на тарифах «Бизнес» и «Агентство».',
  plans: 'Тарифы',
  saved: 'Адрес сайта сохранён',
})

/** Links of a page to its site that lead nowhere (docs/plan/73-pages-sites.md, Дер20). */
export const pageLinkTexts = Object.freeze({
  missing: 'На странице есть ссылки на страницы, которых в сайте нет:',
  relative: 'Ссылки без косой черты в начале откроют не то:',
  ask: 'Попросите агента их поправить.',
})

/** The trash (docs/plan/73-pages-sites.md, Дер2, §7.3). */
/** «3 вложенные страницы» — the pages that go with a page. */
const belowWords = (below: number) =>
  `${below} ${below % 10 === 1 && below % 100 !== 11 ? 'вложенную страницу' : [2, 3, 4].includes(below % 10) && ![12, 13, 14].includes(below % 100) ? 'вложенные страницы' : 'вложенных страниц'}`

export const trashTexts = Object.freeze({
  delete: 'Удалить…',
  deleted: 'Удалена',
  purgeOn: (iso: string) => `Удалится навсегда ${pageDate(iso)}`,
  returnBack: 'Вернуть',
  purge: 'Удалить навсегда…',
  movedToTrash: 'Перенесено в корзину',
  allInTrash: 'Все страницы в корзине.',
  openTrash: 'Открыть корзину',
  returned: 'Страница возвращена',
  purged: 'Страница удалена навсегда',
  // The confirmation of a deletion: what the viewers lose, and that it comes back for 30 days.
  confirmTitle: (title: string, below = 0) =>
    below > 0 ? `Удалить «${title}» и ещё ${belowWords(below)}?` : `Удалить «${title}»?`,
  confirmText: (days: number) =>
    `Ссылка перестанет открываться — у тех, кому вы её отправили, тоже. ${days} дней страницу можно вернуть из корзины.`,
  confirm: 'Удалить',
  cancel: 'Отмена',
  purgeTitle: (title: string, below = 0) =>
    below > 0
      ? `Удалить «${title}» и ещё ${belowWords(below)} навсегда?`
      : `Удалить «${title}» навсегда?`,
  purgeText: (below = 0) =>
    below > 0
      ? 'Вернуть их будет нельзя: страницы и все их версии исчезнут.'
      : 'Вернуть её будет нельзя: страница и все её версии исчезнут.',
  purgeConfirm: 'Удалить навсегда',
  // The card of a page in an old chat (Дер5).
  inTrash: 'Страница удалена',
  gone: 'Страницы больше нет',
})

/**
 * The first visit (docs/plan/73-pages-sites.md, Дер6, §7.1): no pages and nothing in the trash —
 * no filters, a word of what will be here and requests to begin a chat with.
 */
export const pageEmptyTexts = Object.freeze({
  title: 'Здесь появятся ваши страницы и сайты',
  lead: 'Попросите агента в чате — он сделает страницу или целый сайт из нескольких страниц и опубликует по ссылке. Ссылку можно переслать, а при желании закрыть паролем.',
  start: 'Начать чат',
  examplesTitle: 'Можно начать с такой просьбы:',
  examples: [
    {
      icon: 'globe',
      text: 'Сделай сайт-визитку моей компании: главная, услуги и контакты',
    },
    { icon: 'document', text: 'Собери прайс-лист страницей и опубликуй по ссылке' },
    {
      icon: 'pages',
      text: 'Сделай лендинг ноябрьской акции с кнопкой «Позвонить»',
    },
  ],
  note: 'Страницы не попадают в поиск. Пароль можно поставить на любую страницу.',
  address: 'ваш-сайт',
} as const)

export const passwordTexts = Object.freeze({
  title: 'Пароль страницы',
  lead: 'Зритель введёт его один раз на этом устройстве. Сообщите его тем, кому отправляете ссылку: агент его не знает.',
  label: 'Пароль',
  hint: (min: number, max: number) => `От ${min} до ${max} знаков`,
  save: 'Сохранить',
  cancel: 'Отмена',
})

export type PageTag = 'all' | 'live' | 'pending' | 'password' | 'taken_down' | 'trash'

export const pageTagLabels: Readonly<Record<PageTag, string>> = Object.freeze({
  all: 'Все',
  live: 'Опубликованы',
  pending: 'Черновики',
  password: 'С паролем',
  taken_down: 'Сняты',
  trash: 'Корзина',
})
