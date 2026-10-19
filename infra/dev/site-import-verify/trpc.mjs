// The stand's own calls of the cabinet's tRPC API (apps/web/src/app/api/trpc), as the browser
// makes them but one at a time: POST for a mutation, GET for a query, superjson's envelope
// (`{ json }`) on both sides. Inputs carry no Date, so plain JSON is that envelope.

/** A refusal of a procedure: the tRPC code, the domain code and the message the server sent. */
export class TrpcError extends Error {
  constructor(path, status, error) {
    super(`${path}: ${error?.data?.domainCode ?? error?.data?.code ?? `HTTP ${status}`}`)
    this.name = 'TrpcError'
    this.status = status
    this.code = error?.data?.code ?? null
    this.domainCode = error?.data?.domainCode ?? null
    this.serverMessage = typeof error?.message === 'string' ? error.message : null
  }
}

/** The body of a call; superjson's `meta` is dropped: the stand reads dates as strings. */
export function trpcBody(input) {
  return JSON.stringify({ json: input })
}

/** What a tRPC answer holds, or the refusal it is. */
export function trpcResult(path, status, body) {
  if (body?.error) throw new TrpcError(path, status, body.error.json ?? body.error)
  if (status !== 200 || body?.result?.data === undefined) throw new TrpcError(path, status, null)
  return body.result.data.json
}

/** A client of one session: `cookie` is the Cookie header of the signed-in user. */
export function trpcClient({ origin, cookie, signal, timeoutMs = 120_000 }) {
  const send = async (path, init) => {
    if (!/^[a-zA-Z]+\.[a-zA-Z]+$/.test(path)) throw new Error('Invalid procedure')
    const response = await fetch(`${origin}/api/trpc/${path}${init.query ?? ''}`, {
      method: init.method,
      headers: {
        cookie,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(timeoutMs),
      ]),
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      // A body that is not JSON is a failure of its own: reported by status.
    }
    return trpcResult(path, response.status, body)
  }
  return {
    mutation: (path, input) => send(path, { method: 'POST', body: trpcBody(input) }),
    query: (path, input) =>
      send(path, { method: 'GET', query: `?input=${encodeURIComponent(trpcBody(input))}` }),
  }
}
