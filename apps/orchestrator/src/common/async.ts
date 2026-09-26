export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * Settles with `promise` or rejects with TimeoutError after `ms`. The original promise keeps
 * running; its late rejection is already handled by the race and cannot crash the process.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * A readable one-line message. Connection failures to `localhost` (both ::1 and 127.0.0.1)
 * arrive as an AggregateError with an empty message, and Prisma reports them as a bare
 * "Invalid … invocation:" with the reason only in `code`: both are spelled out.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const inner =
    err instanceof AggregateError ? [...new Set(err.errors.map(errorMessage))].join('; ') : ''
  let text = [err.message.replace(/\s+/g, ' ').trim(), inner].filter(Boolean).join(': ')
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && !text.includes(code)) text = text ? `${text} (${code})` : code
  return text || err.name
}
