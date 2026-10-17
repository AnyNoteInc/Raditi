import type { LlmBackend } from '@repo/domain'

import { zaiApiBackend, zaiCodingBackend } from './zai-coding/backend.ts'

export { zaiApiBackend, zaiCodingBackend }
/**
 * Every subscription backend of the platform, in the order of llmBackendIds: the default set
 * of an egress and its configuration.
 */
export const llmBackends: readonly LlmBackend[] = [zaiCodingBackend, zaiApiBackend]
export { createSseDecoder, type SseEvent } from './sse.ts'
export { emptyMeterResult } from './usage.ts'
