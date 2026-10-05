// What does Z.ai tell about the plan's quota? Read-only GETs to https://api.z.ai only; samples are sanitised.
import { realKey, scrub, scrubHeaders, writeSample } from './zai.mjs'
const pad = (n) => String(n).padStart(2, '0')
const stamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const now = new Date()
const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000)
const range = `?startTime=${encodeURIComponent(stamp(dayAgo))}&endTime=${encodeURIComponent(stamp(now))}`
const cases = [
  ['46-quota-limit-bearer', 'https://api.z.ai/api/monitor/usage/quota/limit', 'bearer'],
  ['46-quota-limit-raw', 'https://api.z.ai/api/monitor/usage/quota/limit', 'raw'],
  ['46-model-usage', `https://api.z.ai/api/monitor/usage/model-usage${range}`, 'auto'],
  ['46-tool-usage', `https://api.z.ai/api/monitor/usage/tool-usage${range}`, 'auto'],
]
let scheme = 'bearer'
for (const [name, url, auth] of cases) {
  const use = auth === 'auto' ? scheme : auth
  const headers = {
    accept: 'application/json',
    'accept-language': 'en-US,en',
    'content-type': 'application/json',
    authorization: use === 'bearer' ? `Bearer ${realKey()}` : realKey(),
  }
  const started = Date.now()
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not JSON */
    }
    const ok =
      response.status === 200 &&
      parsed &&
      parsed.success !== false &&
      parsed.code !== 401 &&
      parsed.code !== 1001
    if (auth !== 'auto' && ok) scheme = use
    writeSample(`${name}.json`, {
      name,
      request: { url, authorizationScheme: use, headers: scrubHeaders(headers) },
      response: {
        status: response.status,
        headers: scrubHeaders(response.headers),
        elapsedMs: Date.now() - started,
        body: parsed ?? text.slice(0, 4000),
      },
    })
    console.log(
      `${name}: HTTP ${response.status} (${use}) ${scrub(text).replace(/\s+/g, ' ').slice(0, 900)}`,
    )
  } catch (error) {
    console.log(`${name}: ${error?.name}: ${error?.message}`)
  }
}
