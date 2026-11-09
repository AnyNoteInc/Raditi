import 'server-only'

// A file the agent made for the client in a chat (docs/plan/66-chat-visuals.md, В8–В10): the
// chat shows it as a row with «Скачать», and a member of the task's workspace downloads it here.
// The browser never opens it: it is an attachment of an opaque type, never sniffed or framed.

export interface TaskFileDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The file, or null: readTaskFile of @repo/trpc. */
  read: (input: {
    userId: string
    taskId: string
    fileId: string
  }) => Promise<{ name: string; bytes: Uint8Array } | null>
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

/**
 * The name for `filename*` (RFC 6266, RFC 8187) and an ASCII fallback for `filename`: whatever is
 * not printable ASCII, a quote or a backslash becomes `_` there.
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

export async function getTaskFile(
  request: Request,
  params: { taskId: string; fileId: string },
  deps: TaskFileDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы скачать файл.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    const file = await deps.read({ userId: session.user.id, ...params })
    // Someone else's chat, a file of another task and one that is gone answer the same.
    if (!file) return answer(404, 'Файл не найден.')
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(file.bytes.byteLength),
        'content-disposition': attachmentDisposition(file.name),
        // The id names one file; its bytes never change. The owner's browser keeps a copy.
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('task file read failed', error)
    return answer(503, 'Не удалось скачать файл.')
  }
}
