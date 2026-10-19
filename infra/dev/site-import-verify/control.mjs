// What a browser scenario asks of the stand while it runs: start core once the wizard has left a
// project waiting, or give the spare hosting another host key. A loopback HTTP server of the
// stand process with a random bearer token that only the 0600 file of the run names.
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const sameToken = (given, token) => {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(`Bearer ${token}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * `actions`: path → async () => JSON-able result. Only POST, only with the token; one action at a
 * time, so two tests never interleave changes of one server. Resolves to `{ url, close }`.
 */
export async function startControl({ token, actions, log = () => {} }) {
  let queue = Promise.resolve()
  const server = createServer((request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST' || !sameToken(request.headers.authorization, token))
      return reply(403, { ok: false })
    const action = Object.hasOwn(actions, request.url) ? actions[request.url] : null
    if (!action) return reply(404, { ok: false })
    request.resume()
    queue = queue.then(async () => {
      try {
        const result = await action()
        log(`control ${request.url}: done`)
        reply(200, { ok: true, result: result ?? null })
      } catch (error) {
        log(`control ${request.url}: failed`)
        reply(500, { ok: false, error: error instanceof Error ? error.message : 'failed' })
      }
    })
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  }
}
