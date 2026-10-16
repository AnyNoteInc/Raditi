import type { LlmBackend } from '@repo/domain'

import { createSseDecoder } from './sse.ts'
import {
  addDelta,
  copyResult,
  emptyMeterResult,
  object,
  optionalCount,
  parseEvent,
  setUsage,
  type UsageMeter,
} from './usage.ts'

/**
 * The meter of an OpenAI-style chat completions stream: deltas of content, reasoning and tool
 * arguments, usage from the chunk that carries it, `completed` only after a `finish_reason`.
 * What ends a stream as a failure is the adapter's own rule, so its inspector is injected.
 */
export function createChatCompletionsUsageMeter(
  createInspector: LlmBackend['streamInspector'],
): UsageMeter {
  const result = emptyMeterResult()
  const inspector = createInspector()
  let finished = false
  const readUsage = (
    event: Record<string, unknown>,
    choice: Record<string, unknown> | undefined,
  ) => {
    // Usage may arrive in a separate chunk with choices=[], after finish_reason.
    const rawUsage = event.usage ?? choice?.usage
    if (rawUsage === undefined || rawUsage === null) return
    const usage = object(rawUsage)
    // OpenAI-compatible servers send `null` for details they do not report, as for an
    // absent field. A null counter itself stays invalid.
    const details = usage?.prompt_tokens_details == null ? {} : object(usage.prompt_tokens_details)
    const outputDetails =
      usage?.completion_tokens_details == null ? {} : object(usage.completion_tokens_details)
    setUsage(
      result,
      rawUsage,
      details === undefined || outputDetails === undefined
        ? null
        : {
            input: usage?.prompt_tokens,
            cacheRead: optionalCount(
              usage?.cached_tokens === undefined ? details.cached_tokens : usage.cached_tokens,
            ),
            cacheWrite: 0,
            output: usage?.completion_tokens,
            reasoning: optionalCount(outputDetails.reasoning_tokens),
          },
    )
  }
  const decoder = createSseDecoder(({ event: eventName, data }) => {
    const inspected = inspector.inspect({ event: eventName, data })
    if (inspected.kind === 'invalid') return false
    if (inspected.kind === 'skip') return
    if (inspected.kind === 'failure') {
      result.outcome = 'failed'
      result.signal = inspected.signal.kind === 'transient' ? null : inspected.signal
      // A completion chunk the adapter refuses (its finish_reason) is still the provider's
      // word on what the call consumed; an error event carries no usage to read.
      const refused = data === '[DONE]' ? null : parseEvent(data)
      if (refused !== null && refused.error == null && eventName !== 'error')
        readUsage(refused, object(Array.isArray(refused.choices) ? refused.choices[0] : undefined))
      return false
    }
    if (data === '[DONE]') {
      // A finish_reason is required: DONE alone does not invent a successful model response.
      if (finished) result.outcome = 'completed'
      return false
    }
    const event = parseEvent(data)
    if (event === null) return
    const choice = object(Array.isArray(event.choices) ? event.choices[0] : undefined)
    const delta = object(choice?.delta)
    if (!finished) {
      addDelta(result, delta?.content)
      addDelta(result, delta?.reasoning_content)
      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls)
          addDelta(result, object(object(call)?.function)?.arguments)
      }
    }
    readUsage(event, choice)
    if (!finished && typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
      finished = true
      result.outcome = 'completed'
    }
  })
  return {
    push: (chunk) => decoder.push(chunk),
    end() {
      decoder.end()
      return copyResult(result)
    },
  }
}
