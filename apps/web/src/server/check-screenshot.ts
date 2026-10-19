import 'server-only'

// The screenshot the agent's browser took of the preview, for the «Проверки» tab of a dialog
// (docs/plan/53-chat-preview-release.md, Р21, Р22, N22): the check of a candidate keeps the
// screenshot of the same look, and a member of the dialog's workspace sees it here. The bytes
// come from raditi-artifacts through the server: web has no other way into the bucket, and the
// browser of the cabinet asks only its own origin for images (img-src 'self').

export interface CheckScreenshotDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The PNG of the check, or null: readCheckScreenshot of @repo/trpc. */
  read: (input: { userId: string; taskId: string; checkId: string }) => Promise<Buffer | null>
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

export async function getCheckScreenshot(
  request: Request,
  params: { taskId: string; checkId: string },
  deps: CheckScreenshotDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы посмотреть снимок экрана.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    const bytes = await deps.read({ userId: session.user.id, ...params })
    // Someone else's dialog, a check without a screenshot and one that is gone answer the same.
    if (!bytes) return answer(404, 'Снимок экрана не найден.')
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
        'content-disposition': 'inline; filename="screenshot.png"',
        // The key names one screenshot; its bytes never change. The owner's browser keeps a
        // private copy.
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('check screenshot read failed', error)
    return answer(503, 'Не удалось загрузить снимок экрана.')
  }
}
