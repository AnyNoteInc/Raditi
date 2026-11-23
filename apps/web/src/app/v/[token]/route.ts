import { artifactOnPages } from '@/server/artifact-frame'
import { artifactFrameDependencies } from '@/server/artifact-frame-runtime'
import { getPageView } from '@/server/page-response'
import { pageViewDependencies } from '@/server/page-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The root of the domain of pages, `/v/<segment>`: a page the agent made, in the frame of a member
 * of its chat (docs/plan/67-agent-documents.md, Д3), by a token of five minutes; the frame of a
 * mockup, a file of an artifact and the fonts of the platform (docs/plan/88-artifacts.md, Ар28).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const token = (await params).token
  return (
    (await artifactOnPages(request, token, artifactFrameDependencies)) ??
    getPageView(request, token, pageViewDependencies)
  )
}
