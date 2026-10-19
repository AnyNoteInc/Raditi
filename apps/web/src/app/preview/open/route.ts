import { openPreviewRoute } from '@/server/preview-open'
import { previewOpenDependencies } from '@/server/preview-open-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A ticket into a dialog's preview, then the gateway's entry (docs/plan/53, Р19). */
export function GET(request: Request): Promise<Response> {
  return openPreviewRoute(request, previewOpenDependencies)
}
