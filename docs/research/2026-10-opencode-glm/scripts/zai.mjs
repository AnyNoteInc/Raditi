// Probe helper for the Z.ai API. The plan key is read from a file and never printed:
//   PROBE_KEY_FILE  absolute path of a file with the key on one line, mode 0600, outside any git checkout;
//   PROBE_OUT       absolute path of a directory outside any git checkout: the raw records go there.
// Every exchange is written without Authorization and cookies, key occurrences replaced, mode 0600. A raw
// record still names the provider's requests: it gets into the repository only through
// infra/dev/llm-verify/sanitize-samples.mjs.
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  chmodSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** An absolute path that is not inside a git checkout (its existing part is resolved first). */
function outsideCheckouts(path, name) {
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`)
  let dir = path
  while (!existsSync(dir)) dir = dirname(dir)
  for (dir = realpathSync(dir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) throw new Error(`${name} must be outside a git checkout`)
    if (dirname(dir) === dir) return path
  }
}

export const HERE = dirname(fileURLToPath(import.meta.url))
export const OUT = outsideCheckouts(process.env.PROBE_OUT, 'PROBE_OUT')
export const SAMPLES = join(OUT, 'samples')
export const BASE = 'https://api.z.ai/api/v1'
mkdirSync(SAMPLES, { recursive: true, mode: 0o700 })

const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
])

let planKey
export function realKey() {
  if (planKey) return planKey
  const file = outsideCheckouts(process.env.PROBE_KEY_FILE, 'PROBE_KEY_FILE')
  const stat = statSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('PROBE_KEY_FILE must be a regular file with mode 0600')
  const key = readFileSync(file, 'utf8').trim()
  if (!key || /\s/.test(key)) throw new Error('PROBE_KEY_FILE must hold the key on one line')
  planKey = key
  return planKey
}
/** The key when a key file is set, null otherwise: probes with an invalid key or without one need none. */
function keyOrNull() {
  return process.env.PROBE_KEY_FILE ? realKey() : null
}

export function scrub(text) {
  if (typeof text !== 'string') return text
  const key = keyOrNull()
  let out = text
  if (key) {
    out = out.split(key).join('<PLAN_KEY>')
    // Also catch partial echoes (providers sometimes echo a masked or split key).
    for (const part of key.split('.'))
      if (part.length >= 8) out = out.split(part).join('<PLAN_KEY_PART>')
  }
  return out
}

export function scrubHeaders(headers) {
  const out = {}
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers)
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (lower === 'set-cookie') {
      // Keep the cookie names and attributes (the gateway must know what to strip), never the values.
      out[lower] = String(value)
        .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
        .map((cookie) => cookie.trim().replace(/^([^=;]+)=[^;]*/, '$1=<removed>'))
        .join(', ')
    } else out[lower] = SECRET_HEADERS.has(lower) ? '<removed>' : scrub(String(value))
  }
  return out
}

export function writeSample(name, record) {
  const file = join(SAMPLES, name)
  writeFileSync(file, scrub(JSON.stringify(record, null, 2)) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

/**
 * One call. `auth`: 'real' | 'invalid' | 'none'. `rawBody` sends the string untouched (malformed bodies).
 * Returns { status, headers, text, json, events } where events are parsed SSE frames when the reply is a stream.
 */
export async function call(
  name,
  { method = 'POST', path, body, rawBody, auth = 'real', headers = {}, timeoutMs = 120_000 },
) {
  const requestHeaders = { accept: 'application/json', ...headers }
  if (method !== 'GET')
    requestHeaders['content-type'] = requestHeaders['content-type'] ?? 'application/json'
  if (auth === 'real') requestHeaders.authorization = `Bearer ${realKey()}`
  else if (auth === 'invalid') requestHeaders.authorization = 'Bearer invalid-key'
  const payload =
    rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined
  const started = Date.now()
  let response
  let text = ''
  let failure
  const frames = []
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream') && response.body) {
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        const piece = decoder.decode(chunk, { stream: true })
        frames.push({ atMs: Date.now() - started, bytes: chunk.length })
        text += piece
      }
      text += decoder.decode()
    } else {
      text = await response.text()
    }
  } catch (error) {
    failure = `${error?.name}: ${error?.message}${error?.cause ? ` (${error.cause.code ?? error.cause.message})` : ''}`
  }
  const elapsedMs = Date.now() - started
  const contentType = response?.headers.get('content-type') ?? ''
  let json
  if (contentType.includes('json')) {
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
  } else {
    try {
      json = JSON.parse(text)
    } catch {
      /* not JSON */
    }
  }
  const events = contentType.includes('text/event-stream') ? parseSse(text) : undefined
  const record = {
    name,
    request: {
      method,
      url: `${BASE}${path}`,
      auth,
      headers: scrubHeaders(requestHeaders),
      body: rawBody !== undefined ? { raw: rawBody } : body,
    },
    response: response
      ? {
          status: response.status,
          statusText: response.statusText,
          headers: scrubHeaders(response.headers),
          elapsedMs,
          chunks: frames.length || undefined,
          body: events ? undefined : (json ?? text),
          sse: events ? text : undefined,
        }
      : { failure, elapsedMs },
  }
  const file = writeSample(`${name}.json`, record)
  return {
    status: response?.status,
    headers: response ? scrubHeaders(response.headers) : {},
    text: scrub(text),
    json,
    events,
    failure,
    elapsedMs,
    file,
  }
}

export function parseSse(text) {
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let event
    const data = []
    const other = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else other.push(line)
    }
    const raw = data.join('\n')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* [DONE] or text */
    }
    events.push({ event, raw, json: parsed, other: other.length ? other : undefined })
  }
  return events
}

/** Compact one-line summary of an SSE stream: the ordered event types with counts of repeats. */
export function eventOrder(events) {
  const out = []
  for (const item of events) {
    const type =
      item.event ??
      item.json?.type ??
      (item.raw === '[DONE]' ? '[DONE]' : (item.json?.object ?? '?'))
    const last = out[out.length - 1]
    if (last && last.type === type) last.count += 1
    else out.push({ type, count: 1 })
  }
  return out
    .map((entry) => (entry.count > 1 ? `${entry.type} x${entry.count}` : entry.type))
    .join(' -> ')
}

export function show(label, value, limit = 1800) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  console.log(
    `--- ${label}\n${scrub(text).slice(0, limit)}${text.length > limit ? `\n… (${text.length} chars)` : ''}`,
  )
}

export function interestingHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (/rate|limit|request|trace|retry|content-type|x-|server|via|cf-|date|log/i.test(name))
      out[name] = value
  }
  return out
}

/** Prints only yes/no: do the samples contain the first 8 characters of the key, or an Authorization value. */
export function leakCheck(dir = SAMPLES, only) {
  const key = keyOrNull()
  if (!key) return 'no-key-file'
  const head = key.slice(0, 8)
  const tail = key.slice(-8)
  let leaked = false
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (only) {
        if (entry.name !== only || entry.isDirectory()) continue
      }
      if (entry.isDirectory()) walk(file)
      else {
        const content = readFileSync(file, 'utf8')
        if (content.includes(head) || content.includes(tail)) leaked = true
        if (/bearer\s+(?!invalid-key|<|dummy|raditi-glm-dummy)[A-Za-z0-9._-]{12,}/i.test(content))
          leaked = true
      }
    }
  }
  walk(dir)
  return leaked ? 'yes' : 'no'
}
