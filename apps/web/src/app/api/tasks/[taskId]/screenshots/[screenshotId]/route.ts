import { getTaskScreenshot } from '@/server/task-screenshot'
import { taskScreenshotDependencies } from '@/server/task-screenshot-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A snapshot of the task's browser the agent took for the client (`web_screenshot`). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string; screenshotId: string }> },
): Promise<Response> {
  return getTaskScreenshot(request, await params, taskScreenshotDependencies)
}
