// Board A: a plain CSS transform. The world is one div with translate() scale(); the transform is
// written to the DOM once per animation frame, React does not re-render while the board moves.
// Mouse drag and one finger pan, ctrl+wheel (trackpad pinch) and two fingers zoom, wheel pans —
// the same constants as @xyflow/react (d3-zoom), so the scripted gestures move both boards alike.
import { useLayoutEffect, useRef } from 'react'
import { FrameBox, params, useOpen } from './shared.jsx'

export default function BoardA({ layout, live, onReady, onSettle }) {
  const vpRef = useRef(null)
  const worldRef = useRef(null)
  const open = useOpen()
  const t = useRef({ x: 0, y: 0, zoom: 0.1 })

  useLayoutEffect(() => {
    const vp = vpRef.current, world = worldRef.current
    const isMac = navigator.userAgent.includes('Mac')
    let raf = 0, settle = 0
    const pointers = new Map()
    let pinch = null
    const apply = () => {
      raf = 0
      const { x, y, zoom } = t.current
      world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
      if (params.bg) { const s = 24 * zoom; vp.style.backgroundSize = `${s}px ${s}px`; vp.style.backgroundPosition = `${x}px ${y}px` }
    }
    const changed = (zooming = false) => {
      if (!raf) raf = requestAnimationFrame(apply)
      vp.classList.add('moving')
      if (zooming && params.hz) vp.classList.add('zooming')
      clearTimeout(settle)
      settle = setTimeout(() => { if (!pointers.size) { vp.classList.remove('moving', 'zooming'); onSettle?.({ ...t.current }) } }, 150)
    }
    const box = () => vp.getBoundingClientRect()
    const clamp = (z) => Math.min(2, Math.max(0.02, z))
    const zoomAt = (zoom, cx, cy) => {
      const r = box(), px = cx - r.left, py = cy - r.top
      const { x, y, zoom: z0 } = t.current
      const wx = (px - x) / z0, wy = (py - y) / z0, nz = clamp(zoom)
      t.current = { x: px - wx * nz, y: py - wy * nz, zoom: nz }
      changed(true)
    }
    const down = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // capture only once the pointer really moves: a click or a double click keeps its own target
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, cap: false })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], r = box()
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top
        const { x, y, zoom } = t.current
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom, wx: (mx - x) / zoom, wy: (my - y) / zoom }
      }
      vp.classList.add('moving')
    }
    const move = (e) => {
      const p = pointers.get(e.pointerId)
      if (!p) return
      if (!p.cap && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 3) { p.cap = true; try { vp.setPointerCapture(e.pointerId) } catch {} }
      if (pointers.size === 1) {
        t.current.x += e.clientX - p.x; t.current.y += e.clientY - p.y
        p.x = e.clientX; p.y = e.clientY
        changed()
        return
      }
      p.x = e.clientX; p.y = e.clientY
      if (!pinch) return
      const [a, b] = [...pointers.values()], r = box()
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top
      const nz = clamp(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)
      t.current = { x: mx - pinch.wx * nz, y: my - pinch.wy * nz, zoom: nz }
      changed(true)
    }
    const up = (e) => {
      if (!pointers.delete(e.pointerId)) return
      if (pointers.size < 2) pinch = null
      if (!pointers.size) changed()
    }
    const wheel = (e) => {
      e.preventDefault()
      if (e.ctrlKey) {
        const k = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * (isMac ? 10 : 1)
        zoomAt(t.current.zoom * Math.pow(2, k), e.clientX, e.clientY)
      } else {
        const n = e.deltaMode === 1 ? 20 : 1
        t.current.x -= e.deltaX * n * 0.5; t.current.y -= e.deltaY * n * 0.5
        changed()
      }
    }
    const dbl = (e) => { const fr = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.frame'); if (fr) open(fr.dataset.frame) }
    vp.addEventListener('pointerdown', down)
    vp.addEventListener('pointermove', move)
    vp.addEventListener('pointerup', up)
    vp.addEventListener('pointercancel', up)
    vp.addEventListener('wheel', wheel, { passive: false })
    vp.addEventListener('dblclick', dbl)
    const api = {
      getViewport: () => ({ ...t.current }),
      setViewport: (v) => { t.current = { x: v.x, y: v.y, zoom: v.zoom }; apply(); onSettle?.({ ...t.current }) },
      element: vp,
    }
    onReady(api)
    return () => {
      vp.removeEventListener('pointerdown', down); vp.removeEventListener('pointermove', move)
      vp.removeEventListener('pointerup', up); vp.removeEventListener('pointercancel', up)
      vp.removeEventListener('wheel', wheel); vp.removeEventListener('dblclick', dbl)
      cancelAnimationFrame(raf); clearTimeout(settle)
    }
  }, [])

  return (
    <div ref={vpRef} className={`board board-a pe-${params.pe}${params.bg ? ' dots' : ''}${params.hz ? ' hz' : ''}`}>
      <div ref={worldRef} className="world">
        {layout.frames.map((f) => <FrameBox key={f.id} f={f} live={live.has(f.id)} positioned />)}
      </div>
    </div>
  )
}
