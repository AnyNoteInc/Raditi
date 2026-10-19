export const stackLabels = {
  wordpress: 'WordPress',
  bitrix: '1С-Битрикс',
  laravel: 'Laravel',
  static: 'HTML / CSS',
  node: 'Node.js',
  python: 'Python',
} as const

export type ProjectStack = keyof typeof stackLabels

export const statusLabels = {
  onboarding: 'Ожидает подключения',
  active: 'Подключён',
  paused: 'На паузе',
  disconnected: 'Нет подключения',
  archived: 'В архиве',
} as const

/**
 * Where the first import of a site stands (`siteSetupState`): `pending` while its files are being
 * copied, `failed` after the copy stopped, `done` once the first version is saved; null for a site
 * from before the wizard.
 */
export type ProjectSetup = 'pending' | 'failed' | 'done' | null

/** While the site is being set up the chip says how that goes; then the status of the site. */
const setupChips = {
  pending: { label: 'Настраиваем', color: 'default' },
  failed: { label: 'Ошибка настройки', color: 'error' },
} as const

export function projectChip(project: { status: keyof typeof statusLabels; setup?: ProjectSetup }): {
  label: string
  color: 'default' | 'success' | 'error'
} {
  if (project.setup === 'pending' || project.setup === 'failed') return setupChips[project.setup]
  return {
    label: statusLabels[project.status],
    color: project.status === 'active' ? 'success' : 'default',
  }
}
