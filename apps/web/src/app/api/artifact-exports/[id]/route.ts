import { getArtifactExport } from '@/server/artifact-export'
import { artifactExportDependencies } from '@/server/task-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Скачать» of an artifact: the PDF, PPTX or PNG core built for this person. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return getArtifactExport(request, (await params).id, artifactExportDependencies)
}
