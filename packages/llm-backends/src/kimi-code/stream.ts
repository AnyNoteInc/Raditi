import { refusalForSignal, type LlmBackend } from '@repo/domain'

import { safeStreamError } from '../stream-errors.ts'
import { object, parseEvent } from '../usage.ts'
import { classifyKimiStreamFailure, kimiRefusal } from './errors.ts'

/**
 * The pinned CLI retries every in-stream error object up to 10 times, whatever its type, code
 * or text, and every retry is another provider request. The one in-stream shape it ends the turn
 * on is a choice stopped by the provider's filter, so a final refusal is sent that way; a
 * short-lived one keeps the scrubbed error and is retried. Measured with CLI 2.1.1, kept proven
 * by `pnpm verify:llm-gateway`.
 */
const finalChunk = JSON.stringify({
  choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
})

export function createKimiStreamInspector(): ReturnType<LlmBackend['streamInspector']> {
  let finished = false
  let closed = false
  return {
    inspect(event) {
      if (closed) return { kind: 'skip' }
      if (event.data === '[DONE]') {
        closed = true
        return { kind: 'forward', event, terminal: true }
      }
      const value = parseEvent(event.data)
      if (value === null) return { kind: 'invalid' }
      if (value.error != null || event.event === 'error') {
        if (finished) return { kind: 'skip' }
        closed = true
        const signal = classifyKimiStreamFailure(value)
        return {
          kind: 'failure',
          signal,
          event: {
            event: 'message',
            data:
              refusalForSignal(signal) === 'transient'
                ? JSON.stringify({ error: safeStreamError(kimiRefusal, signal) })
                : finalChunk,
          },
        }
      }
      const choice = object(Array.isArray(value.choices) ? value.choices[0] : undefined)
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0)
        finished = true
      return { kind: 'forward', event }
    },
  }
}
