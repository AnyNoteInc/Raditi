import type { EgressHttp, EgressRequest, LlmBackend, SubscriptionCredential } from '@repo/domain'

const unavailable = () => new Error('Subscription login failed')
const lifetimeMs = 15 * 60_000

export interface SubscriptionAuthenticationOptions {
  backend: LlmBackend
  http: EgressHttp
  signal: AbortSignal
  readSecret(): Promise<string>
  now?: () => number
}

/**
 * The key of a subscription is read once and stays in memory: it is accepted only when the
 * provider answers a content-free probe sent with it.
 */
export async function authenticateSubscription(
  options: SubscriptionAuthenticationOptions,
): Promise<SubscriptionCredential> {
  const { backend, http, signal } = options
  const now = options.now ?? Date.now
  const end = now() + lifetimeMs
  const request = async (input: EgressRequest) => {
    const remaining = end - now()
    if (signal.aborted || remaining <= 0) throw unavailable()
    return http.request(input, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(20_000, remaining))]),
    })
  }
  try {
    if (signal.aborted || !backend.importCredential) throw unavailable()
    const credential = backend.importCredential(await options.readSecret())
    if (signal.aborted || now() >= end) throw unavailable()
    const probe = await backend.probe(credential, { request })
    if (probe.status !== 'ok' || signal.aborted) throw unavailable()
    return credential
  } catch {
    // Transport, JSON and validation exceptions can include the key.
    throw unavailable()
  }
}
