import { getSiteFavicon } from '@/server/site-favicon'
import { siteFaviconDependencies } from '@/server/site-favicon-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The icon of a site for the tile of its rail: /favicon.ico of the site, through the server. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  return getSiteFavicon(request, await params, siteFaviconDependencies)
}
