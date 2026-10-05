import type { LlmBackend } from '@repo/domain'

import { object, parseEvent } from '../usage.ts'
import { codexFailureSignal, codexStreamError } from './responses.ts'

export function createCodexStreamInspector(): ReturnType<LlmBackend['streamInspector']> {
  let finished = false
  return {
    inspect(event) {
      if (finished) return { kind: 'skip' }
      const value = parseEvent(event.data)
      if (value === null) return { kind: 'invalid' }
      const response = object(value.response)
      if (
        value.type === 'response.failed' ||
        value.type === 'response.incomplete' ||
        value.type === 'error' ||
        event.event === 'response.failed' ||
        event.event === 'response.incomplete' ||
        event.event === 'error' ||
        value.error != null ||
        response?.error != null ||
        response?.status === 'failed' ||
        response?.status === 'incomplete'
      ) {
        finished = true
        const signal = codexFailureSignal(response?.error ?? value.error ?? value) ?? {
          kind: 'transient' as const,
          retryAfterMs: 30_000,
        }
        return {
          kind: 'failure',
          signal,
          event: {
            event: 'response.failed',
            data: JSON.stringify({
              type: 'response.failed',
              response: {
                id: 'raditi_failure',
                status: 'failed',
                error: codexStreamError(signal),
              },
            }),
          },
        }
      }
      if (value.type === 'response.completed' && response !== undefined) {
        finished = true
        return { kind: 'forward', event, terminal: true }
      }
      return { kind: 'forward', event }
    },
  }
}
