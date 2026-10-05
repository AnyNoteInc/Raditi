// Times each step of the headless server path; the LLM answer is a canned fault, nothing goes upstream.
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
const base = 'http://127.0.0.1:4096'
const t0 = Date.now()
const mark = (label) => console.log(`${String(Date.now() - t0).padStart(7)} ms  ${label}`)
const log = openSync('/tmp/serve.log', 'w')
const server = spawn(
  process.env.OC,
  ['serve', '--port', '4096', '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'INFO'],
  { stdio: ['ignore', log, log] },
)
const call = async (method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(400_000),
  })
  return { status: response.status, text: await response.text() }
}
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + '/global/health')).ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  mark('health ok')
  const session = await call('POST', '/session', { title: 'stand-timing' })
  mark(`session created ${session.status}`)
  const id = JSON.parse(session.text).id
  const prompt = await call('POST', `/session/${id}/message`, {
    agent: 'raditi',
    parts: [{ type: 'text', text: 'Reply with the single word: ok' }],
  })
  mark(`prompt answered ${prompt.status} ${prompt.text.slice(0, 200)}`)
} finally {
  server.kill('SIGTERM')
}
