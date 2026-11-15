/**
 * What a log line says of a failure of Vault or of another service: the name of the error and its
 * HTTP status, never its message — that may hold a path, a value or a token.
 */
export function failureLabel(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error'
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isSafeInteger(status)
    ? `error=${name} status=${status}`
    : `error=${name}`
}
