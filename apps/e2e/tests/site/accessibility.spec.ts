import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'

import { baseURL } from '../../fixtures/billing-stand.ts'
import { expect, test } from '../../fixtures/signed-in.ts'

import { acceptUploads, addBrowserTask, addLongChat, hideDevIndicator } from './site.ts'

// What every page of the cabinet owes (docs/plan/38-site-page-plan.md, assumption «л»): the rules
// of axe, the dark scheme and a pressing area of 44px.

// No motion: axe reads the colours, and a sheet that is still sliding in has not its own yet.
test.use({ reducedMotion: 'reduce' })

const violations = async (page: Page) => {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return report.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  )
}

/** The relative luminance of the page's background, 0 for black and 1 for white. */
const backgroundLuminance = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2d context')
    // The canvas resolves whatever notation the theme's variable holds.
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  })

/** Heights of the visible links and buttons inside `scope` that are lower than 44px. */
async function lowTargets(scope: Locator, selector = 'a, button'): Promise<string[]> {
  const low: string[] = []
  const targets = scope.locator(selector)
  await expect(targets.filter({ visible: true }).first()).toBeVisible()
  for (const target of await targets.all()) {
    if (!(await target.isVisible())) continue
    const box = await target.boundingBox()
    // A button of one icon has no text, only a name.
    const label =
      (await target.innerText()).trim() || ((await target.getAttribute('aria-label')) ?? '')
    if (!box) low.push(`${label}: no box`)
    else if (box.height < 44) low.push(`${label}: ${box.height}px`)
  }
  return low
}

// «Чаты»: the rail of the cabinet, the list and a new chat, in a browser on both schemes.
for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    test(`the ${scheme} scheme at ${width}px: «Чаты»`, async ({ page, context, signedInUser }) => {
      void signedInUser
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await hideDevIndicator(page)
      await page.setViewportSize({ width, height })
      // The heading of a new chat is its greeting (docs/plan/66-chat-visuals.md): it changes with
      // the hour and the phrase, so only its level and that it says something are checked.
      for (const [path, step, heading] of [
        ['/chats', 'Чаты', /^Чаты$/],
        ['/chats/new', 'Новый чат', /\S/],
      ] as const) {
        await test.step(step, async () => {
          await page.goto(path)
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
          const luminance = await backgroundLuminance(page)
          if (scheme === 'dark') expect(luminance).toBeLessThan(0.2)
          else expect(luminance).toBeGreaterThan(0.8)
          expect(await violations(page)).toEqual([])
          expect(await lowTargets(page.getByRole('main'))).toEqual([])
        })
      }
    })
  }
}

// The same rules on what a user with chats sees: rows with their project, folders open and closed,
// the menu of the way the list is shown, the choice of a project and its locked pill.
for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [390, 844],
    [1280, 900],
  ] as const) {
    test(`the ${scheme} scheme at ${width}px: the chats of a user`, async ({
      page,
      context,
      signedInUser,
    }) => {
      test.slow()
      // A chat that waits for the client, and another one: no projects since plan 83.
      const asked = await addBrowserTask(signedInUser.id)
      await addLongChat(signedInUser.id, 1)
      await context.addCookies([{ name: 'theme', value: scheme, url: baseURL }])
      await hideDevIndicator(page)
      await acceptUploads(page)
      await page.setViewportSize({ width, height })
      const list = page.getByRole('navigation', { name: 'Чаты' })
      const expectClean = async () => {
        expect(await violations(page)).toEqual([])
        expect(await lowTargets(list)).toEqual([])
      }

      await test.step('one list, the rows without a project', async () => {
        await page.goto('/chats')
        const row = list.getByRole('link', { name: new RegExp(asked.title) })
        await expect(row).toBeVisible()
        await expect(row).not.toContainText('·')
        await expectClean()
      })
    })
  }
}
