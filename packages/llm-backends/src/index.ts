import type { LlmBackend } from '@repo/domain'

import { zaiCodingBackend } from './zai-coding/backend.ts'

export { zaiCodingBackend }
/** Every subscription backend of the platform: the default set of an egress and its configuration. */
export const llmBackends: readonly LlmBackend[] = [zaiCodingBackend]
export { createSseDecoder, type SseEvent } from './sse.ts'
export { emptyMeterResult } from './usage.ts'
