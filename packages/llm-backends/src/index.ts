import type { LlmBackend } from '@repo/domain'

import { kimiCodeBackend } from './kimi-code/backend.ts'
import { codexBackend } from './openai-chatgpt/backend.ts'
import { zaiCodingBackend } from './zai-coding/backend.ts'

export { codexBackend, kimiCodeBackend, zaiCodingBackend }
/** Every subscription backend of the platform: the default set of an egress and its configuration. */
export const llmBackends: readonly LlmBackend[] = [codexBackend, kimiCodeBackend, zaiCodingBackend]
export { createSseDecoder, type SseEvent } from './sse.ts'
export { emptyMeterResult } from './usage.ts'
