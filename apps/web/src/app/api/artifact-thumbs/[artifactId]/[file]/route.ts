import { getCanvasThumb } from '@/server/canvas-thumb'
import { canvasThumbDependencies } from '@/server/task-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A thumbnail of a screen of a canvas (docs/plan/88-artifacts.md, §7.7). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string; file: string }> },
): Promise<Response> {
  return getCanvasThumb(request, await params, canvasThumbDependencies)
}
