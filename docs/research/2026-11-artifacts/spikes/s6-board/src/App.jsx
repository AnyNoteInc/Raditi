import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Divider, List, ListItemButton, ListItemText, Paper, ToggleButton, ToggleButtonGroup, Toolbar, Typography } from '@mui/material'
import BoardA from './board-a.jsx'
import BoardB from './board-b.jsx'
import PhoneList from './phone-list.jsx'
import { BoardCtx, autoCap, autoLive, fitViewport, fixedLive, layoutBoard, params, tracker } from './shared.jsx'

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
let resolveReady
const ready = new Promise((r) => { resolveReady = r })

export default function App() {
  const [screens, setScreens] = useState(null)
  const [focus, setFocus] = useState(null)
  const [zoom, setZoom] = useState(0)
  const [tool, setTool] = useState('hand')
  const apiRef = useRef(null)
  const layout = useMemo(() => (screens ? layoutBoard(screens) : null), [screens])
  const [live, setLive] = useState(() => new Set())

  useEffect(() => { fetch('/screens.json').then((r) => r.json()).then((m) => setScreens(m.screens)) }, [])
  useEffect(() => {
    if (!layout || fixedLive === null) return
    setLive(new Set(layout.frames.slice(0, fixedLive).map((f) => f.id)))
  }, [layout])

  const onSettle = useCallback((v) => {
    setZoom(v.zoom)
    if (autoCap === null || !layout || !apiRef.current) return
    const r = apiRef.current.element.getBoundingClientRect()
    const next = autoLive(layout.frames, v, r.width, r.height)
    setLive((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
  }, [layout])

  const onReady = useCallback((api) => {
    apiRef.current = api
    const el = api.element
    const fit = () => { const r = el.getBoundingClientRect(); return fitViewport(layoutRef.current.bounds, r.width, r.height) }
    window.__board = {
      impl: params.impl, params,
      frames: layoutRef.current?.frames.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) ?? [],
      getViewport: () => api.getViewport(),
      setViewport: (v) => api.setViewport(v),
      fit, fitAll: () => api.setViewport(fit()),
      rect: () => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } },
      liveIds: () => [...document.querySelectorAll('.board iframe[data-id], .phone-list iframe[data-id]')].map((x) => x.dataset.id),
      open: (id) => setFocus(id), close: () => setFocus(null), focused: () => focusRef.current,
      idle: () => tracker.idle().then(nextFrame),
      loads: () => tracker.done.slice(), swaps: () => tracker.swaps,
      ready,
    }
    if (params.impl !== 'list') api.setViewport(fit())
    // the board is full when every live frame fired load and every thumbnail decoded
    nextFrame().then(() => tracker.idle()).then(nextFrame).then(() => resolveReady({ t: performance.now(), loads: tracker.done.slice() }))
  }, [])
  const layoutRef = useRef(null); layoutRef.current = layout
  const focusRef = useRef(null); focusRef.current = focus

  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') setFocus(null) }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [])

  if (!layout) return null
  const f = focus ? layout.frames.find((x) => x.id === focus) : null
  const Board = params.impl === 'b' ? BoardB : BoardA
  const goTo = (s) => {
    const fr = layout.frames.find((x) => x.id === `${s.token}@1440`)
    const r = apiRef.current.element.getBoundingClientRect()
    apiRef.current.setViewport(fitViewport({ x: fr.x, y: fr.y - 60, w: 1440 + 100 + 390, h: Math.max(s.h1440, s.h390) }, r.width, r.height))
  }
  return (
    <BoardCtx.Provider value={{ onOpen: setFocus }}>
      <Box className="shell">
        <Paper square elevation={0} className="topbar">
          <Toolbar variant="dense" sx={{ gap: 1, minHeight: 52 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mr: 1, whiteSpace: 'nowrap' }}>Холст: новый сайт</Typography>
            <ToggleButtonGroup size="small" exclusive value={tool} onChange={(_, v) => v && setTool(v)} className="wide-only">
              <ToggleButton value="select">Выбор</ToggleButton>
              <ToggleButton value="hand">Рука</ToggleButton>
              <ToggleButton value="note">Заметка</ToggleButton>
              <ToggleButton value="comment">Комментарий</ToggleButton>
            </ToggleButtonGroup>
            <Box sx={{ flex: 1 }} />
            {params.impl !== 'list' && <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }} data-zoom>{Math.round(zoom * 100)}%</Typography>}
            <Button size="small" variant="outlined" className="wide-only">Новый экран</Button>
            <Button size="small" variant="contained">Опубликовать</Button>
          </Toolbar>
        </Paper>
        <Box className="main">
          {params.impl === 'list'
            ? <PhoneList screens={screens} onReady={onReady} />
            : <Board layout={layout} live={live} onReady={onReady} onSettle={onSettle} />}
          {params.impl !== 'list' && (
            <Paper square elevation={0} className="side wide-only">
              <Typography variant="overline" sx={{ px: 2, pt: 1, display: 'block' }}>Экраны</Typography>
              <Divider />
              <List dense>
                {screens.map((s) => (
                  <ListItemButton key={s.token} onClick={() => goTo(s)}>
                    <ListItemText primary={s.title} secondary="компьютер и телефон" />
                  </ListItemButton>
                ))}
              </List>
            </Paper>
          )}
        </Box>
        {f && (
          <div className="overlay" role="dialog" aria-label={f.screen.title}>
            <div className="overlay-head">
              <Typography variant="subtitle2" sx={{ flex: 1 }}>{f.screen.title} · {f.view === 1440 ? 'компьютер' : 'телефон'}</Typography>
              <Button size="small" onClick={() => setFocus(null)} data-close>Закрыть</Button>
            </div>
            <div className="overlay-body">
              <iframe data-id="overlay" title="Кадр" src={`${params.frames}/v/${f.screen.token}`}
                {...(params.sandbox ? { sandbox: params.sandbox } : {})}
                style={{ width: f.view === 1440 ? 'min(1440px, 100%)' : 'min(390px, 100%)' }} />
            </div>
          </div>
        )}
      </Box>
    </BoardCtx.Provider>
  )
}
