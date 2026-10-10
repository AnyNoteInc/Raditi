// The one place that says which driver, backend and model a *.test.ts file or a stand of this
// app means when it means «a driver» or «a backend» in general. A test of one adapter's own
// behaviour names that adapter itself. Types only are imported: the stand scripts (*.mjs) load
// this file from src as it is.
import type { AgentDriverId, LlmBackendId } from '@repo/domain'

/** A driver in general. */
export const sampleDriverId = 'opencode' as const satisfies AgentDriverId

/** A backend in general. */
export const sampleBackendId = 'zai-coding' as const satisfies LlmBackendId

/** The provider row of that backend: the seeds give it the backend id as its slug. */
export const sampleProviderSlug = sampleBackendId

/** The model the provider is asked for, and the slug of its profile of the class `standard`. */
export const sampleProviderModelId = 'glm-5.3'
export const sampleModelSlug = 'glm-5.3-standard'

/** The route of that backend a sandbox calls, as the role llm and `llm_calls.route` name it. */
export const sampleRoutePath = '/zai/v4/chat/completions'
