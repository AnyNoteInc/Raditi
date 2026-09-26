import { errorMessage } from './async.ts'

export interface WarnLogger {
  warn(message: string): void
}

/**
 * Redis clients report an error on every reconnect attempt. This logs the first one and then
 * at most one line per window with the number of repeats: logged, never thrown, never a flood.
 */
export function throttledErrorLog(
  logger: WarnLogger,
  source: string,
  windowMs = 60_000,
  now: () => number = Date.now,
): (err: unknown) => void {
  let lastAt = Number.NEGATIVE_INFINITY
  let suppressed = 0
  return (err) => {
    const at = now()
    if (at - lastAt < windowMs) {
      suppressed += 1
      return
    }
    const repeats = suppressed > 0 ? ` (repeated ${suppressed} times since the last report)` : ''
    logger.warn(`${source}: ${errorMessage(err)}${repeats}`)
    lastAt = at
    suppressed = 0
  }
}
