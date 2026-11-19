// Hooks for the checks and the measurements; not part of what the cabinet would ship.

export interface Interaction {
  name: string
  ms: number
  at: number
}

export interface FrameReport {
  intervals: number[]
  longTasks: Array<{ start: number; duration: number }>
  loafs: Array<{ start: number; duration: number; blocking: number }>
}

interface Spike {
  ready: boolean
  marks: Record<string, number>
  interactions: Interaction[]
  notices: string[]
  firstCommitMs?: number
  commits: number
  events: Array<{ name: string; duration: number; input: number }>
  frames: { start(): void; stop(): FrameReport }
  [key: string]: unknown
}

declare global {
  interface Window {
    __spike: Spike
  }
}

function frameProbe(): Spike['frames'] {
  let running = false
  let last = 0
  let intervals: number[] = []
  let longTasks: FrameReport['longTasks'] = []
  let loafs: FrameReport['loafs'] = []
  const observers: PerformanceObserver[] = []
  const loop = (t: number) => {
    if (!running) return
    if (last > 0) intervals.push(t - last)
    last = t
    requestAnimationFrame(loop)
  }
  return {
    start() {
      running = true
      last = 0
      intervals = []
      longTasks = []
      loafs = []
      const supported = PerformanceObserver.supportedEntryTypes ?? []
      if (supported.includes('longtask')) {
        const o = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration })
        })
        o.observe({ type: 'longtask' })
        observers.push(o)
      }
      if (supported.includes('long-animation-frame')) {
        const o = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const blocking = (e as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0
            loafs.push({ start: e.startTime, duration: e.duration, blocking })
          }
        })
        o.observe({ type: 'long-animation-frame' })
        observers.push(o)
      }
      requestAnimationFrame(loop)
    },
    stop() {
      running = false
      for (const o of observers.splice(0)) o.disconnect()
      return { intervals, longTasks, loafs }
    },
  }
}

export const spike: Spike = (window.__spike ??= {
  ready: false,
  marks: {},
  interactions: [],
  notices: [],
  commits: 0,
  events: [],
  frames: frameProbe(),
})

try {
  if ((PerformanceObserver.supportedEntryTypes ?? []).includes('event')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        spike.events.push({ name: e.name, duration: e.duration, input: e.processingStart - e.startTime })
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit)
  }
} catch {
  // Event Timing is not everywhere (WebKit).
}

export function mark(name: string): void {
  spike.marks[name] = performance.now()
}

/** Runs after the next paint: a frame, then a task. */
export function afterPaint(callback: () => void): void {
  requestAnimationFrame(() => setTimeout(callback, 0))
}

/** Time from an input (its event time stamp) to the paint that shows its result. */
export function track(name: string, t0: number = performance.now()): void {
  afterPaint(() => spike.interactions.push({ name, ms: performance.now() - t0, at: t0 }))
}

export function notice(text: string): void {
  spike.notices.push(text)
}
