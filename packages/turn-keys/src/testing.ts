// The ids tests of this package mean when they mean «a backend» in general (the same value as
// apps/core/src/testing/ids.ts, which a package cannot import).
import type { LlmBackendId } from '@repo/domain'

export const sampleBackendId = 'zai-coding' as const satisfies LlmBackendId
