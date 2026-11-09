import { getTaskFile } from '@/server/task-file'
import { taskFileDependencies } from '@/server/task-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Скачать» of a file the agent made for the client in the chat (`feed.file`). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string; fileId: string }> },
): Promise<Response> {
  return getTaskFile(request, await params, taskFileDependencies)
}
