import { expect, test } from '@playwright/test'

import { requireStand, signIn, stand } from './stand.ts'
import { SETUP_POLL_TIMEOUT, expectInitialVersion, siteSections } from './wizard.ts'

// The screen «Настраиваем сайт» of imports that stopped: the stand made these sites and broke
// them (infra/dev/site-import-verify) — r6 has a password the hosting no longer takes, r4 a
// foreign v0.0.0 in its repository.

test.skip(!stand, 'Run through pnpm verify:site-import')

const STOPPED = 'Настройка остановилась'

test('[r6] «Повторить» fails again; «Изменить доступ» with the new password, under the saved key, finishes the import', async ({
  page,
  context,
}) => {
  const { sites, users, hostings, roots } = requireStand()
  if (!sites.r6) throw new Error('The stand made no site for r6')
  await signIn(context, 'r6')
  await page.goto(`/projects/${sites.r6}`)
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: SETUP_POLL_TIMEOUT })
  await expect(
    page.getByText(
      'Сервер не принял сохранённые данные для входа. Если пароль или ключ меняли, укажите доступ заново.',
    ),
  ).toBeVisible()
  await expect(siteSections(page)).toHaveCount(0)

  // «Повторить»: the next attempt runs, and stops on the same password.
  const retry = page.getByRole('button', { name: 'Повторить' })
  await retry.click()
  await expect(retry).toBeHidden()
  await expect(retry).toBeVisible({ timeout: SETUP_POLL_TIMEOUT })
  await expect(page.getByText(STOPPED)).toBeVisible()

  // «Изменить доступ»: the public part of the saved access is filled in, never a secret.
  await page.getByRole('button', { name: 'Изменить доступ' }).click()
  await expect(page.getByRole('heading', { name: 'Новый доступ к файлам' })).toBeVisible()
  await expect(page.locator('#replace-access-host')).toHaveValue(hostings.site.host)
  await expect(page.locator('#replace-access-port')).toHaveValue(String(hostings.site.ssh))
  await expect(page.locator('#replace-access-rootPath')).toHaveValue(roots.site)
  expect(await page.locator('#replace-access-password').inputValue()).toBe('')
  await page.locator('#replace-access-username').fill(users.siteb.user)
  await page.locator('#replace-access-password').fill(users.siteb.password)
  await page.getByRole('button', { name: 'Сохранить доступ' }).click()
  // The same server keeps the key confirmed at creation: the new password goes to that key only,
  // and nothing asks to compare it again.
  await expect(page.getByText('Настраиваем сайт').first()).toBeVisible()
  await expectInitialVersion(page)
})

test('[r4] a foreign v0.0.0: the setup screen names the stop safely and offers no forced way out', async ({
  page,
  context,
}) => {
  const { sites } = requireStand()
  if (!sites.r4) throw new Error('The stand named no site for r4')
  await signIn(context, 'r4')
  const text = page.getByText(
    'Для этого сайта уже сохранена другая первоначальная версия, и повтор её не заменит. Напишите нам — мы разберёмся.',
  )
  // The stand imports, breaks and retries the site meanwhile: the page is opened until it stops.
  await expect
    .poll(
      async () => {
        await page.goto(`/projects/${sites.r4}`)
        return text.count()
      },
      { timeout: 180_000, intervals: [5_000] },
    )
    .toBe(1)
  await expect(page.getByText(STOPPED)).toBeVisible()
  await expect(siteSections(page)).toHaveCount(0)
})
