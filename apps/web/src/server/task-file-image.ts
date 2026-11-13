import 'server-only'

// A picture of a chat a text document shows (docs/plan/67-agent-documents.md, Д5): a member of the
// task's workspace opens it here, on the cabinet's own origin (img-src 'self'). Its type is read
// from its bytes — PNG, JPEG, WebP or GIF — never SVG: anything else is not found.

export interface TaskFileImageDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The picture, or null: readChatImage of @repo/trpc. */
  read: (input: {
    userId: string
    taskId: string
    fileId: string
  }) => Promise<{ type: string; bytes: Uint8Array } | null>
  onFailure?: (operation: string, error: unknown) => void
}

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

export async function getTaskFileImage(
  request: Request,
  params: { taskId: string; fileId: string },
  deps: TaskFileImageDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы посмотреть картинку.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    const image = await deps.read({ userId: session.user.id, ...params })
    if (!image) return answer(404, 'Картинка не найдена.')
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        'content-type': image.type,
        'content-length': String(image.bytes.byteLength),
        'content-disposition': 'inline',
        // The id names one file; its bytes never change.
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('task file image read failed', error)
    return answer(503, 'Не удалось загрузить картинку.')
  }
}
