import { expect, test, type Page } from '@playwright/test'

import { control, projectUrl, requireStand, signIn, stand } from './stand.ts'
import {
  addProject,
  basics,
  confirmFirstKey,
  expectInitialVersion,
  fillDatabase,
  fillFtp,
  fillSsh,
  hostKeyPanel,
  nextButton,
  openWizard,
  problem,
  stepTitle,
} from './wizard.ts'

// The wizard on real servers: every access the owner can give, every refusal a step can meet,
// and a creation sent again. The stand checks each project from outside after the run.

test.skip(!stand, 'Run through pnpm verify:site-import')

/** How many checks of the files the page has sent since the call. */
function countChecks(page: Page): () => number {
  let count = 0
  page.on('request', (request) => {
    if (request.url().includes('/api/trpc/siteConnection.checkSource')) count += 1
  })
  return () => count
}

test('[b2] FTPS with a verified certificate, user ftpsite, without a database', async ({
  page,
  context,
}) => {
  const { users } = requireStand()
  await signIn(context, 'b2')
  await openWizard(page)
  await basics(page, 'b2', 'Сайт B2')
  await fillFtp(page, {
    user: users.ftpsite.user,
    password: users.ftpsite.password,
    tls: 'verified',
  })
  await nextButton(page).click()
  // FTP has no key to compare: the check goes straight to the next step.
  await expect(stepTitle(page)).toHaveText('База данных')
  await expect(page.getByRole('radio', { name: /^Без базы данных/ })).toBeChecked()
  await addProject(page)
  await expectInitialVersion(page)
})

test('[b3] SSH with a key behind a passphrase and PostgreSQL over verified TLS', async ({
  page,
  context,
}) => {
  const { users } = requireStand()
  await signIn(context, 'b3')
  await openWizard(page)
  await basics(page, 'b3', 'Сайт B3')
  await fillSsh(page, { user: users.site.user, key: users.site.keyWithPassphrase })
  await confirmFirstKey(page)
  await expect(stepTitle(page)).toHaveText('База данных')
  await fillDatabase(page, 'postgres')
  await addProject(page)
  await expectInitialVersion(page)
})

test('[b4] a wrong password stays on the step with its text; «Назад» keeps what was typed', async ({
  page,
  context,
}) => {
  const { users, roots } = requireStand()
  await signIn(context, 'b4auth')
  await openWizard(page)
  await basics(page, 'b4', 'Сайт B4 пароль')
  await fillSsh(page, { user: users.site.user, password: `${users.site.password}-wrong` })
  await confirmFirstKey(page)
  await expect(problem(page)).toHaveText(
    'Сервер не принял пользователя, пароль или ключ. Проверьте их в панели хостинга.',
  )
  await expect(stepTitle(page)).toHaveText('Доступ к файлам')
  // The key stays confirmed: the corrected password is checked at once.
  await page.locator('#wizard-source-password').fill(users.site.password)
  await nextButton(page).click()
  await expect(stepTitle(page)).toHaveText('База данных')

  await page.getByRole('button', { name: 'Назад' }).click()
  await expect(stepTitle(page)).toHaveText('Доступ к файлам')
  await expect(page.locator('#wizard-source-host')).toHaveValue(requireStand().hostings.site.host)
  await expect(page.locator('#wizard-source-username')).toHaveValue(users.site.user)
  await expect(page.locator('#wizard-source-rootPath')).toHaveValue(roots.site)
  expect(await page.locator('#wizard-source-password').inputValue()).toBe(users.site.password)
})

test('[b4] a folder without WordPress: not_site_root, and the suggested folder that works', async ({
  page,
  context,
}) => {
  const { users, roots } = requireStand()
  await signIn(context, 'b4root')
  await openWizard(page)
  await basics(page, 'b4', 'Сайт B4 папка')
  await fillSsh(page, { user: users.site.user, password: users.site.password, root: roots.empty })
  await confirmFirstKey(page)
  await expect(problem(page)).toContainText(
    'В этой папке нет файлов сайта на WordPress. Укажите папку, где лежат файлы сайта.',
  )
  await expect(problem(page).getByRole('button')).toHaveCount(0)

  await page.locator('#wizard-source-rootPath').fill(roots.nestedParent)
  await nextButton(page).click()
  await expect(problem(page)).toContainText('В этой папке нет файлов сайта на WordPress.')
  await expect(problem(page)).toContainText(`Похоже, сайт лежит в папке ${roots.nested}.`)
  await problem(page)
    .getByRole('button', { name: `Подставить папку «${roots.nested}»` })
    .click()
  await expect(page.locator('#wizard-source-rootPath')).toHaveValue(roots.nested)
  await nextButton(page).click()
  await expect(stepTitle(page)).toHaveText('База данных')
})

test('[b4] a changed host key: the warning with the new fingerprint, accepted only by its button', async ({
  page,
  context,
}) => {
  const { users, fingerprints, roots } = requireStand()
  await signIn(context, 'b4hostkey')
  const checks = countChecks(page)
  await openWizard(page)
  await basics(page, 'b4', 'Сайт B4 ключ')
  await fillSsh(page, { hosting: 'spare', user: users.site.user, password: users.site.password })
  await confirmFirstKey(page)
  await expect(stepTitle(page)).toHaveText('База данных')
  const passed = checks()

  // Back and forth after a passed check: no new check.
  await page.getByRole('button', { name: 'Назад' }).click()
  await nextButton(page).click()
  await expect(stepTitle(page)).toHaveText('База данных')
  expect(checks()).toBe(passed)

  // An edit makes the check count no longer; the server now presents another key.
  await page.getByRole('button', { name: 'Назад' }).click()
  await page.locator('#wizard-source-rootPath').fill(`${roots.site}/`)
  await page.locator('#wizard-source-rootPath').fill(roots.site)
  await control('/spare/host-key/second')
  try {
    await nextButton(page).click()
    const panel = hostKeyPanel(page, 'changed')
    await expect(panel).toBeVisible()
    await expect(panel.locator('code')).toHaveText(fingerprints.second)
    expect(checks()).toBe(passed + 1)
    await expect(stepTitle(page)).toHaveText('Доступ к файлам')
    await panel.getByRole('button', { name: 'Принять новый ключ' }).click()
    await expect(stepTitle(page)).toHaveText('База данных')
  } finally {
    await control('/spare/host-key/first')
  }
})

test('[b4] a wrong database password refuses the creation on the third step', async ({
  page,
  context,
}) => {
  const { users, databases } = requireStand()
  await signIn(context, 'b4database')
  await openWizard(page)
  await basics(page, 'b4', 'Сайт B4 база')
  await fillSsh(page, { user: users.site.user, password: users.site.password })
  await confirmFirstKey(page)
  await fillDatabase(page, 'mysql', `${databases.mysql.password}-wrong`)
  await page.getByRole('button', { name: 'Добавить проект' }).click()
  await expect(problem(page)).toHaveText(
    'Сервер базы данных не принял пользователя или пароль. Проверьте их в панели хостинга.',
  )
  await expect(stepTitle(page)).toHaveText('База данных')
  await expect(page).toHaveURL(/\/projects\/new$/)
})

test('[b5] the same creation sent again finds the same project; another address under its key is refused', async ({
  page,
  context,
}) => {
  const { users } = requireStand()
  await signIn(context, 'b5')
  await openWizard(page)
  await basics(page, 'b5', 'Сайт B5')
  await fillFtp(page, { user: users.site.user, password: users.site.password, tls: 'plain' })
  await nextButton(page).click()
  await expect(stepTitle(page)).toHaveText('База данных')

  let sent: { url: string; body: string } | null = null
  await page.route('**/api/trpc/project.create*', async (route) => {
    sent = { url: route.request().url(), body: route.request().postData() ?? '' }
    await route.continue()
  })
  const projectId = await addProject(page)
  await page.unroute('**/api/trpc/project.create*')
  const request = sent as { url: string; body: string } | null
  if (!request) throw new Error('The wizard sent no creation')

  type Answer = {
    result?: { data?: { json?: { outcome?: string; project?: { id?: string } } } }
    error?: { json?: { data?: { domainCode?: string } } }
  }
  const send = async (body: string): Promise<Answer> => {
    const response = await page.request.post(request.url, {
      data: body,
      headers: { 'content-type': 'application/json' },
    })
    const answer = (await response.json()) as Answer[]
    if (!answer[0]) throw new Error('No answer to the creation')
    return answer[0]
  }
  for (let again = 0; again < 2; again += 1) {
    const replay = await send(request.body)
    expect(replay.result?.data?.json?.outcome).toBe('created')
    expect(replay.result?.data?.json?.project?.id).toBe(projectId)
  }
  const other = JSON.parse(request.body) as Record<string, { json: { url: string } }>
  const first = other['0']
  if (!first) throw new Error('A batch of one creation')
  first.json.url = projectUrl('b5-other')
  const conflict = await send(JSON.stringify(other))
  expect(conflict.error?.json?.data?.domainCode).toBe('PROJECT_REQUEST_CONFLICT')

  await expectInitialVersion(page)
})
