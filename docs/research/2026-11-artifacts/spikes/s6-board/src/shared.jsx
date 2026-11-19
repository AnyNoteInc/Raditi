// What both boards share: parameters, layout of 10 screens × 2 views, the load tracker, the frame box
// (a live sandboxed iframe or a thumbnail) and the recorder of frame times.
import { createContext, memo, useContext, useLayoutEffect, useRef, useState } from 'react'

const q = new URLSearchParams(location.search)
export const params = {
  impl: q.get('impl') ?? 'a',               // a — CSS transform; b — @xyflow/react; list — phone list (Ар49)
  live: q.get('live') ?? '2',               // N — the first N frames live; autoK — visible at zoom >= zlive, at most K
  pe: q.get('pe') ?? 'none',                // none — board iframes never take the pointer; drag — only while moving; auto — control
  frames: q.get('frames') ?? location.origin,
  busy: q.get('busy') === '1',              // the first frame runs a busy loop (150 ms every 300 ms)
  sandbox: q.get('nosandbox') === '1' ? null : 'allow-scripts',
  zlive: Number(q.get('zlive') ?? 0.3),
  bg: q.get('bg') !== '0',
  hz: q.get('hz') === '1',                  // hide live iframes while zooming (a thumbnail stays under each)
}
export const autoCap = /^auto(\d+)$/.exec(params.live)?.[1] ? Number(/^auto(\d+)$/.exec(params.live)[1]) : null
export const fixedLive = autoCap === null ? Number(params.live) : null

export const LABEL = 56
export function layoutBoard(screens, cols = 5) {
  const IN = 100, COL_GAP = 300, ROW_GAP = 400
  const colW = 1440 + IN + 390
  const frames = []
  let rowY = 0
  for (let r = 0; r * cols < screens.length; r++) {
    const row = screens.slice(r * cols, r * cols + cols)
    const rowH = Math.max(...row.map((s) => Math.max(s.h1440, s.h390)))
    row.forEach((s, c) => {
      const x = c * (colW + COL_GAP)
      frames.push({ id: `${s.token}@1440`, screen: s, view: 1440, x, y: rowY + LABEL, w: 1440, h: s.h1440 })
      frames.push({ id: `${s.token}@390`, screen: s, view: 390, x: x + 1440 + IN, y: rowY + LABEL, w: 390, h: s.h390 })
    })
    rowY += LABEL + rowH + ROW_GAP
  }
  const width = cols * colW + (cols - 1) * COL_GAP
  return { frames, bounds: { x: 0, y: 0, w: width, h: rowY - ROW_GAP } }
}

export function fitViewport(bounds, w, h, pad = 0.04) {
  const z = Math.min(w / (bounds.w * (1 + 2 * pad)), h / (bounds.h * (1 + 2 * pad)))
  return { x: (w - bounds.w * z) / 2 - bounds.x * z, y: (h - bounds.h * z) / 2 - bounds.y * z, zoom: z }
}

// Which frames are live: fixed — the first N; auto — the visible ones nearest the centre at zoom >= zlive.
export function autoLive(frames, vp, w, h) {
  if (vp.zoom < params.zlive) return new Set()
  const cx = w / 2, cy = h / 2
  const seen = []
  for (const f of frames) {
    const l = vp.x + f.x * vp.zoom, t = vp.y + f.y * vp.zoom, r = l + f.w * vp.zoom, b = t + f.h * vp.zoom
    if (r < 0 || b < 0 || l > w || t > h) continue
    const fx = Math.max(l, Math.min(cx, r)), fy = Math.max(t, Math.min(cy, b))
    seen.push([Math.hypot(fx - cx, fy - cy), f.id])
  }
  seen.sort((a, b) => a[0] - b[0])
  return new Set(seen.slice(0, autoCap).map((x) => x[1]))
}

// Load tracker: live iframes count when their load event fires, thumbnails when decoded.
export const tracker = {
  pending: new Map(), done: [], waiters: new Set(), swaps: 0,
  begin(id, kind) { this.pending.set(id, { kind, t0: performance.now() }) },
  cancel(id) { if (this.pending.delete(id)) this.flush() },
  end(id) {
    const p = this.pending.get(id); if (!p) return
    this.pending.delete(id); this.done.push({ id, kind: p.kind, t0: p.t0, t: performance.now() }); this.flush()
  },
  flush() { if (!this.pending.size) for (const w of [...this.waiters]) { this.waiters.delete(w); w() } },
  idle() { return this.pending.size ? new Promise((r) => this.waiters.add(r)) : Promise.resolve() },
}

export const heights = new Map() // frame id -> height the bridge reported
addEventListener('message', (e) => {
  if (e.data?.raditi !== 'frame') return
  for (const el of document.querySelectorAll('iframe[data-id]')) if (el.contentWindow === e.source) heights.set(el.dataset.id, e.data.h)
})

export const BoardCtx = createContext({ onOpen: () => {} })

function Thumb({ f, onDone }) {
  const id = `thumb:${f.id}`
  useLayoutEffect(() => { tracker.begin(id, 'thumb'); return () => tracker.cancel(id) }, [id])
  return (
    <img className="thumb" alt="" draggable={false} decoding="async" width={f.w} height={f.h}
      src={`/thumbs/${f.screen.token}-${f.view}.png`}
      onLoad={(e) => { e.currentTarget.decode().catch(() => {}).finally(() => { tracker.end(id); onDone?.() }) }} />
  )
}

function Live({ f, auto }) {
  const id = `live:${f.id}`
  const [loaded, setLoaded] = useState(false)
  useLayoutEffect(() => { tracker.begin(id, 'live'); if (auto) tracker.swaps++; return () => tracker.cancel(id) }, [id, auto])
  const token = params.busy && f.id === 'm1-a@1440' ? 'busy' : f.screen.token
  return (
    <>
      {((auto && !loaded) || params.hz) && <Thumb f={f} />}
      <iframe data-id={f.id} title={`${f.screen.title} · ${f.view}`} width={f.w} height={f.h} scrolling="no"
        src={`${params.frames}/v/${token}`} {...(params.sandbox ? { sandbox: params.sandbox } : {})}
        style={auto && !loaded ? { opacity: 0 } : undefined}
        onLoad={() => { tracker.end(id); setLoaded(true) }} />
    </>
  )
}

export const FrameBox = memo(function FrameBox({ f, live, positioned }) {
  const style = positioned ? { left: f.x, top: f.y, width: f.w, height: f.h } : { width: f.w, height: f.h }
  return (
    <div className="frame" data-frame={f.id} style={style}>
      <div className="frame-label">{f.screen.title} · {f.view === 1440 ? 'компьютер' : 'телефон'}</div>
      {live ? <Live f={f} auto={autoCap !== null} /> : <Thumb f={f} />}
    </div>
  )
})

export function useOpen() { return useContext(BoardCtx).onOpen }

// Frame times and long tasks of the cabinet page (its main thread). pause() and start() again cut a
// memory dump out of the record: the interval across a pause is not a frame, entries inside it are dropped.
let rec = null
let gen = 0
function loopFor(g) {
  const loop = (t) => { if (!rec || gen !== g) return; rec.raf.push(t); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
}
export const perf = {
  start() {
    if (rec?.pausedAt != null) {
      rec.gaps.push([rec.pausedAt, performance.now()]); rec.pausedAt = null
      rec.raf.push(null); loopFor(++gen); return
    }
    rec = { t0: performance.now(), raf: [], long: [], loaf: [], gaps: [], pausedAt: null, po: [] }
    loopFor(++gen)
    const observe = (type, map, arr) => {
      try { const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) arr.push(map(e)) }); po.observe({ type, buffered: false }); rec.po.push(po) } catch {}
    }
    observe('longtask', (e) => ({ s: e.startTime, d: e.duration, a: e.attribution?.[0]?.containerType || e.name }), rec.long)
    observe('long-animation-frame', (e) => ({
      s: Math.round(e.startTime), d: Math.round(e.duration), b: Math.round(e.blockingDuration),
      // where the frame went: before rendering (tasks), style and layout, the rest of rendering (paint, commit)
      work: Math.round((e.renderStart || e.startTime + e.duration) - e.startTime),
      style: e.renderStart ? Math.round((e.styleAndLayoutStart || e.renderStart) - e.renderStart) : 0,
      layoutAndPaint: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : 0,
      scripts: e.scripts?.length ?? 0, inv: e.scripts?.map((x) => x.invoker).slice(0, 3),
    }), rec.loaf)
  },
  pause() { if (!rec || rec.pausedAt != null) return; gen++; rec.pausedAt = performance.now() },
  stop() {
    if (!rec) return null
    gen++
    rec.po.forEach((p) => p.disconnect())
    const inGap = (e) => rec.gaps.some(([a, b]) => e.s + e.d > a && e.s < b)
    const r = { t0: rec.t0, t1: performance.now(), raf: rec.raf, long: rec.long.filter((e) => !inGap(e)), loaf: rec.loaf.filter((e) => !inGap(e)), gaps: rec.gaps }
    rec = null
    return r
  },
}
window.__perf = perf
window.__tracker = tracker
window.__heights = heights
