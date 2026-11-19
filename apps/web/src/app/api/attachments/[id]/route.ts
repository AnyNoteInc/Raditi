import { uploadAttachment } from '@/server/attachment-upload'
import { attachmentUploadDependencies } from '@/server/attachment-upload-runtime'
import { cabinetOnly } from '@/server/cabinet-only'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The bytes of a file announced by `attachment.start` (docs/plan/57-browser-tasks.md, Б26). */
export const PUT = cabinetOnly(
  async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
    uploadAttachment(request, await params, attachmentUploadDependencies),
)
