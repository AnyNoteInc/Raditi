// Which Z.ai endpoints does the key of the GLM Coding Plan open for glm-5.3? Synthetic one-line prompts only.
import { realKey, scrub, scrubHeaders, writeSample } from './zai.mjs'

const user = 'Reply with the single word: ok'
const cases = [
  [
    '20-coding-chat',
    'https://api.z.ai/api/coding/paas/v4/chat/completions',
    'bearer',
    {
      model: 'glm-5.3',
      messages: [{ role: 'user', content: user }],
      max_tokens: 256,
      stream: false,
    },
  ],
  [
    '21-paas-chat',
    'https://api.z.ai/api/paas/v4/chat/completions',
    'bearer',
    {
      model: 'glm-5.3',
      messages: [{ role: 'user', content: user }],
      max_tokens: 256,
      stream: false,
    },
  ],
  [
    '22-anthropic-messages',
    'https://api.z.ai/api/anthropic/v1/messages',
    'x-api-key',
    { model: 'glm-5.3', max_tokens: 256, messages: [{ role: 'user', content: user }] },
  ],
  [
    '23-coding-chat-stream',
    'https://api.z.ai/api/coding/paas/v4/chat/completions',
    'bearer',
    {
      model: 'glm-5.3',
      messages: [{ role: 'user', content: user }],
      max_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
    },
  ],
  ['24-coding-models', 'https://api.z.ai/api/coding/paas/v4/models', 'bearer', undefined],
]
for (const [name, url, scheme, body] of cases) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (scheme === 'bearer') headers.authorization = `Bearer ${realKey()}`
  else {
    headers['x-api-key'] = realKey()
    headers['anthropic-version'] = '2023-06-01'
  }
  const started = Date.now()
  let status,
    text = '',
    type = '',
    failure
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    })
    status = response.status
    type = response.headers.get('content-type') ?? ''
    text = await response.text()
    writeSample(`${name}.json`, {
      name,
      request: { url, headers: scrubHeaders(headers), body },
      response: {
        status,
        headers: scrubHeaders(response.headers),
        elapsedMs: Date.now() - started,
        body: text.slice(0, 20000),
      },
    })
  } catch (error) {
    failure = `${error?.name}: ${error?.message}`
  }
  console.log(
    `${name}: ${failure ?? `HTTP ${status} ${type.split(';')[0]}`} in ${Date.now() - started} ms`,
  )
  console.log('   ' + scrub(text).replace(/\s+/g, ' ').slice(0, 420))
}
