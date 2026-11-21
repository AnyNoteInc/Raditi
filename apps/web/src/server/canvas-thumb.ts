import 'server-only'

// A thumbnail of a screen of a canvas (docs/plan/88-artifacts.md, §7.7, slice 88.15): a JPEG the
// renderer of the browser worker drew, for a person who may open the canvas now. Its address names
// the revisions it was drawn of, but the viewer's access may change between requests.

export interface CanvasThumbDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** The bytes, or null: canvasThumbFile of @repo/trpc. */
  read: (input: { userId: string; artifactId: string; file: string }) => Promise<Uint8Array | null>
  onFailure?: (operation: string, error: unknown) => void
}

const empty = (status: number) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export async function getCanvasThumb(
  request: Request,
  input: { artifactId: string; file: string },
  deps: CanvasThumbDependencies,
): Promise<Response> {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(input.artifactId)) return empty(404)
    const session = await deps.getSession(request.headers)
    if (!session) return empty(401)
    if (!(await deps.hasRequiredConsents(request.headers))) return empty(428)
    const bytes = await deps.read({
      userId: session.user.id,
      artifactId: input.artifactId.toLowerCase(),
      file: input.file,
    })
    if (!bytes) return empty(404)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  } catch (error) {
    deps.onFailure?.('canvas thumbnail read failed', error)
    return empty(503)
  }
}
