import { expect, test, type Page } from '@playwright/test'

// The notice about cookies (privacy policy, 9.6). The runs start with the choice made
// (fixtures/cookie-choice.ts); these tests open a context without it, as a first visit.
test.use({ storageState: { cookies: [], origins: [] } })

const notice = (page: Page) => page.getByRole('region', { name: 'Файлы cookie' })

test('shows on the first visit, keeps the choice and opens again from the footer', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await expect(notice(page)).toBeVisible()
  await expect(notice(page).getByRole('link', { name: /Политике обработки/ })).toHaveAttribute(
    'href',
    '/terms/privacy-policy',
  )

  await notice(page).getByRole('button', { name: 'Только необходимые' }).click()
  await expect(notice(page)).toHaveCount(0)
  const stored = (await context.cookies()).find((c) => c.name === 'raditi_cookie_consent')
  expect(stored?.value).toMatch(/^v1\.necessary\.\d+$/)

  // The server reads the choice: the notice is not in the page at all, not hidden after paint.
  const html = await (await page.request.get('/')).text()
  expect(html).not.toContain('Файлы cookie')
  await page.reload()
  await expect(notice(page)).toHaveCount(0)

  await page.getByRole('button', { name: 'Настройки cookie' }).click()
  await expect(notice(page)).toBeVisible()
  await notice(page).getByRole('button', { name: 'Принять все' }).click()
  await expect(notice(page)).toHaveCount(0)
  const accepted = (await context.cookies()).find((c) => c.name === 'raditi_cookie_consent')
  expect(accepted?.value).toMatch(/^v1\.all\.\d+$/)
})

test('fits a phone without a horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/')
  const box = await notice(page).boundingBox()
  expect(box?.x).toBe(16)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBe(304)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
})
