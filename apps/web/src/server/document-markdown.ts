import 'server-only'

import { attachmentDisposition } from './task-file'

// «Скачать .md» of a document the agent wrote (docs/plan/69-pages.md, Ст12): the Markdown of its
// current version, the same the version and the reading page are made of, for a member of its
// workspace. An attachment of plain text: never opened, sniffed or framed.

export interface DocumentMarkdownDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** cabinetDocMarkdown of @repo/trpc: null — another workspace, no such document or no version. */
  read: (input: {
    userId: string
    documentId: string
  }) => Promise<{ name: string; markdown: string } | null>
  onFailure?: (operation: string, error: unknown) => void
}

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

export async function getDocumentMarkdown(
  request: Request,
  params: { docId: string },
  deps: DocumentMarkdownDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы скачать документ.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.docId))
      return answer(404, 'Документ не найден.')
    const document = await deps.read({ userId: session.user.id, documentId: params.docId })
    if (!document) return answer(404, 'Документ не найден или ещё пишется.')
    const bytes = new TextEncoder().encode(document.markdown)
    return new Response(bytes, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': String(bytes.byteLength),
        'content-disposition': attachmentDisposition(document.name),
        // A new version takes the same address: never kept.
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('document markdown read failed', error)
    return answer(503, 'Не удалось скачать документ.')
  }
}
