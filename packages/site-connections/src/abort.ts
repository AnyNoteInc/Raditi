import { SiteConnectionError, type ConnectionCheckReason } from '@repo/domain'

// One deadline for everything (ConnectionContext.signal): every adapter operation races its
// signal, and aborting it destroys the sockets of the operation. These helpers keep the race in
// one place, so no promise of a library outlives its caller unhandled.

/**
 * What an operation rejects with once its signal aborted. It never leaves the package: a check
 * answers `unreachable` (the deadline is a timeout), a session `transfer_failed`.
 */
export class OperationAborted extends Error {
  constructor() {
    super('Operation aborted')
    this.name = 'OperationAborted'
  }
}

export function isOperationAborted(error: unknown): error is OperationAborted {
  return error instanceof Error && error.name === 'OperationAborted'
}

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
 * `work`, or OperationAborted as soon as `signal` aborts. `work` keeps running (its owner destroys
 * the sockets through whenAborted); its late rejection is handled here and goes nowhere.
 */
export async function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  work.catch(noop)
  if (signal.aborted) throw new OperationAborted()
  let unsubscribe = noop
  const aborted = new Promise<never>((_, reject) => {
    unsubscribe = whenAborted(signal, () => reject(new OperationAborted()))
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    unsubscribe()
  }
}

/**
 * `work`, or SiteConnectionError(reason) when it has not settled within `ms`: the idle bound of
 * one request of a session. The timer never holds the process open.
 */
export async function withinIdle<T>(
  work: Promise<T>,
  ms: number,
  reason: ConnectionCheckReason = 'transfer_failed',
): Promise<T> {
  work.catch(noop)
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SiteConnectionError(reason)), ms)
    timer.unref()
  })
  try {
    return await Promise.race([work, idle])
  } finally {
    clearTimeout(timer)
  }
}

/** A promise that is never awaited by anyone but must not crash the process when it rejects. */
export function ignoreRejection(work: Promise<unknown>): void {
  work.catch(noop)
}
