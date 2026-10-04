import { parseLlmJson, refusalForSignal, type CallSignal, type LlmBackend } from '@repo/domain'

/** Provider errors are mapped to our fixed messages before becoming CLI stream events. */
export function safeStreamError(refusal: LlmBackend['refusal'], signal: CallSignal): unknown {
  return parseLlmJson(refusal(refusalForSignal(signal)).body).error
}
