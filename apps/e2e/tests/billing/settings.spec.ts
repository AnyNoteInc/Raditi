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

test('a signed-in user opens the settings and collapses the sidebar', async ({
  page,
  signedInUser,
}) => {
  await page.goto('/settings')
  await expect(page).toHaveURL('/settings')
  const sidebar = page.getByRole('complementary', { name: 'Боковая панель' })

  await test.step('the shell names the section and the user', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Общее' })).toBeVisible()
    const sections = sidebar.getByRole('navigation', { name: 'Разделы настроек' })
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

    const name = `${signedInUser.name} ${signedInUser.lastName}`
    const userBlock = sidebar.getByRole('button', {
      name: `Меню пользователя: ${name}, ${signedInUser.email}`,
    })
    await expect(userBlock).toContainText(name)
    await expect(userBlock).toContainText(signedInUser.email)
  })

  await test.step('a collapsed sidebar stays collapsed after a reload', async () => {
    const collapse = page.getByRole('button', { name: 'Свернуть боковую панель' })
    const expand = page.getByRole('button', { name: 'Развернуть боковую панель' })
    await expect(sidebar).toHaveCSS('width', '264px')

    await hydrated(collapse)
    await collapse.click()
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(sidebar).toHaveCSS('width', '72px')

    await page.reload()
    // The server reads the choice from the cookie: the page arrives collapsed, still signed in.
    await expect(page).toHaveURL('/settings')
    await expect(expand).toHaveAttribute('aria-expanded', 'false')
    await expect(sidebar).toHaveCSS('width', '72px')
    await expect(
      sidebar.getByRole('button', { name: 'Меню пользователя в боковой панели' }),
    ).toBeVisible()
  })
})

test('an anonymous visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto('/settings')
  await expect(page).toHaveURL('/sign-in?next=%2Fsettings')
})
