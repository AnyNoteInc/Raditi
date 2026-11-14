import { getTaskFileImage } from '@/server/task-file-image'
import { taskFileImageDependencies } from '@/server/task-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A picture of the chat a text document shows (docs/plan/67-agent-documents.md, Д5). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string; fileId: string }> },
): Promise<Response> {
  return getTaskFileImage(request, await params, taskFileImageDependencies)
}
