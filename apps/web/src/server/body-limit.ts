// The most a JSON route of the API reads. A sign-in or a profile form is a few hundred bytes and
// a full tRPC batch a few kilobytes; the edge has its own, larger limit (infra/app/traefik).
export const MAX_AUTH_BODY_BYTES = 64 * 1024
export const MAX_TRPC_BODY_BYTES = 256 * 1024

/**
 * The request body, or null once it passes `limit` bytes. A declared oversize body is refused
 * unread; without a usable length (a chunked body) it is read only up to the limit and the rest
 * is cancelled.
 */
export async function readBodyWithin(
  request: Request,
  limit: number,
): Promise<Buffer<ArrayBuffer> | null> {
  if (Number(request.headers.get('content-length')) > limit) return null
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

const refusal = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

/**
 * A route handler that gets its request with the body already in memory and within `limit`;
 * a larger body is answered 413 before the handler runs, a body that breaks off (the client
 * went away) 400. For handlers that read a body whole before any check of their own:
 * better-auth parses it ahead of the captcha, the origin and the session, the fetch adapter of
 * tRPC has no limit at all.
 */
export function withBodyLimit(
  limit: number,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!request.body) return handler(request)
    let body: Buffer<ArrayBuffer> | null
    try {
      body = await readBodyWithin(request, limit)
    } catch {
      return refusal(400, 'Не удалось прочитать запрос. Попробуйте ещё раз.')
    }
    if (body === null) return refusal(413, 'Запрос слишком большой.')
    return handler(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      }),
    )
  }
}
