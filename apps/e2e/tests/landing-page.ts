import { expect, type Locator, type Page } from '@playwright/test'

// What the specs of the landing share: landing.spec.ts and the tool of the style snapshot.

/** Sets the window and opens the landing; what to wait for after that is the business of a test. */
export async function openAt(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.goto('/')
}

/** Waits until React has taken the element over: a key pressed or a value set before that is not heard. */
export function hydrated(element: Locator): Promise<void> {
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

/** Waits until no animation or transition is running: a reveal moves a section from under the
 *  pointer, and a colour read on the way belongs to neither state. */
export function settled(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
    await document.fonts.ready
    // Two quiet passes in a row: an observer may start an animation a frame after the last ended.
    // Frames are counted and the `finished` promises are not awaited: the answer of a closed
    // question has an animation that is never painted and never ends.
    for (let quiet = 0; quiet < 2;) {
      await frame()
      await frame()
      const running = document
        .getAnimations()
        .some((animation) => animation.pending || animation.playState === 'running')
      quiet = running ? 0 : quiet + 1
    }
  })
}

/** The main action of the first screen: the registration. */
export const heroAction = (page: Page) =>
  page.locator('section[aria-labelledby="hero-title"] a[href="/sign-up"]')

/** The registration under the plans. */
export const pricingAction = (page: Page) => page.locator('#pricing a[href="/sign-up"]')

/** The main action of the final block. */
export const finalAction = (page: Page) =>
  page.locator('section[aria-labelledby="start-title"] a[href="/sign-up"]')

/** The button of the mobile menu in the header. */
export const menuToggle = (page: Page) => page.locator('#top > header button[aria-controls]')

/** Applies the prepared change of the demo and waits until its window tells so. */
export async function applyChange(demo: Locator): Promise<void> {
  await demo.getByRole('button', { name: 'Применить правку' }).click()
  await expect(demo.getByText('Изменено')).toBeVisible()
}

/** The name of a keyframes rule or a class as the source writes it: a CSS module adds a hash to it. */
export const plainName = (name: string) => name.split('__').pop()?.replace(/_.*$/, '') ?? ''
