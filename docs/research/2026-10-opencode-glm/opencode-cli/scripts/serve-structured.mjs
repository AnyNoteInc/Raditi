// Starts the headless server, sends one prompt with format json_schema and prints what comes back.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
const base = 'http://127.0.0.1:4096'
const server = spawn(process.env.OC, ['serve', '--port', '4096', '--hostname', '127.0.0.1'], {
  stdio: ['ignore', 'ignore', 'ignore'],
})
const call = async (method, path, body) => {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(240_000),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: response.status, json, text }
}
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(base + '/global/health')).ok) break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const session = await call('POST', '/session', { title: 'stand-structured' })
  console.log('session', session.status, session.json?.id)
  const schema = JSON.parse(readFileSync('/cfg/turn-result.schema.json', 'utf8'))
  delete schema.$schema
  const prompt = await call('POST', `/session/${session.json.id}/message`, {
    agent: 'raditi',
    parts: [{ type: 'text', text: process.argv[2] }],
    format: { type: 'json_schema', schema, retryCount: 1 },
  })
  console.log('prompt', prompt.status)
  const info = prompt.json?.info ?? {}
  console.log(
    'info',
    JSON.stringify({
      finish: info.finish,
      error: info.error,
      tokens: info.tokens,
      structuredKeys: info.structured ? Object.keys(info.structured) : undefined,
    }),
  )
  console.log('structured', JSON.stringify(info.structured))
  console.log(
    'parts',
    JSON.stringify(
      (prompt.json?.parts ?? []).map((part) =>
        part.type === 'tool'
          ? `tool:${part.tool}:${part.state?.status}`
          : part.type === 'text'
            ? `text:${part.text.slice(0, 80)}`
            : part.type,
      ),
    ),
  )
  if (!prompt.json) console.log(prompt.text.slice(0, 500))
} finally {
  server.kill('SIGTERM')
}
