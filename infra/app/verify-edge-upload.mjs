// The upload helper of verify-edge.mjs, kept apart from the stand so that its pacing has a test.
import https from 'node:https'

const PIECE = 64 * 1024
// The pause after each piece, one per attempt. A server that refuses a body answers and closes
// while the rest is still on its way; a piece written after that close is answered with a reset,
// and the reset takes the unread answer with it. The pause lets the answer be read first.
const PAUSES_MS = [2, 20, 100]

/**
 * A POST to the edge whose body goes out in pieces, as a browser uploads. The edge or web may
 * answer before the body is over: the rest is then not sent, and a connection the server closes
 * afterwards is not an error. An answer lost to such a close is asked for again, more slowly
 * each time. `request` is replaced only by tests.
 */
export async function upload(
  url,
  { host, port, ca, headers = {}, body, chunked = false, request = https.request },
) {
  const target = new URL(url)
  const once = (pauseMs) =>
    new Promise((resolve, reject) => {
      let answered = false
      let sent = 0
      const req = request(
        {
          host,
          port,
          path: target.pathname,
          method: 'POST',
          headers: {
            host: target.host,
            ...(chunked ? {} : { 'content-length': body.length }),
            ...headers,
          },
          servername: target.hostname,
          ca,
          agent: false,
          timeout: 30_000,
        },
        (response) => {
          answered = true
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          )
          response.on('error', reject)
        },
      )
      req.once('timeout', () => req.destroy(new Error('request timed out')))
      req.on('error', (error) => {
        if (!answered) reject(error)
      })
      const pump = () => {
        if (answered || req.destroyed) return
        if (sent >= body.length) return req.end()
        const piece = body.subarray(sent, sent + PIECE)
        sent += piece.length
        const next = () => setTimeout(pump, pauseMs)
        if (req.write(piece)) next()
        else req.once('drain', next)
      }
      pump()
    })
  let last
  for (const pauseMs of PAUSES_MS) {
    try {
      return await once(pauseMs)
    } catch (error) {
      last = error
    }
  }
  throw last
}
