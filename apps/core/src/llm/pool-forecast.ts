import {
  absoluteWindow,
  accountWindowForecast,
  type LimitWindow,
  type PoolDecision,
} from '@repo/domain'

/**
 * The windows of an account with their use forecast between probes, in plan credits (plan 71,
 * §2.1): the probe's use plus what the calls of the account took since and what its open calls
 * hold. The pool reads this, in the issue of a key and in the choice of a pass's backend alike.
 */
export function forecastWindows(
  windows: LimitWindow[] | null,
  since: { closedSinceProbe: string; openReserved: string },
): LimitWindow[] | null {
  if (windows === null) return null
  return windows.map((window) => {
    const absolute = absoluteWindow(window)
    if (absolute === null) return window
    const used = accountWindowForecast({ probedUsedCredits: absolute.usedCredits, ...since })
    return {
      ...window,
      limitCredits: absolute.limitCredits,
      usedCredits: Math.min(used, 1e9),
      usedPct: Math.min(100, (used * 100) / absolute.limitCredits),
    }
  })
}

/**
 * The account a wait stands on only by the forecast: the pool waits over the forecast, and the
 * same pool over the windows Z.ai last reported would take this account. The forecast is a guess
 * of what the provider counts — on 19.11.2026 it closed the five hours of the plan on a chat
 * whose calls Z.ai kept answering — so it is checked by a probe before it refuses anyone. null —
 * the wait is not the forecast's (an unknown window asks its own probe, a reported one waits).
 */
export function forecastOnlyWait(forecast: PoolDecision, reported: PoolDecision): string | null {
  if (forecast.kind !== 'wait' || forecast.probeAccountIds.length > 0) return null
  return reported.kind === 'selected' ? reported.accountId : null
}
