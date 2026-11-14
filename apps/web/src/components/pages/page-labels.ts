// The words of the pages in the cabinet (docs/plan/69-pages.md, Ст13–Ст16, Ст30): Russian, «вы».

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

export const pageTexts = Object.freeze({
  title: 'Страницы',
  lead: 'Страницы и документы, которые агент сделал в чатах рабочего пространства. Ссылку на опубликованную можно переслать — откроется без входа.',
  disabled: 'Страницы здесь не настроены.',
  empty: 'Страниц пока нет. Попросите агента в чате сделать страницу — например, прайс или отчёт.',
  nothingFound: 'Ничего не нашлось.',
  search: 'Найти по названию',
  open: 'Открыть',
  copy: 'Скопировать ссылку',
  copied: 'Ссылка скопирована',
  more: (title: string) => `Действия со страницей «${title}»`,
  openPage: (title: string) => `Открыть страницу «${title}»`,
  chat: 'Чат',
  setPassword: 'Поставить пароль…',
  changePassword: 'Сменить пароль…',
  clearPassword: 'Снять пароль',
  takeDown: 'Снять с публикации',
  restore: 'Вернуть на публикацию',
  byOperator: 'Снята поддержкой',
  withPassword: 'с паролем',
  version: (version: number) => `v${version}`,
  noChat: 'Чат удалён',
  failed: 'Не получилось. Попробуйте ещё раз.',
})

export const passwordTexts = Object.freeze({
  title: 'Пароль страницы',
  lead: 'Зритель введёт его один раз на этом устройстве. Сообщите его тем, кому отправляете ссылку: агент его не знает.',
  label: 'Пароль',
  hint: (min: number, max: number) => `От ${min} до ${max} знаков`,
  save: 'Сохранить',
  cancel: 'Отмена',
})

export type PageTag = 'all' | 'live' | 'pending' | 'password' | 'taken_down'

export const pageTagLabels: Readonly<Record<PageTag, string>> = Object.freeze({
  all: 'Все',
  live: 'Опубликованы',
  pending: 'Черновики',
  password: 'С паролем',
  taken_down: 'Сняты',
})
