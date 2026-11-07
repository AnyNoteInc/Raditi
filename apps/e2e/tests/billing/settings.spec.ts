import type { Locator } from '@playwright/test'

import { expect, test } from '../../fixtures/signed-in.ts'

// The settings shell in a real browser, for a user the fixture has signed in.

/** Waits until React has taken the element over: a click before that is not heard. */
function hydrated(element: Locator): Promise<void> {
  return element.evaluate(
    (node) =>
      new Promise<void>((done) => {
        // React keeps its props on a hydrated node.
        const check = () =>
          Object.keys(node).some((key) => key.startsWith('__reactProps'))
            ? done()
            : requestAnimationFrame(check)
        check()
      }),
  )
}

test('a signed-in user opens the settings and hides their panel', async ({
  page,
  signedInUser,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/settings')
  await expect(page).toHaveURL('/settings')
  // The sections of the settings are the panel beside the rail of the cabinet
  // (docs/plan/64-cabinet-navigation.md, Н2).
  const panel = page.getByRole('complementary', { name: 'Настройки' })
  const rail = page.getByRole('complementary', { name: 'Боковая панель' })

  await test.step('the shell names the section and the user', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Общее' })).toBeVisible()
    const sections = panel.getByRole('navigation', { name: 'Разделы настроек' })
    await expect(sections.getByRole('link', { name: 'Общее' })).toHaveAttribute(
      'aria-current',
      'page',
    )

    const breadcrumbs = page.getByRole('navigation', { name: 'Хлебные крошки' })
    await expect(breadcrumbs).toHaveText(/^Настройки\s*\/\s*Общее$/)
    await expect(breadcrumbs.getByRole('link', { name: 'Настройки' })).toHaveAttribute(
      'href',
      '/settings',
    )
    await expect(breadcrumbs.getByText('Общее')).toHaveAttribute('aria-current', 'page')

    // The rail of the cabinet leads to the chats and the projects, the account menu at its foot.
    const main = rail.getByRole('navigation', { name: 'Основная навигация' })
    await expect(main.getByRole('link', { name: 'Чаты' })).toHaveAttribute('href', '/chats')
    await expect(main.getByRole('link', { name: 'Проекты' })).toHaveAttribute('href', '/projects')
    await expect(
      rail.getByRole('button', { name: 'Меню пользователя в боковой панели' }),
    ).toBeVisible()
    void signedInUser
  })

  await test.step('a hidden panel stays hidden after a reload', async () => {
    const hide = panel.getByRole('button', { name: 'Скрыть панель' })
    const show = page.getByRole('button', { name: 'Показать панель' })
    await hydrated(hide)
    await hide.click()
    await expect(panel).toBeHidden()
    await expect(show).toHaveAttribute('aria-expanded', 'false')

    await page.reload()
    // The server reads the choice from the cookie: the page arrives without the panel.
    await expect(page).toHaveURL('/settings')
    await expect(panel).toBeHidden()
    await hydrated(show)
    await show.click()
    await expect(panel).toBeVisible()
  })
})

test('an anonymous visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto('/settings')
  await expect(page).toHaveURL('/sign-in?next=%2Fsettings')
})
