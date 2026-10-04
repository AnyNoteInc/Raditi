export class DomainError extends Error {
  readonly code: string
  readonly httpStatus: number
  readonly details?: unknown

  constructor(code: string, message: string, httpStatus: number, details?: unknown) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
    this.details = details
    this.name = 'DomainError'
  }
}

export const badRequest = (message: string, details?: unknown): DomainError =>
  new DomainError('BAD_REQUEST', message, 400, details)
export const forbidden = (message: string): DomainError =>
  new DomainError('FORBIDDEN', message, 403)
export const notFound = (message: string): DomainError => new DomainError('NOT_FOUND', message, 404)
export const conflict = (message: string): DomainError => new DomainError('CONFLICT', message, 409)
export const notImplemented = (what: string): DomainError =>
  new DomainError('NOT_IMPLEMENTED', `${what} is not implemented yet`, 501)

/** Pool decisions become retriable failures before a sandbox is created (P3, P12). */
export function subscriptionWait(retryAt: Date): DomainError {
  return subscriptionRetry('SUBSCRIPTION_WAIT', 'Subscription capacity is unavailable', retryAt)
}
export function subscriptionBusy(retryAt: Date): DomainError {
  return subscriptionRetry('SUBSCRIPTION_BUSY', 'Subscription slots are occupied', retryAt)
}
function subscriptionRetry(code: string, message: string, retryAt: Date): DomainError {
  if (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime())) {
    return badRequest('Invalid subscription retry time')
  }
  return new DomainError(code, message, 503, { retryAt: retryAt.toISOString() })
}
export const llmPriceMissing = (): DomainError =>
  new DomainError('LLM_PRICE_MISSING', 'No approved model accounting rate', 503)
export const llmGatewayUnavailable = (): DomainError =>
  new DomainError('LLM_GATEWAY_UNAVAILABLE', 'Subscription gateway is unavailable', 503)
export const crossBorderNotCleared = (): DomainError =>
  new DomainError('CROSS_BORDER_NOT_CLEARED', 'Data transfer is not cleared for this backend', 403)

/**
 * Size and count limits (spec §8): a 413 the client sees as «too much», never an outage.
 * The agent's changes to the site, its own session state, and the site repository itself.
 */
export const publicationTooLarge = (message = 'Publication exceeds its size limit'): DomainError =>
  new DomainError('PUBLICATION_TOO_LARGE', message, 413)
export const snapshotTooLarge = (message = 'Snapshot exceeds its size limit'): DomainError =>
  new DomainError('SNAPSHOT_TOO_LARGE', message, 413)
export const repositoryTooLarge = (message = 'Repository exceeds its size limit'): DomainError =>
  new DomainError('REPOSITORY_TOO_LARGE', message, 413)
/** The agent printed more than one turn may journal. */
export const turnOutputTooLarge = (message = 'Agent output exceeds its limits'): DomainError =>
  new DomainError('TURN_OUTPUT_TOO_LARGE', message, 413)

export function isTooLarge(e: unknown): e is DomainError {
  return (
    isDomainError(e) &&
    [
      'PUBLICATION_TOO_LARGE',
      'SNAPSHOT_TOO_LARGE',
      'REPOSITORY_TOO_LARGE',
      'TURN_OUTPUT_TOO_LARGE',
    ].includes(e.code)
  )
}

/**
 * Turn failures that are neither the client's input (400) nor a size limit (413): the agent,
 * its driver or its sandbox misbehaved, and the turn may be retried.
 */
export const turnOutputRejected = (message = 'Agent output was rejected'): DomainError =>
  new DomainError('TURN_OUTPUT_REJECTED', message, 502)
/** The agent changed CI or protected paths, or added a link, submodule or permission change. */
export const publicationForbidden = (
  message = 'Publication changes files the agent must not change',
): DomainError => new DomainError('PUBLICATION_FORBIDDEN', message, 502)
/** The secret scanner found something like a password or key in the agent's changes. */
export const publicationSecret = (
  message = 'Publication contains a possible secret',
): DomainError => new DomainError('PUBLICATION_SECRET', message, 502)
/** The site's own repository holds entries the agent cannot work with (links, submodules). */
export const repositoryUnsupported = (
  message = 'Repository contains unsupported entries',
): DomainError => new DomainError('REPOSITORY_UNSUPPORTED', message, 422)
export const driverPrepareInvalid = (message = 'Prepared agent run is invalid'): DomainError =>
  new DomainError('DRIVER_PREPARE_INVALID', message, 502)
export const sandboxCommandFailed = (
  message = 'Sandbox command failed or exceeded its limits',
): DomainError => new DomainError('SANDBOX_COMMAND_FAILED', message, 502)

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isDomainError(e: unknown): e is DomainError {
  return e instanceof Error && e.name === 'DomainError'
}
