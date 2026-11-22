import {
  agentEventSchema,
  agentOutputLimits,
  nativeSessionIdSchema,
  turnResultSchema,
  type AgentEvent,
} from '@repo/domain'

/** Bound parsing work before JSON.parse; stdout is controlled by the sandbox. */
export const MAX_JSONL_BYTES = 256 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 10_000
export const MAX_EVENTS_PER_LINE = 500

export type JsonObject = Record<string, unknown>

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

/** Unknown, malformed, excessively nested and oversized lines are ignored, without logging them. */
export function parseJsonObject(line: string): JsonObject | undefined {
  if (line.length > MAX_JSONL_BYTES || Buffer.byteLength(line, 'utf8') > MAX_JSONL_BYTES) return
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  const root = object(parsed)
  if (!root) return
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const entry = pending.pop()!
    if (++nodes > MAX_JSON_NODES || entry.depth > MAX_JSON_DEPTH) return
    if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) return
    if (entry.value === null || typeof entry.value !== 'object') continue
    for (const [key, value] of Object.entries(entry.value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return
      if (pending.length + nodes >= MAX_JSON_NODES) return
      pending.push({ value, depth: entry.depth + 1 })
    }
  }
  return root
}

/**
 * Text of the CLI as the journal can store it. jsonb refuses U+0000 and half of a surrogate pair,
 * and a refused row costs the turn, however little the text matters.
 */
const storable = (value: string): string => value.replaceAll('\u0000', '').toWellFormed()

/** The first `max` units of a well-formed text, never between the two halves of a pair. */
function cut(value: string, max: number): string {
  const last = value.charCodeAt(max - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

export const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? cut(storable(value), max) : undefined

export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** Session identifiers are also used in literal snapshot paths; never truncate them. */
export function nativeSessionId(value: unknown): string | undefined {
  const parsed = nativeSessionIdSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** All normalized output crosses the shared zod boundary, including derived token counts. */
export function events(...values: unknown[]): AgentEvent[] {
  return values.slice(0, MAX_EVENTS_PER_LINE).flatMap((value) => {
    const parsed = agentEventSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

const TRUNCATED_MESSAGE_MARKER = '\n[Вывод обрезан]'

function clipped(value: string): string {
  const whole = storable(value)
  return whole.length > agentOutputLimits.messageText
    ? cut(whole, agentOutputLimits.messageText - TRUNCATED_MESSAGE_MARKER.length) +
        TRUNCATED_MESSAGE_MARKER
    : whole
}

export function message(value: unknown): AgentEvent[] {
  if (typeof value !== 'string') return []
  // Keep the last message even when it is too long. Silently dropping it could reuse an older
  // result; silently clipping it could remove an invalid JSON suffix and manufacture success.
  // A literal newline plus unquoted marker makes every truncated candidate invalid JSON.
  return events({ type: 'message', text: clipped(value) })
}

/** Clipped as a message is, with the same mark; nothing reads a result from it. */
export function reasoning(value: unknown): AgentEvent[] {
  if (typeof value !== 'string') return []
  const thought = clipped(value)
  return thought.trim() === '' ? [] : events({ type: 'reasoning', text: thought })
}

const FAILURE_FALLBACK = 'Агент не смог завершить действие.'

/** A recognized terminal error always fails the turn, even without a usable reason. */
export function failed(value?: unknown): AgentEvent[] {
  return events({
    type: 'failed',
    reason: text(value, agentOutputLimits.failureReason) || FAILURE_FALLBACK,
  })
}

const CONTROL_ESCAPES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/**
 * A model writing a multi-line client_message by hand tends to put real line breaks inside the
 * JSON string instead of `\n`, which JSON.parse refuses (task 01a204e8, 22.11.2026). Only control
 * characters inside string literals are escaped — the text they stand for is what the model meant,
 * and whitespace between tokens stays as it is. Nothing else is repaired: the object still has to
 * parse and pass the schema as a whole.
 */
export function escapeControlsInStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (escaped) {
      escaped = false
      out += char
      continue
    }
    if (char === '\\') escaped = true
    else if (char === '"') inString = false
    else if (char < ' ') {
      out += CONTROL_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  return out
}

/** Only the current final message is eligible; never recover an older successful result. */
export function extractJsonResult(
  source: readonly AgentEvent[],
  lastMessage: string | null,
): unknown {
  if (source.some((event) => event.type === 'failed')) return null
  const candidate = lastMessage ?? source.findLast((event) => event.type === 'message')?.text
  if (candidate === undefined || candidate.length > MAX_JSONL_BYTES) return null
  const trimmed = candidate.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  const raw = parseJsonObject(body) ?? parseJsonObject(escapeControlsInStrings(body))
  if (!raw) return null
  const result = turnResultSchema.safeParse(raw)
  return result.success ? result.data : null
}
