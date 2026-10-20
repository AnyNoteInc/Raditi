// The ids tests of this package mean when they mean «a driver» or «a backend» in general
// (the same values as apps/core/src/testing/ids.ts, which a package cannot import).
import type { AgentDriverId, LlmBackendId, LlmCapacity } from '@repo/domain'

export const sampleDriverId = 'opencode' as const satisfies AgentDriverId
export const sampleBackendId = 'zai-coding' as const satisfies LlmBackendId
export const sampleBackendCapacity = 'windows' as const satisfies LlmCapacity
export const sampleProviderSlug = sampleBackendId
export const sampleProviderModelId = 'glm-5.3'
export const sampleModelSlug = 'glm-5.3-standard'
export const sampleRoutePath = '/zai/v4/chat/completions'
