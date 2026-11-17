import { Counter, Gauge, Histogram, type Registry } from '@prometheus-io/client'
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
  /**
   * Times of the stream in milliseconds (docs/plan/85-browser-stream-mobile.md, ТР2): a frame from
   * leaving the worker to its acknowledgement, a `ping` to its `pong`, and the cabinet's medians of
   * a period — drawing a frame, an input to the first frame that shows it.
   */
  streamTime(kind: StreamTimeKind, ms: number): void
}

export const streamTimeKinds = ['ack', 'rtt', 'draw', 'input'] as const
export type StreamTimeKind = (typeof streamTimeKinds)[number]

export const noMetrics: BrowserWorkerMetrics = {
  frameSent: () => undefined,
  framesDropped: () => undefined,
  action: () => undefined,
  streamTime: () => undefined,
}

/** Seconds, from a frame on a fast link to one a slow phone waits for. */
const STREAM_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2.5, 5]

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
  const times = Object.fromEntries(
    streamTimeKinds.map((kind) => [
      kind,
      new Histogram({
        name: `raditi_browser_stream_${kind}_seconds`,
        help: streamTimeHelp[kind],
        buckets: STREAM_BUCKETS,
        registers: [registry],
      }),
    ]),
  ) as Record<StreamTimeKind, Histogram>
  return {
    frameSent: () => sent.inc(),
    framesDropped: (reason, count) => {
      if (count > 0) dropped.inc({ reason }, count)
    },
    action: (tool, result) => actions.inc({ tool, result }),
    streamTime: (kind, ms) => {
      if (Number.isFinite(ms) && ms >= 0) times[kind].observe(ms / 1000)
    },
  }
}

const streamTimeHelp: Record<StreamTimeKind, string> = {
  ack: 'From sending a frame to a viewer to its acknowledgement',
  rtt: 'From a ping of the stream to its pong',
  draw: "The cabinet's median of decoding and drawing a frame, per period",
  input: "The cabinet's median from an input to the first frame that shows it, per period",
}
