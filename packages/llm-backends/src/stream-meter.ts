import type { LlmBackend, MeterResult } from '@repo/domain'

import { createSseDecoder } from './sse.ts'

/**
 * A backend's usage meter fed with the bytes of a whole stream: one decoder and one inspector,
 * as the gateway reads it. For a caller that has only the bytes — a probe, a stand, a test.
 */
export function createStreamMeter(backend: Pick<LlmBackend, 'streamInspector' | 'usageMeter'>): {
  push(chunk: Uint8Array): void
  end(): MeterResult
} {
  const inspector = backend.streamInspector()
  const meter = backend.usageMeter()
  const decoder = createSseDecoder((event) => {
    const inspected = inspector.inspect(event)
    meter.observe(event, inspected)
    if (
      inspected.kind === 'invalid' ||
      inspected.kind === 'failure' ||
      (inspected.kind === 'forward' && inspected.terminal)
    )
      return false
  })
  return {
    push: (chunk) => decoder.push(chunk),
    end() {
      decoder.end()
      return meter.end()
    },
  }
}
