import { Counter, Gauge, type Registry } from '@prometheus-io/client'
import { browserToolNames, type BrowserTaskCode, type BrowserToolName } from '@repo/domain'

/** Why a frame never reached a viewer (FrameFlow's drops). */
export const frameDropReasons = ['replaced', 'stale'] as const
export type FrameDropReason = (typeof frameDropReasons)[number]

/** What an action of the agent ended with: `ok` or one of the fixed codes (§3.7). */
export type BrowserActionResult = 'ok' | BrowserTaskCode

/**
 * What the worker counts (spec §19): sessions and viewers now, frames sent and dropped, the
 * agent's actions by tool and result. No label carries a session, task, user or address.
 */
export interface BrowserWorkerMetrics {
  frameSent(): void
  framesDropped(reason: FrameDropReason, count: number): void
  action(tool: BrowserToolName, result: BrowserActionResult): void
}

export const noMetrics: BrowserWorkerMetrics = {
  frameSent: () => undefined,
  framesDropped: () => undefined,
  action: () => undefined,
}

/** The metrics on the worker's registry; the gauges read the live numbers when scraped. */
export function registerBrowserWorkerMetrics(
  registry: Registry,
  live: { sessions: () => number; viewers: () => number },
): BrowserWorkerMetrics {
  new Gauge({
    name: 'raditi_browser_sessions',
    help: 'Browser sessions the worker holds',
    registers: [registry],
    collect() {
      this.set(live.sessions())
    },
  })
  new Gauge({
    name: 'raditi_browser_viewers',
    help: 'Stream connections the worker serves',
    registers: [registry],
    collect() {
      this.set(live.viewers())
    },
  })
  const sent = new Counter({
    name: 'raditi_browser_frames_sent_total',
    help: 'Frames sent to viewers',
    registers: [registry],
  })
  const dropped = new Counter({
    name: 'raditi_browser_frames_dropped_total',
    help: 'Frames never sent to a viewer, by reason',
    labelNames: ['reason'],
    registers: [registry],
  })
  for (const reason of frameDropReasons) dropped.inc({ reason }, 0)
  const actions = new Counter({
    name: 'raditi_browser_actions_total',
    help: 'Actions of the agent, by tool and result',
    labelNames: ['tool', 'result'],
    registers: [registry],
  })
  for (const tool of browserToolNames) actions.inc({ tool, result: 'ok' }, 0)
  return {
    frameSent: () => sent.inc(),
    framesDropped: (reason, count) => {
      if (count > 0) dropped.inc({ reason }, count)
    },
    action: (tool, result) => actions.inc({ tool, result }),
  }
}
