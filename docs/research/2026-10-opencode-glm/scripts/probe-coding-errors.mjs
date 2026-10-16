// Error shapes of the coding chat-completions endpoint (the form OpenCode uses). Synthetic one-line prompts.
import { realKey, scrub, scrubHeaders, writeSample } from './zai.mjs'
const url = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const message = [{ role: 'user', content: 'Reply with the single word: ok' }]
const cases = [
  [
    '54-coding-err-invalid-key-stream',
    'invalid',
    {
      model: 'glm-5.3',
      messages: message,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    },
  ],
  [
    '54-coding-err-invalid-key-plain',
    'invalid',
    { model: 'glm-5.3', messages: message, stream: false, max_tokens: 64 },
  ],
  [
    '54-coding-err-no-key-stream',
    'none',
    { model: 'glm-5.3', messages: message, stream: true, max_tokens: 64 },
  ],
  [
    '54-coding-err-unknown-model-stream',
    'real',
    {
      model: 'glm-0-does-not-exist',
      messages: message,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    },
  ],
  [
    '54-coding-err-bad-param-stream',
    'real',
    { model: 'glm-5.3', messages: message, stream: true, max_tokens: 99999999 },
  ],
]
for (const [name, auth, body] of cases) {
  const headers = { accept: '*/*', 'content-type': 'application/json' }
  if (auth === 'real') headers.authorization = `Bearer ${realKey()}`
  else if (auth === 'invalid') headers.authorization = 'Bearer invalid-key'
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    writeSample(`${name}.json`, {
      name,
      request: { url, auth, headers: scrubHeaders(headers), body },
      response: {
        status: response.status,
        headers: scrubHeaders(response.headers),
        elapsedMs: Date.now() - started,
        body: text.slice(0, 6000),
      },
    })
    console.log(
      `${name}: HTTP ${response.status} ${response.headers.get('content-type')} retry-after=${response.headers.get('retry-after')} :: ${scrub(text).replace(/\s+/g, ' ').slice(0, 330)}`,
    )
  } catch (error) {
    console.log(`${name}: ${error?.name}: ${error?.message}`)
  }
}
