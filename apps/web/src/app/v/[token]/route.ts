import { getPageView } from '@/server/page-response'
import { pageViewDependencies } from '@/server/page-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A page the agent made, in the frame of a member of its chat (docs/plan/67-agent-documents.md,
 * Д3): only on the domain of pages, by a token of five minutes.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  return getPageView(request, (await params).token, pageViewDependencies)
}
