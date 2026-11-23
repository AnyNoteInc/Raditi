// A tiny static server for the skeptic's checks: serves a directory on 127.0.0.1 and a free port.
// Independent of the spike's serve.mjs. `?mycsp=<name>` adds one of the policies below to HTML.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

export const POLICIES = {
  // What M8 would plausibly add: own scripts only, nothing about workers (falls back to script-src).
  scriptOnly: "script-src 'self'; object-src 'none'",
  // The spike's strict policy: workers only from the own origin.
  workerSelf: "script-src 'self'; worker-src 'self'; object-src 'none'",
  // The fix the report proposes for M8.
  workerBlob: "script-src 'self'; worker-src 'self' blob:; object-src 'none'",
}

export function serve(dir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let path = normalize(join(dir, decodeURIComponent(url.pathname)))
    if (!path.startsWith(dir)) return res.writeHead(403).end()
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(dir, 'index.html')
    if (!existsSync(path)) return res.writeHead(404).end()
    const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }
    const policy = POLICIES[url.searchParams.get('mycsp') ?? '']
    if (extname(path) === '.html' && policy) headers['content-security-policy'] = policy
    res.writeHead(200, headers)
    createReadStream(path).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}
