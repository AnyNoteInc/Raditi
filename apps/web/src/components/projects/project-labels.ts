export const stackLabels = {
  wordpress: 'WordPress',
  bitrix: '1С-Битрикс',
  laravel: 'Laravel',
  static: 'HTML / CSS',
  node: 'Node.js',
  python: 'Python',
} as const

export type ProjectStack = keyof typeof stackLabels

/** Platforms a new site can be connected on today: only these have a site adapter. */
export const connectableStacks: readonly ProjectStack[] = ['wordpress']

export const statusLabels = {
  onboarding: 'Ожидает подключения',
  active: 'Подключён',
  paused: 'На паузе',
  disconnected: 'Нет подключения',
  archived: 'В архиве',
} as const
