import { createSseDecoder } from '@repo/llm-backends'

// One call of core to the gateway of the llm role for a quick edit (docs/plan/98-quick-edits.md,
// БПр6): the route and the platform's identity its backend declares, the key of the edit. The answer
// streams; only the function call, its text and the usage are kept.

export interface QuickCallAnswer {
  toolName: string | null
  toolArguments: string | null
  content: string | null
  finishReason: string | null
}

export type QuickCallFailure =
  { kind: 'refused'; status: number } | { kind: 'timeout' } | { kind: 'broken' }

export class QuickCallError extends Error {
  constructor(readonly failure: QuickCallFailure) {
    super(`quick call failed: ${failure.kind}`)
    this.name = 'QuickCallError'
  }
}

interface Delta {
  content?: string | null
  tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[]
}

export async function callQuickModel(input: {
  gatewayOrigin: string
  /** The gateway route of the key's backend (`LlmBackend.routes`). */
  route: string
  /** `LlmBackend.platformUserAgent` of that backend. */
  userAgent: string
  key: string
  body: Record<string, unknown>
  timeoutMs: number
  fetch?: typeof fetch
}): Promise<QuickCallAnswer> {
  const signal = AbortSignal.timeout(input.timeoutMs)
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(new URL(input.route, input.gatewayOrigin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.key}`,
        'user-agent': input.userAgent,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...input.body, stream: true }),
      signal,
    })
  } catch {
    throw new QuickCallError(signal.aborted ? { kind: 'timeout' } : { kind: 'broken' })
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new QuickCallError({ kind: 'refused', status: response.status })
  }
  let toolName: string | null = null
  let toolArguments: string | null = null
  let content: string | null = null
  let finishReason: string | null = null
  const decoder = createSseDecoder((event) => {
    if (event.data === '[DONE]' || event.data === '') return
    let chunk: { choices?: { delta?: Delta; finish_reason?: string | null }[] }
    try {
      chunk = JSON.parse(event.data) as typeof chunk
    } catch {
      return
    }
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta
    if (typeof delta?.content === 'string') content = (content ?? '') + delta.content
    // The first call only: the request offers one function.
    const call = delta?.tool_calls?.find((each) => (each.index ?? 0) === 0)
    if (call?.function?.name) toolName = call.function.name
    if (typeof call?.function?.arguments === 'string')
      toolArguments = (toolArguments ?? '') + call.function.arguments
  })
  try {
    for await (const chunk of response.body) decoder.push(chunk)
    decoder.end()
  } catch {
    throw new QuickCallError(signal.aborted ? { kind: 'timeout' } : { kind: 'broken' })
  }
  return { toolName, toolArguments, content, finishReason }
}
