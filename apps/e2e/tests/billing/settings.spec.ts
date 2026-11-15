import { expect, test } from '../../fixtures/signed-in.ts'

// The settings shell in a real browser, for a user the fixture has signed in.

test('an anonymous visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto('/settings')
  await expect(page).toHaveURL('/sign-in?next=%2Fsettings')
})
