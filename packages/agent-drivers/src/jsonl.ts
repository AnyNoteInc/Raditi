import {
  agentEventSchema,
  agentOutputLimits,
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

export const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined

export const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

export const optionalCount = (value: unknown): number | undefined =>
  value === undefined ? 0 : count(value)

/** Session identifiers are also used in literal snapshot paths; never truncate them. */
export function nativeSessionId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= agentOutputLimits.nativeSessionId &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
    ? value
    : undefined
}

/** All normalized output crosses the shared zod boundary, including derived token counts. */
export function events(...values: unknown[]): AgentEvent[] {
  return values.slice(0, MAX_EVENTS_PER_LINE).flatMap((value) => {
    const parsed = agentEventSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

const TRUNCATED_MESSAGE_MARKER = '\n[Вывод обрезан]'

export function message(value: unknown): AgentEvent[] {
  if (typeof value !== 'string') return []
  // Keep the last message even when it is too long. Silently dropping it could reuse an older
  // result; silently clipping it could remove an invalid JSON suffix and manufacture success.
  // A literal newline plus unquoted marker makes every truncated candidate invalid JSON.
  const valueText =
    value.length > agentOutputLimits.messageText
      ? value.slice(0, agentOutputLimits.messageText - TRUNCATED_MESSAGE_MARKER.length) +
        TRUNCATED_MESSAGE_MARKER
      : value
  return events({ type: 'message', text: valueText })
}

export function failed(value: unknown): AgentEvent[] {
  const reason = text(value, agentOutputLimits.failureReason)
  return reason === undefined ? [] : events({ type: 'failed', reason })
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
  const raw = parseJsonObject(fenced?.[1] ?? trimmed)
  if (!raw) return null
  const result = turnResultSchema.safeParse(raw)
  return result.success ? result.data : null
}
