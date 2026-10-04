import type { LlmBackend } from '@repo/domain'

import { kimiCodeBackend } from './kimi-code/backend.ts'
import { codexBackend } from './openai-chatgpt/backend.ts'

export { codexBackend, kimiCodeBackend }
/** Every subscription backend of the platform: the default set of an egress and its configuration. */
export const llmBackends: readonly LlmBackend[] = [codexBackend, kimiCodeBackend]
export { createSseDecoder, type SseEvent } from './sse.ts'
export { emptyMeterResult } from './usage.ts'
