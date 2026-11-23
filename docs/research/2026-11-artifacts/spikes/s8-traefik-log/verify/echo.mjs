// Independent backend of the s8 check (not whoami): answers every request with its request line and
// headers as it got them, on 3000 (web) and 8092 (preview). /stream writes forever until the peer
// goes away. It prints nothing per request: a positive control reads its answer, not its log.
import http from 'node:http'

function handler(req, res) {
  if (req.url.startsWith('/stream')) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const timer = setInterval(() => res.write('x'.repeat(4096)), 20)
    res.on('close', () => clearInterval(timer))
    return
  }
  const body = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) body.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${body.join('\n')}\n`)
  })
}
for (const port of [3000, 8092]) http.createServer(handler).listen(port, '0.0.0.0')
process.stdout.write('echo up\n')
