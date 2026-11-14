import { getDocumentMarkdown } from '@/server/document-markdown'
import { documentMarkdownDependencies } from '@/server/document-markdown-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** «Скачать .md» of a document the agent wrote (docs/plan/69-pages.md, Ст12). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ docId: string }> },
): Promise<Response> {
  return getDocumentMarkdown(request, await params, documentMarkdownDependencies)
}
