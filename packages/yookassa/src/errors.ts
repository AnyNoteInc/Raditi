export class YookassaError extends Error {
  /** Safe to repeat the same request with the same Idempotence-Key. */
  readonly retryable: boolean

  constructor(message: string, options?: ErrorOptions & { retryable?: boolean }) {
    super(message, options)
    this.name = 'YookassaError'
    this.retryable = options?.retryable ?? false
  }
}

export class YookassaApiError extends YookassaError {
  readonly status: number
  /** ЮKassa error code: invalid_request, invalid_credentials, forbidden, not_found… */
  readonly code: string | undefined
  readonly body: unknown

  constructor(
    message: string,
    status: number,
    code: string | undefined,
    body: unknown,
    options?: ErrorOptions,
  ) {
    // 500 means the outcome is unknown: repeat with the same key or read the object back.
    super(message, { ...options, retryable: status === 429 || status >= 500 })
    this.name = 'YookassaApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}
