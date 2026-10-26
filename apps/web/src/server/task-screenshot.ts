import 'server-only'

// A snapshot the agent took of a task's browser for the client (`web_screenshot`, owner's request
// of 26.10.2026): the dialog shows it, and a member of the task's workspace opens it here. The
// bytes come from the inbox through the server: the browser of the cabinet asks only its own
// origin for images (img-src 'self').

export interface TaskScreenshotDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The JPEG, or null: readTaskScreenshot of @repo/trpc. */
  read: (input: { userId: string; taskId: string; screenshotId: string }) => Promise<Buffer | null>
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

export async function getTaskScreenshot(
  request: Request,
  params: { taskId: string; screenshotId: string },
  deps: TaskScreenshotDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы посмотреть снимок экрана.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    const bytes = await deps.read({ userId: session.user.id, ...params })
    // Someone else's dialog, a snapshot of another task and one that is gone answer the same.
    if (!bytes) return answer(404, 'Снимок экрана не найден.')
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(bytes.byteLength),
        'content-disposition': 'inline; filename="screenshot.jpg"',
        // The id names one snapshot; its bytes never change. The owner's browser keeps a copy.
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('task screenshot read failed', error)
    return answer(503, 'Не удалось загрузить снимок экрана.')
  }
}
