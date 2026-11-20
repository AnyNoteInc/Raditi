import { artifactEditFrame } from '@/server/artifact-frame'
import { artifactFrameDependencies } from '@/server/artifact-frame-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The edit frame of a mockup (docs/plan/88-artifacts.md, Ар9): no script runs in it, ever. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  return artifactEditFrame(request, (await params).token, artifactFrameDependencies)
}
