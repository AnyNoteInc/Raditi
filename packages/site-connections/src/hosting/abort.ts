import { SiteConnectionError, type ConnectionCheckReason } from '@repo/domain'

// One deadline for a session (ConnectionContext.signal) and one idle bound per request; the same
// helpers as src/abort.ts of the site connection wizard (plan 39), for the writers of a release.

const noop = () => {}

/** Calls `action` once when `signal` aborts — at once when it already has. Returns the unsubscribe. */
export function whenAborted(signal: AbortSignal, action: () => void): () => void {
  if (signal.aborted) {
    action()
    return noop
  }
  signal.addEventListener('abort', action, { once: true })
  return () => signal.removeEventListener('abort', action)
}

/**
 * `work`, or SiteConnectionError(reason) when it has not settled within `ms`, or as soon as the
 * session's signal aborts. The timer never holds the process open.
 */
export async function withinIdle<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  reason: ConnectionCheckReason = 'transfer_failed',
): Promise<T> {
  work.catch(noop)
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = noop
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SiteConnectionError(reason)), ms)
    timer.unref()
    if (signal) unsubscribe = whenAborted(signal, () => reject(new SiteConnectionError(reason)))
  })
  try {
    return await Promise.race([work, idle])
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
}

/** A promise nobody awaits must not crash the process when it rejects. */
export function ignoreRejection(work: Promise<unknown>): void {
  work.catch(noop)
}
