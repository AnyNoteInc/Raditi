/**
 * A readable one-line message. Connection failures to `localhost` (both ::1 and 127.0.0.1)
 * arrive as an AggregateError with an empty message, and Prisma reports them as a bare
 * "Invalid … invocation:" with the reason only in `code`: both are spelled out.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const inner =
    error instanceof AggregateError ? [...new Set(error.errors.map(errorMessage))].join('; ') : ''
  let text = [error.message.replace(/\s+/g, ' ').trim(), inner].filter(Boolean).join(': ')
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && !text.includes(code)) text = text ? `${text} (${code})` : code
  return text || error.name
}

export interface ThrottledLoggerOptions {
  windowMs?: number
  now?: () => number
}

/** `source` names what failed: a dependency, a queue, a periodic check. */
export type ThrottledLog = (source: string, error: unknown) => void

/**
 * Logs the first failure of each source, then at most one line per window with the number of
 * suppressed repeats. Reconnecting clients and frequent probes fail every few seconds while a
 * dependency is away: logged, never thrown, never a flood.
 */
export function throttledLogger(
  log: (line: string) => void,
  { windowMs = 60_000, now = Date.now }: ThrottledLoggerOptions = {},
): ThrottledLog {
  const sources = new Map<string, { at: number; suppressed: number }>()
  return (source, error) => {
    const at = now()
    const last = sources.get(source)
    if (last && at - last.at < windowMs) {
      last.suppressed += 1
      return
    }
    const repeats = last?.suppressed
      ? ` (repeated ${last.suppressed} times since the last report)`
      : ''
    sources.set(source, { at, suppressed: 0 })
    log(`${source}: ${errorMessage(error)}${repeats}`)
  }
}
