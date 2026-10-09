import { readFileSync } from 'node:fs'

/**
 * Recorded exchanges of the probe (docs/research/2026-10-opencode-glm/samples), copied here by
 * `infra/dev/llm-verify/sanitize-samples.mjs copy` and formatted. Never edited by hand.
 */
export interface RecordedExchange {
  request: { url?: string; body?: unknown }
  response: {
    status: number
    headers: Record<string, string>
    removedHeaderNames: string[]
    body?: unknown
    sse?: string
  }
}

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

export const sample = (name: string): RecordedExchange => JSON.parse(read(name)) as RecordedExchange
export const sampleText = read

export const chatSamples = {
  /** The main loop: ten tools, reasoning, two tool calls in one answer, a cached prompt. */
  twoToolCalls: '31-run-a-default/01-llm-post_chat_completions.json',
  /** An auxiliary request of the CLI (the session title): no tools, reasoning and text. */
  withoutTools: '31-run-a-default/02-llm-post_chat_completions.json',
  /** A resumed history and one call of a platform MCP tool. */
  mcpToolCall: '34-run-c-mcp/12-llm-post_chat_completions.json',
  /** Plain text: nothing cached, no reasoning, `reasoning_effort` in the request. */
  plainText: '43-variant-low/01-llm-post_chat_completions.json',
} as const

/** Six answers of one active window, then «not started» and «just started» after an idle night. */
export const quotaSamples = [
  '46-quota-limit-raw.json',
  '46-quota-limit-bearer.json',
  '46-quota-limit-after-27.json',
  '46-quota-limit-recheck.json',
  '46-quota-limit-after-29.json',
  '46-quota-limit-final.json',
  '60-quota-idle-before.json',
  '62-quota-idle-after.json',
] as const

export const errorSamples = {
  invalidKey: '54-coding-err-invalid-key-stream.json',
  invalidKeyPlain: '54-coding-err-invalid-key-plain.json',
  noKey: '54-coding-err-no-key-stream.json',
  unknownModel: '54-coding-err-unknown-model-stream.json',
  badParameter: '54-coding-err-bad-param-stream.json',
  noResourcePackage: '21-paas-chat.json',
} as const

/** HTTP 200 with `{code, msg, success: false}`: how the monitor paths answer an error. */
export const envelopeSamples = {
  invalidKey: '10-err-invalid-key.json',
  noKey: '10b-err-no-key.json',
  unknownPath: '14-err-unknown-path.json',
} as const

/** The body of a recorded answer as the JSON a classifier gets. */
export function errorBody(name: string): unknown {
  const body = sample(name).response.body
  return typeof body === 'string' ? JSON.parse(body) : body
}
