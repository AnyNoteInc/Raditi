import {
  withTimeout,
  type ClientIdentity,
  type DeviceLoginState,
  type EgressHttp,
  type EgressRequest,
  type LlmBackend,
  type SubscriptionCredential,
} from '@repo/domain'

const unavailable = () => new Error('Subscription login failed')
const lifetimeMs = 15 * 60_000

export interface SubscriptionAuthenticationOptions {
  backend: LlmBackend
  identity: ClientIdentity
  http: EgressHttp
  signal: AbortSignal
  /** A controlling terminal, never a log or ordinary stdout/stderr. */
  showDeviceCode(state: Pick<DeviceLoginState, 'verificationUri' | 'userCode'>): Promise<void>
  readSecret(): Promise<string>
  now?: () => number
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

/** Device-flow state and API keys stay in memory; exchanges are never automatically replayed. */
export async function authenticateSubscription(
  options: SubscriptionAuthenticationOptions,
): Promise<SubscriptionCredential> {
  const { backend, identity, http, signal } = options
  const now = options.now ?? Date.now
  const end = now() + lifetimeMs
  const wait = options.wait ?? abortableWait
  const request = async (input: EgressRequest, deadline = end) => {
    const remaining = deadline - now()
    if (signal.aborted || remaining <= 0) throw unavailable()
    return http.request(input, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(20_000, remaining))]),
    })
  }
  try {
    if (signal.aborted) throw unavailable()
    if (!backend.login) {
      if (!backend.importCredential) throw unavailable()
      const credential = backend.importCredential(await options.readSecret())
      if (signal.aborted || now() >= end) throw unavailable()
      const scopedHttp: EgressHttp = { request: (input) => request(input) }
      const probe = await backend.probe(credential, identity, scopedHttp)
      if (probe.status !== 'ok' || signal.aborted) throw unavailable()
      return credential
    }
    const login = backend.login
    const started = now()
    let state = login.parseStart(await request(login.start(identity)), new Date(started))
    const deadline = Math.min(end, +state.expiresAt)
    if (!Number.isFinite(deadline) || deadline <= now()) throw unavailable()
    await options.showDeviceCode({
      verificationUri: state.verificationUri,
      userCode: state.userCode,
    })
    // A continuation (the code exchange) may make the provider issue tokens: once sent, only its
    // own timeout ends it, and its reply is always parsed, late or interrupted. The caller then
    // saves the tokens or revokes them; dropped here, nothing could ever revoke them.
    const continuation = (input: EgressRequest) => {
      if (signal.aborted || now() >= deadline) throw unavailable()
      return http.request(input, { signal: AbortSignal.timeout(20_000) })
    }
    let interval = state.intervalMs
    for (;;) {
      if (!Number.isSafeInteger(interval) || interval < 1000 || interval > lifetimeMs)
        throw unavailable()
      if (signal.aborted || now() + interval >= deadline) throw unavailable()
      await wait(interval, signal)
      let response = await request(login.poll(state), deadline)
      let continued = false
      for (;;) {
        if (!continued && (signal.aborted || now() >= deadline)) throw unavailable()
        const result = login.parsePoll(response, state, new Date(now()))
        if (result.kind === 'complete') {
          const parsed = backend.credentialSchema.safeParse(result.credential)
          if (!parsed.success) throw unavailable()
          return parsed.data
        }
        if (result.kind === 'denied') throw unavailable()
        if (result.kind === 'pending') {
          interval = result.intervalMs
          break
        }
        state = result.state
        response = await continuation(result.request)
        continued = true
      }
    }
  } catch {
    // Transport, JSON and validation exceptions can include credentials or device codes.
    throw unavailable()
  }
}

/** The save failed after the provider issued credentials; `revoked` tells what became of them. */
export class UnsavedSubscriptionLogin extends Error {
  readonly failure: unknown
  readonly revoked: boolean

  constructor(failure: unknown, revoked: boolean) {
    super('Subscription login was not saved')
    this.name = 'UnsavedSubscriptionLogin'
    this.failure = failure
    this.revoked = revoked
  }
}

/**
 * Credentials exist at the provider from the moment it issued them. If they cannot be saved
 * (a dead writer token, a taken label, an interrupted command), only this process can still
 * revoke them: afterwards nothing would hold their refresh token. An imported key has no
 * revocation through the adapter; its owner keeps it.
 */
export async function saveIssuedCredential<T>(options: {
  backend: Pick<LlmBackend, 'revoke'>
  credential: SubscriptionCredential
  http: EgressHttp
  save(): Promise<T>
}): Promise<T> {
  try {
    return await options.save()
  } catch (error) {
    const revoke = options.backend.revoke
    if (!revoke) throw error
    const revoked = await withTimeout(
      revoke(options.credential, options.http),
      30_000,
      'Subscription revocation timeout',
    ).then(
      () => true,
      () => false,
    )
    throw new UnsavedSubscriptionLogin(error, revoked)
  }
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(unavailable())
      return
    }
    const aborted = () => {
      clearTimeout(timer)
      reject(unavailable())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', aborted, { once: true })
  })
}
