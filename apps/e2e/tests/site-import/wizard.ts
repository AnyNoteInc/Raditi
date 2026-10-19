import { expect, type Locator, type Page } from '@playwright/test'

import { projectUrl, requireStand } from './stand.ts'

// The wizard «Новый проект» (apps/web/src/components/projects/wizard) as a user fills it: by the
// ids of its fields (`wizard-source-…`, `wizard-database-…`), its buttons and its texts.

export const SETUP_POLL_TIMEOUT = 180_000

export const stepTitle = (page: Page): Locator => page.locator('#wizard-step-title')
export const problem = (page: Page): Locator => page.locator('#wizard-problem')
export const nextButton = (page: Page): Locator => page.getByRole('button', { name: 'Далее' })

/** The panel of the server's key: `unknown` before any login, `changed` after another key. */
export function hostKeyPanel(page: Page, kind: 'unknown' | 'changed'): Locator {
  return page.getByRole('region', {
    name: kind === 'unknown' ? 'Сверьте ключ сервера' : 'Ключ сервера изменился',
  })
}

export async function openWizard(page: Page): Promise<void> {
  await page.goto('/projects/new')
  await expect(page.getByRole('heading', { level: 1, name: 'Новый проект' })).toBeVisible()
}

/** Step 1, then «Далее»: the second step opens. */
export async function basics(page: Page, id: string, name: string): Promise<void> {
  await page.locator('#project-name').fill(name)
  await page.locator('#project-url').fill(projectUrl(id))
  await nextButton(page).click()
  await expect(stepTitle(page)).toHaveText('Доступ к файлам')
}

export interface SshFields {
  hosting?: 'site' | 'spare'
  user: string
  password?: string
  key?: { privateKey: string; passphrase?: string }
  root?: string
}

/** The SSH tab: server, port, user, password or key, the folder of the site. */
export async function fillSsh(page: Page, fields: SshFields): Promise<void> {
  const stand = requireStand()
  const hosting = stand.hostings[fields.hosting ?? 'site']
  await page.getByRole('tab', { name: 'SSH' }).click()
  await page.locator('#wizard-source-host').fill(hosting.host)
  await page.locator('#wizard-source-port').fill(String(hosting.ssh))
  await page.locator('#wizard-source-username').fill(fields.user)
  if (fields.key) {
    await page.getByRole('radio', { name: 'Ключ' }).check()
    await page.locator('#wizard-source-privateKey').fill(fields.key.privateKey)
    await page.locator('#wizard-source-passphrase').fill(fields.key.passphrase ?? '')
  } else {
    await page.getByRole('radio', { name: 'Пароль' }).check()
    await page.locator('#wizard-source-password').fill(fields.password ?? '')
  }
  await page.locator('#wizard-source-rootPath').fill(fields.root ?? stand.roots.site)
}

/** The FTP tab with the protection chosen in «Защита соединения». */
export async function fillFtp(
  page: Page,
  fields: { user: string; password: string; tls: 'verified' | 'plain' },
): Promise<void> {
  const stand = requireStand()
  await page.getByRole('tab', { name: 'FTP' }).click()
  await page.locator('#wizard-source-host').fill(stand.hostings.site.host)
  await page.locator('#wizard-source-port').fill(String(stand.hostings.site.ftp))
  await page.locator('#wizard-source-username').fill(fields.user)
  await page.locator('#wizard-source-password').fill(fields.password)
  await page.locator('#wizard-source-rootPath').fill(stand.roots.site)
  if (fields.tls === 'plain') {
    await page.locator('#wizard-source-tls').click()
    await page.getByRole('option', { name: 'Без шифрования' }).click()
    await expect(page.getByText('Пароль и данные будут передаваться открыто.')).toBeVisible()
  } else {
    await expect(page.locator('#wizard-source-tls')).toHaveText('FTPS с проверкой сертификата')
  }
}

/**
 * «Далее» of an SSH step without a confirmed key: the panel shows the key of the hosting before
 * anything is sent, its fingerprint is the one the stand computed, «Ключ совпадает» goes on.
 */
export async function confirmFirstKey(page: Page): Promise<void> {
  await nextButton(page).click()
  const panel = hostKeyPanel(page, 'unknown')
  await expect(panel).toBeVisible()
  await expect(panel.locator('code')).toHaveText(requireStand().fingerprints.first)
  await panel.getByRole('button', { name: 'Ключ совпадает, продолжить' }).click()
}

/** Step 3 with a database: the provider, its fields, the default protection «TLS с проверкой». */
export async function fillDatabase(page: Page, engine: 'mysql' | 'postgres', password?: string) {
  const access = requireStand().databases[engine]
  await page.getByRole('radio', { name: engine === 'mysql' ? /^MySQL/ : /^PostgreSQL/ }).check()
  await page.locator('#wizard-database-host').fill(access.host)
  await page.locator('#wizard-database-port').fill(String(access.port))
  await page.locator('#wizard-database-database').fill(access.database)
  await page.locator('#wizard-database-username').fill(access.user)
  await page.locator('#wizard-database-password').fill(password ?? access.password)
  await expect(page.locator('#wizard-database-tls')).toHaveText('TLS с проверкой сертификата')
}

/** «Добавить проект» and the page of the new project; resolves to its id. */
export async function addProject(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Добавить проект' }).click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}(?:\/overview)?$/, { timeout: 120_000 })
  const id = /\/projects\/([0-9a-f-]{36})/.exec(page.url())?.[1]
  if (!id) throw new Error('The wizard did not open the page of the project')
  return id
}

/** The section rail of a site; absent while its first import is not done. */
export const siteSections = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Разделы сайта' })

/** «Обзор» after the import: the card of the first version with its tag. */
export async function expectInitialVersion(page: Page): Promise<void> {
  await expect(page.getByText('Первоначальная версия сайта сохранена')).toBeVisible({
    timeout: SETUP_POLL_TIMEOUT,
  })
  await expect(page.getByText('v0.0.0', { exact: true })).toBeVisible()
  await expect(siteSections(page).first()).toBeVisible()
}

/** The chip of the project in «Проекты», found by its name. */
export async function expectProjectChip(page: Page, name: string, chip: string): Promise<void> {
  await page.goto('/projects')
  const row = page.getByRole('listitem').filter({ hasText: name })
  await expect(row.getByText(chip, { exact: true })).toBeVisible()
}
