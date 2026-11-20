import { uploadArtifactFile } from '@/server/artifact-file'
import { artifactFileDependencies } from '@/server/artifact-file-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The bytes of a picture or a font of an artifact (docs/plan/88-artifacts.md, Ар12). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return uploadArtifactFile(request, await params, artifactFileDependencies)
}
