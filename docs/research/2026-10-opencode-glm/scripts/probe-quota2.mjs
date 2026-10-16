import { realKey, scrubHeaders, writeSample, scrub } from './zai.mjs'
const name = process.argv[2]
const url = 'https://api.z.ai/api/monitor/usage/quota/limit'
const headers = { accept: 'application/json', authorization: `Bearer ${realKey()}` }
const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
const text = await response.text()
let parsed
try {
  parsed = JSON.parse(text)
} catch {
  /* not JSON */
}
writeSample(`${name}.json`, {
  name,
  at: new Date().toISOString(),
  request: { url, headers: scrubHeaders(headers) },
  response: {
    status: response.status,
    headers: scrubHeaders(response.headers),
    body: parsed ?? text.slice(0, 2000),
  },
})
console.log(
  new Date().toISOString(),
  response.status,
  scrub(JSON.stringify(parsed?.data ?? text.slice(0, 300))),
)
console.log('headers', JSON.stringify(scrubHeaders(response.headers)))
