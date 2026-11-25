import 'server-only'

import { attachmentDisposition } from './task-file'

// «Скачать» of an artifact (docs/plan/88-artifacts.md, §7.13): the PDF or PPTX of slides, the PNG of
// a picture core built for the person who asked, while they may still open the artifact. An
// attachment of its own type, never sniffed or framed.

export interface ArtifactExportDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The file, or null: readArtifactExport of @repo/trpc. */
  read: (input: {
    userId: string
    exportId: string
  }) => Promise<{ name: string; bytes: Uint8Array; contentType: string } | null>
  onFailure?: (operation: string, error: unknown) => void
}

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

export async function getArtifactExport(
  request: Request,
  exportId: string,
  deps: ArtifactExportDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы скачать файл.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    const file = await deps.read({ userId: session.user.id, exportId })
    if (!file) return answer(404, 'Файл не найден.')
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.bytes.byteLength),
        'content-disposition': attachmentDisposition(file.name),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('artifact export read failed', error)
    return answer(503, 'Не удалось скачать файл.')
  }
}
