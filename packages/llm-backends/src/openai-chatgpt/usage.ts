import { createCodexStreamInspector } from './stream.ts'
import { codexFailureSignal } from './responses.ts'
import { createSseDecoder } from '../sse.ts'
import {
  addDelta,
  copyResult,
  emptyMeterResult,
  object,
  optionalCount,
  parseEvent,
  setUsage,
  type UsageMeter,
} from '../usage.ts'

export function createCodexUsageMeter(): UsageMeter {
  const result = emptyMeterResult()
  const inspector = createCodexStreamInspector()
  const decoder = createSseDecoder(({ event: eventName, data }) => {
    const inspected = inspector.inspect({ event: eventName, data })
    if (inspected.kind === 'skip' || inspected.kind === 'invalid') return false
    const event = parseEvent(data)
    if (event === null) return false
    const response = object(event.response)
    if (inspected.kind === 'failure') {
      result.outcome = 'failed'
      result.signal = codexFailureSignal(response?.error ?? event.error ?? event)
      // Native failed/incomplete responses may still contain accurate usage.
      if (response === undefined) return false
    }
    if (
      event.type === 'response.output_text.delta' ||
      event.type === 'response.function_call_arguments.delta' ||
      event.type === 'response.custom_tool_call_input.delta'
    )
      addDelta(result, event.delta)
    if (inspected.kind !== 'failure' && !inspected.terminal) return
    // A terminal-shaped envelope without a response is not a complete provider terminal.
    if (response === undefined) return
    const usage = object(response.usage)
    const inputDetails =
      usage?.input_tokens_details === undefined ? {} : object(usage.input_tokens_details)
    const outputDetails =
      usage?.output_tokens_details === undefined ? {} : object(usage.output_tokens_details)
    const mapped =
      inputDetails === undefined || outputDetails === undefined
        ? null
        : {
            input: usage?.input_tokens,
            cacheRead: optionalCount(inputDetails.cached_tokens),
            cacheWrite: optionalCount(inputDetails.cache_write_tokens),
            output: usage?.output_tokens,
            reasoning: optionalCount(outputDetails.reasoning_tokens),
          }
    setUsage(result, response.usage, mapped)
    result.outcome = inspected.kind === 'failure' ? 'failed' : 'completed'
    return false
  })
  return {
    push: (chunk) => decoder.push(chunk),
    end() {
      decoder.end()
      return copyResult(result)
    },
  }
}
