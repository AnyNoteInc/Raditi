import { conflict, type LlmBackend, type LlmBackendId, type LlmCapacity } from '@repo/domain'

/**
 * What each backend of the registry declares of its accounts' capacity, for the pool of core.
 * An id without an adapter in this process has no pool to pick from: the issue fails closed.
 */
export function backendCapacities(
  backends: readonly LlmBackend[],
): (backend: LlmBackendId) => LlmCapacity {
  const declared = new Map(backends.map((backend) => [backend.id, backend.capacity]))
  return (backend) => {
    const capacity = declared.get(backend)
    if (capacity === undefined) throw conflict('No LLM backend adapter for the turn')
    return capacity
  }
}

const chatCompletions = '/chat/completions'

/**
 * The base URL a CLI in the sandbox is given for a backend (RunContext.llm.baseUrl): the address
 * of sandbox-gw and the backend's one route without the chat completions suffix, which an
 * OpenAI-style client appends itself. A backend with routes of another shape has none.
 */
export function llmGatewayBaseUrl(gateway: string, backend: Pick<LlmBackend, 'routes'>): string {
  const url = URL.canParse(gateway) ? new URL(gateway) : null
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new Error('The sandbox gateway needs an HTTP address without query or credentials')
  const [route, ...others] = backend.routes
  const prefix = route?.path.slice(0, -chatCompletions.length)
  if (
    !route ||
    others.length > 0 ||
    route.method !== 'POST' ||
    !route.path.endsWith(chatCompletions) ||
    !prefix
  )
    throw new Error('The LLM backend serves no single chat completions route')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${prefix}`
}
