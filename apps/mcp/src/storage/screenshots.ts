import { browserScreenshotEventSchema } from '@repo/db'

/**
 * The ids of the screenshots an event of `BROWSER_SCREENSHOT_EVENT` names; others are not. The
 * browser writes such an event with each screenshot it stores, the content maintenance reads it
 * back to remove the objects of a finished task.
 */
export function screenshotIdOf(payload: unknown): string | null {
  const parsed = browserScreenshotEventSchema.safeParse(payload)
  return parsed.success ? parsed.data.id : null
}
