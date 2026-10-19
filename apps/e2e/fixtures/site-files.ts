import { randomBytes } from 'node:crypto'

import { expect, type Page } from '@playwright/test'
import { startTestSftpServer } from '@repo/site-connections/testing'

// The site a customer of the browser billing run adds, and the wizard «Добавить проект» that adds
// it. A customer's first site is what makes the workspace and grants the gift of the registration,
// and the product has one way to add a site: the wizard checks the files of the site over the
// network, and «Добавить проект» checks them again and writes the access to Vault before it creates
// anything (docs/plan/39-site-connection-wizard.md). So the run has both: the OpenBao of
// playwright.billing.config.ts, and this — a synthetic WordPress on the test SFTP server of
// @repo/site-connections, started by the test worker on loopback, behind a password of the run.
// Web connects to it as to any server a customer names; nothing of anyone is on it.

const SITE_ROOT = '/var/www/kofeynya'

/** The files of the site as «Доступ к файлам» asks for them, and the logins its server has seen. */
export interface SiteFiles {
  host: string
  port: number
  /** The fingerprint of the key of the server, as the wizard shows it. */
  hostKey: string
  username: string
  password: string
  rootPath: string
  /** How many times anyone has tried to log in to the server so far. */
  logins(): number
  close(): Promise<void>
}

/**
 * A WordPress as far as the check of the wizard reads one: the two markers of the platform and a
 * small file to read. A fresh host key and a fresh password every time.
 */
export async function startSiteFiles(): Promise<SiteFiles> {
  const username = 'kofeynya'
  const password = randomBytes(18).toString('base64url')
  const server = await startTestSftpServer({
    files: {
      [`${SITE_ROOT}/index.php`]:
        "<?php\n// A synthetic WordPress of the browser billing run.\nrequire __DIR__ . '/wp-blog-header.php';\n",
      [`${SITE_ROOT}/wp-includes/version.php`]: "<?php\n$wp_version = '6.8.3';\n",
      [`${SITE_ROOT}/wp-content/index.php`]: '<?php\n// Silence is golden.\n',
    },
    users: [{ username, password }],
  })
  return {
    host: server.host,
    port: server.port,
    hostKey: server.hostKey,
    username,
    password,
    rootPath: SITE_ROOT,
    logins: () => server.authAttempts.length,
    close: () => server.close(),
  }
}

// Each step may open a page the development server compiles on first use.
const SLOW = { timeout: 60_000 }

/** The wizard is open on «Основные данные»: the name and the address are typed, «Далее». */
export async function fillBasics(page: Page, { name, url }: { name: string; url: string }) {
  await expect(page.getByRole('heading', { level: 1, name: 'Новый проект' })).toBeVisible(SLOW)
  await expect(page.getByRole('heading', { level: 2, name: 'Основные данные' })).toBeVisible()
  await page.getByLabel('Название проекта').fill(name)
  await page.getByLabel('Адрес сайта').fill(url)
  await page.getByRole('button', { name: 'Далее' }).click()
}

/** From «Проекты» to the wizard, by «Добавить проект». */
export async function openWizard(page: Page) {
  await page.goto('/projects')
  await expect(page.getByRole('heading', { level: 1, name: 'Проекты' })).toBeVisible(SLOW)
  await page.getByRole('link', { name: 'Добавить проект' }).first().click()
  await expect(page).toHaveURL('/projects/new', SLOW)
}

/**
 * Adds a site the way a customer does, in the browser: «Добавить проект» on «Проекты»; «Основные
 * данные»; «Доступ к файлам» over SSH with the password — the first «Далее» shows the key of the
 * server, which is the key of this server, and sends it no login; «Ключ совпадает, продолжить»;
 * «База данных» left at «Без базы данных»; «Добавить проект». The wizard leads to the page of the
 * new site, which says that the site is being set up and waits for its first import — no core
 * runs here to take it. Resolves to the id of the site.
 */
export async function addSiteInWizard(
  page: Page,
  files: SiteFiles,
  { name, url }: { name: string; url: string },
): Promise<string> {
  await openWizard(page)
  await fillBasics(page, { name, url })

  await expect(page.getByRole('heading', { level: 2, name: 'Доступ к файлам' })).toBeVisible(SLOW)
  await expect(page.getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true')
  // Fields by their exact names: «Папка сайта на сервере» holds «сервер» too, and «Пароль» is
  // also the radio of the way to log in.
  const field = (name: string) => page.getByRole('textbox', { name, exact: true })
  await field('Сервер').fill(files.host)
  await field('Порт').fill(String(files.port))
  await field('Пользователь').fill(files.username)
  await expect(field('Пароль')).toHaveAttribute('type', 'password')
  await field('Пароль').fill(files.password)
  await field('Папка сайта на сервере').fill(files.rootPath)
  const logins = files.logins()
  await page.getByRole('button', { name: 'Далее' }).click()

  const key = page.getByRole('region', { name: 'Сверьте ключ сервера' })
  await expect(key).toContainText(files.hostKey, SLOW)
  // Until the key is confirmed the server is sent neither the user nor the password.
  expect(files.logins()).toBe(logins)
  await key.getByRole('button', { name: 'Ключ совпадает, продолжить' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'База данных' })).toBeVisible(SLOW)
  await expect(page.getByRole('radio', { name: /^Без базы данных/ })).toBeChecked()
  await page.getByRole('button', { name: 'Добавить проект' }).click()

  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/, SLOW)
  await expect(page.getByRole('heading', { level: 1, name: 'Настраиваем сайт' })).toBeVisible(SLOW)
  await expect(page.getByRole('banner', { name: 'Панель сайта' })).toContainText(name)
  // Nothing of the run imports the files: the first import waits for core, which is not here.
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Ожидаем начала настройки')
  const id = new URL(page.url()).pathname.split('/').at(-1)
  if (!id) throw new Error('The wizard led to no page of a site')
  return id
}
