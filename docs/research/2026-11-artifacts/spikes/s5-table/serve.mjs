// A static server for dist/ on 127.0.0.1 and a free port. `?csp=strict` on the page adds the
// policy the cabinet would have with `script-src` and `worker-src` (TODO M8): only its own scripts,
// no workers from blob: URLs.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

export const STRICT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

export function serve(dir = join(import.meta.dirname, 'dist')) {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(url.pathname)
    let path = normalize(join(dir, decodeURIComponent(url.pathname)))
    if (!path.startsWith(dir)) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(dir, 'index.html')
    const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }
    if (path.endsWith('index.html') && url.searchParams.get('csp') === 'strict') headers['content-security-policy'] = STRICT_CSP
    res.writeHead(200, headers)
    createReadStream(path).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ origin: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { origin } = await serve()
  console.log(`Serving dist/ at ${origin}`)
}
