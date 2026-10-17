import { type CallSignal, type LlmBackend, type LlmStreamFailure } from '@repo/domain'

import { safeStreamError } from '../stream-errors.ts'
import { object, parseEvent } from '../usage.ts'
import { zaiClassifier, zaiRefusal, type ZaiAnswers } from './errors.ts'

/**
 * The values the pinned CLI ends a step on. After any other one, after a stream that names
 * none and after an empty stream it sends the same request again at once, without a pause and
 * without a limit (docs/plan/40-opencode-spike.md, section 4).
 */
const finishing = new Set(['stop', 'tool_calls', 'length'])

function signalOfFinish(reason: unknown): CallSignal {
  // The provider's content filter, by its own name and by the common one.
  if (reason === 'sensitive') return { kind: 'policy_flagged', code: 'zai_finish_sensitive' }
  if (reason === 'content_filter')
    return { kind: 'policy_flagged', code: 'zai_finish_content_filter' }
  if (reason === 'model_context_window_exceeded')
    return { kind: 'request_rejected', code: 'zai_finish_context_window' }
  if (reason === 'network_error') return { kind: 'transient', retryAfterMs: 30_000 }
  // A value nobody has seen: the turn ends and the role reads the quota.
  return { kind: 'unconfirmed_block', code: 'zai_finish_reason' }
}

/**
 * The one shape the CLI ends a turn on inside a started stream is an `error` object: one
 * request, exit code 1. Every failure is sent that way, with the gateway's own text; whether
 * the CLI repeats it depends on that text alone, and only the short-lived one invites it.
 */
function failure(signal: CallSignal): LlmStreamFailure {
  return {
    kind: 'failure',
    signal,
    event: {
      event: 'message',
      data: JSON.stringify({ error: safeStreamError(zaiRefusal, signal) }),
    },
  }
}

/** The inspector of one offer: an error inside a stream is read by that offer's table. */
export function createZaiStreamInspector(
  answers: ZaiAnswers,
): ReturnType<LlmBackend['streamInspector']> {
  const { classifyStreamError } = zaiClassifier(answers)
  // A finish_reason of the allowed list has been forwarded.
  let finished = false
  // Nothing more is forwarded: DONE, a failure or the end has been answered.
  let closed = false
  const unfinished = (): LlmStreamFailure => {
    closed = true
    return failure({ kind: 'unconfirmed_block', code: 'zai_stream_unfinished' })
  }
  return {
    inspect(event) {
      if (closed) return { kind: 'skip' }
      if (event.data === '[DONE]') {
        // DONE alone invents no answer: the CLI would ask again.
        if (!finished) return unfinished()
        closed = true
        return { kind: 'forward', event, terminal: true }
      }
      const value = parseEvent(event.data)
      if (value === null) return { kind: 'invalid' }
      // An error object, or the HTTP 200 envelope `{code, msg, success: false}`.
      if (value.error != null || event.event === 'error' || value.success === false) {
        if (finished) return { kind: 'skip' }
        closed = true
        return failure(classifyStreamError(value))
      }
      // Neither a completion chunk nor an error: nothing the CLI could read.
      if (!Array.isArray(value.choices)) return { kind: 'skip' }
      const reason = object(value.choices[0])?.finish_reason
      if (reason === undefined || reason === null || reason === '')
        return { kind: 'forward', event }
      if (typeof reason === 'string' && finishing.has(reason)) {
        finished = true
        return { kind: 'forward', event }
      }
      // The answer is already complete: a later value that contradicts it changes nothing.
      if (finished) return { kind: 'skip' }
      closed = true
      return failure(signalOfFinish(reason))
    },
    end() {
      // A finished answer without DONE is complete; anything else must not end silently.
      if (closed || finished) return null
      return unfinished()
    },
  }
}
