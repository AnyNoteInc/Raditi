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

/** Checks the name, not `instanceof`: works across duplicated module instances. */
export function isDomainError(e: unknown): e is DomainError {
  return e instanceof Error && e.name === 'DomainError'
}
