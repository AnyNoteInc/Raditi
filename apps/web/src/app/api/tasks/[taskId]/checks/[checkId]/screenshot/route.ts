import { getCheckScreenshot } from '@/server/check-screenshot'
import { checkScreenshotDependencies } from '@/server/check-screenshot-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string; checkId: string }> },
): Promise<Response> {
  return getCheckScreenshot(request, await params, checkScreenshotDependencies)
}
