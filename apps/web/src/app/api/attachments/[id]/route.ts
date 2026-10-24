import { uploadAttachment } from '@/server/attachment-upload'
import { attachmentUploadDependencies } from '@/server/attachment-upload-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The bytes of a file announced by `attachment.start` (docs/plan/57-browser-tasks.md, Б26). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return uploadAttachment(request, await params, attachmentUploadDependencies)
}
