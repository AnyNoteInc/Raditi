// Step 8 of G1 of the pivot plan: what the quota endpoint says when the 5-hour window has ended and no new
// request has started one, and right after the first request. Three calls, one credit. Synthetic prompt.
import { realKey, scrub, scrubHeaders, writeSample } from './zai.mjs'

const quotaUrl = 'https://api.z.ai/api/monitor/usage/quota/limit'
const chatUrl = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const stamp = new Date().toISOString()

async function quota(name) {
  const headers = { accept: 'application/json', authorization: `Bearer ${realKey()}` }
  const response = await fetch(quotaUrl, { headers, signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 2000) }
  }
  writeSample(`${name}.json`, {
    name,
    at: new Date().toISOString(),
    request: { url: quotaUrl, headers: scrubHeaders(headers) },
    response: { status: response.status, headers: scrubHeaders(response.headers), body },
  })
  const limits = body?.data?.limits ?? []
  console.log(
    `${name}: HTTP ${response.status}, level ${body?.data?.level}; ` +
      limits
        .map(
          (l) =>
            `unit ${l.unit}x${l.number}: usage ${l.usage}, current ${l.currentValue}, remaining ${l.remaining}, pct ${l.percentage}, nextReset ${l.nextResetTime === undefined ? 'absent' : l.nextResetTime === null ? 'null' : new Date(l.nextResetTime).toISOString()}`,
        )
        .join(' | '),
  )
}

console.log(`now ${stamp}`)
await quota('60-quota-idle-before')
const body = {
  model: 'glm-5.3',
  messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  max_tokens: 64,
  stream: false,
}
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  authorization: `Bearer ${realKey()}`,
}
const response = await fetch(chatUrl, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(90_000),
})
const text = await response.text()
writeSample('61-chat-first-after-idle.json', {
  name: '61-chat-first-after-idle',
  at: new Date().toISOString(),
  request: { url: chatUrl, headers: scrubHeaders(headers), body },
  response: {
    status: response.status,
    headers: scrubHeaders(response.headers),
    body: scrub(text).slice(0, 4000),
  },
})
let usage
try {
  usage = JSON.parse(text).usage
} catch {
  /* not JSON */
}
console.log(`61-chat-first-after-idle: HTTP ${response.status}, usage ${JSON.stringify(usage)}`)
await quota('62-quota-idle-after')
