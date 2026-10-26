import { expect, test } from '@playwright/test'

import { control, requireStand, signIn, stand } from './stand.ts'
import {
  addProject,
  basics,
  expectInitialVersion,
  expectProjectChip,
  fillDatabase,
  fillSsh,
  hostKeyPanel,
  nextButton,
  openWizard,
  siteSections,
  stepTitle,
} from './wizard.ts'

// b1 runs alone and first (playwright.site-import.config.ts, project `held`): core is not
// running yet, so the new project waits in the queue for as long as the test looks at it — the
// setup screen, the closed sections, the chip of the list — and then has the stand start core.

test.skip(!stand, 'Run through pnpm verify:site-import')

test('[b1] SSH with a password and MySQL: the key is compared, the setup screen holds, v0.0.0', async ({
  page,
  context,
}) => {
  const { users, fingerprints, holdCore } = requireStand()
  await signIn(context, 'b1')
  await openWizard(page)
  await basics(page, 'b1', 'Сайт B1')

  await fillSsh(page, { user: users.site.user, password: users.site.password })
  // The answer of the check is held back a moment, so its «Проверяем…» can be seen.
  await page.route('**/api/trpc/siteConnection.checkSource*', async (route) => {
    const response = await route.fetch()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.fulfill({ response })
  })
  await nextButton(page).click()
  await expect(page.getByText('Проверяем подключение…')).toBeVisible()
  const panel = hostKeyPanel(page, 'unknown')
  await expect(panel).toBeVisible()
  await expect(panel.locator('code')).toHaveText(fingerprints.first)
  await expect(panel).toContainText('мы не отправим серверу ни пользователя, ни пароль')
  await page.unroute('**/api/trpc/siteConnection.checkSource*')
  await panel.getByRole('button', { name: 'Ключ совпадает, продолжить' }).click()
  await expect(stepTitle(page)).toHaveText('База данных')

  await fillDatabase(page, 'mysql')
  const projectId = await addProject(page)

  // The setup screen alone: no sections, and the address of a section leads back to it.
  await expect(page.getByRole('heading', { level: 1, name: 'Настраиваем сайт' })).toBeVisible()
  if (holdCore) await expect(page.getByText('Ожидаем начала настройки')).toBeVisible()
  await expect(siteSections(page)).toHaveCount(0)
  await page.goto(`/projects/${projectId}/changes`)
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/overview$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Настраиваем сайт' })).toBeVisible()
  await expect(siteSections(page)).toHaveCount(0)
  if (holdCore) {
    await expectProjectChip(page, 'Сайт B1', 'Настраиваем')
    await page.goto(`/projects/${projectId}`)
    await control('/core/start')
  }

  await expectInitialVersion(page)
  await expectProjectChip(page, 'Сайт B1', 'Подключён')
})
