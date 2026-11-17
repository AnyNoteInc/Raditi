'use client'

import { browserViewports } from '@repo/domain/browser/session'
import type { BrowserInputEvent } from '@repo/domain/browser/stream-messages'
import { feedBrowserButtons } from '@repo/domain/tasks/client-feed-labels'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { createFramePainter, type FramePainter } from './browser-canvas'
import {
  ClickCounter,
  isApplePlatform,
  keyEventOf,
  mouseButtonOf,
  textEventsOf,
  viewportPointOf,
  wheelDelta,
} from './browser-input'
import { FileChooserDialog, PageDialog } from './browser-page-dialogs'
import {
  addressParts,
  BLANK_PAGE,
  paneOverlay,
  paneStatus,
  sessionLive,
  type PaneOverlay,
  type PaneStatus,
} from './browser-pane-model'
import { browserText } from './chat-texts'
import { offScreen } from './composer'
import type { FeedHeadState } from './feed-state'
import { StreamStatsLine } from './stream-stats-line'
import { Fling, TOUCH_SCROLL_SLOP_PX, WheelGatherer } from './touch-scroll'
import type { BrowserStream } from './use-browser-stream'

// The browser of a task beside its dialog (docs/plan/57-browser-tasks.md, Б12–Б17, Б27, Б29):
// the picture of the cloud browser's page, scaled to fit with margins, a toolbar with who drives
// it, «Взять управление» / «Продолжить работу агента» and «Остановить», and — while the client
// controls it from this tab — their mouse, wheel, keys and text sent to the page.

/** The colours of the chip by the state, in the theme's own palette. */
const chipTone: Readonly<Record<PaneStatus, { bg: string; fg: string; dot?: boolean }>> = {
  notStarted: { bg: 'action.hover', fg: 'text.secondary' },
  connecting: { bg: 'action.hover', fg: 'text.secondary' },
  agent: { bg: 'action.hover', fg: 'text.primary', dot: true },
  waiting: { bg: 'warning.main', fg: 'warning.contrastText' },
  idle: { bg: 'action.hover', fg: 'text.primary' },
  rewound: { bg: 'action.hover', fg: 'text.primary' },
  user: { bg: 'primary.main', fg: 'primary.contrastText' },
  reconnecting: { bg: 'action.hover', fg: 'text.secondary' },
  error: { bg: 'error.main', fg: 'error.contrastText' },
  closed: { bg: 'action.selected', fg: 'text.secondary' },
  finished: { bg: 'action.selected', fg: 'text.primary' },
}

function StatusChip({ status, id }: { status: PaneStatus; id: string }) {
  const tone = chipTone[status]
  return (
    <Box
      id={id}
      role="status"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        minHeight: 32,
        px: 1.5,
        borderRadius: '999px',
        bgcolor: tone.bg,
        color: tone.fg,
        fontSize: 13.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {tone.dot ? (
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: 'primary.main',
            '@media (prefers-reduced-motion: no-preference)': {
              animation: 'raditi-pulse 1.6s ease-in-out infinite',
              '@keyframes raditi-pulse': { '50%': { opacity: 0.35 } },
            },
          }}
        />
      ) : status === 'finished' ? (
        <AppIcon name="check" size={14} />
      ) : null}
      {browserText.status[status]}
    </Box>
  )
}

/** Covers the picture: why there is none, or what the agent asks of the client. */
function Overlay({
  overlay,
  onRetry,
  onTake,
  canTake,
}: {
  overlay: PaneOverlay
  onRetry: () => void
  onTake: () => void
  canTake: boolean
}) {
  if (overlay.kind === 'none') return null
  if (overlay.kind === 'reconnecting') {
    return (
      <Box
        role="status"
        sx={{
          position: 'absolute',
          left: 12,
          right: 12,
          top: 12,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.25,
          p: 1.5,
          borderRadius: '12px',
          bgcolor: 'background.paper',
          boxShadow: 3,
        }}
      >
        <CircularProgress size={16} aria-hidden="true" sx={{ mt: 0.25, flex: 'none' }} />
        <Box>
          <Typography sx={{ fontWeight: 600 }}>{browserText.reconnecting}</Typography>
          <Typography variant="body2" color="text.secondary">
            {browserText.reconnectingNote}
          </Typography>
        </Box>
      </Box>
    )
  }
  const card = (children: ReactNode, role: 'status' | 'alert' = 'status') => (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        bgcolor: 'background.default',
      }}
    >
      <Box
        role={role}
        sx={{
          maxWidth: 420,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 1.25,
        }}
      >
        {children}
      </Box>
    </Box>
  )
  switch (overlay.kind) {
    case 'starting':
      return card(<Typography color="text.secondary">{browserText.starting}</Typography>)
    case 'neverStarted':
      return card(<Typography color="text.secondary">{browserText.neverStarted}</Typography>)
    case 'connecting':
      return card(
        <>
          <CircularProgress size={22} aria-hidden="true" />
          <Typography>{browserText.connecting}</Typography>
        </>,
      )
    case 'failed':
      return card(
        <>
          <AppIcon name="warning" size={24} />
          <Typography sx={{ fontWeight: 600 }}>{browserText.failed}</Typography>
          <Typography variant="body2" color="text.secondary">
            {browserText.failedNote}
          </Typography>
          <Button variant="outlined" onClick={onRetry} sx={{ minHeight: 44 }}>
            {browserText.retry}
          </Button>
        </>,
        'alert',
      )
    case 'closed':
      return card(
        <>
          <AppIcon name="lock" size={24} />
          <Typography sx={{ fontWeight: 600 }}>{overlay.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {overlay.note}
          </Typography>
        </>,
      )
    case 'help':
      return (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 2,
            bgcolor: 'rgba(36, 23, 16, 0.42)',
          }}
        >
          <Box
            role="status"
            sx={{
              maxWidth: 420,
              p: { xs: 2, sm: 3 },
              borderRadius: '14px',
              bgcolor: 'background.paper',
              boxShadow: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 1.25,
            }}
          >
            <Typography component="h3" sx={{ fontSize: 18, fontWeight: 600 }}>
              {browserText.help[overlay.reason]}
            </Typography>
            {overlay.message ? (
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {overlay.message}
              </Typography>
            ) : null}
            <Typography>{browserText.helpNote}</Typography>
            <Typography variant="body2" color="text.secondary">
              {browserText.helpSecret}
            </Typography>
            {canTake ? (
              <Button variant="contained" onClick={onTake} sx={{ alignSelf: 'flex-start' }}>
                {feedBrowserButtons.take}
              </Button>
            ) : null}
          </Box>
        </Box>
      )
  }
}

/** The address of the page: read-only under the agent, a field the client may go by. */
function Address({
  url,
  editable,
  onNavigate,
  onReload,
}: {
  url: string
  editable: boolean
  onNavigate: (url: string) => void
  onReload: () => void
}) {
  const fieldId = useId()
  // The browser of a chat without a project starts with no page: the client types the first one
  // (docs/plan/61-chats-first.md, К13), and there is nothing to read, to edit or to load again.
  const blank = url === BLANK_PAGE
  const page = blank ? '' : url
  const parts = addressParts(page)
  const [draft, setDraft] = useState<string | null>(null)
  const icon = (
    <AppIcon
      name={blank || parts?.secure === false ? 'globe' : 'lock'}
      size={16}
      style={{ opacity: 0.7 }}
    />
  )
  if (!editable) {
    return (
      <Box
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minHeight: 40,
          px: 1.5,
          borderRadius: '999px',
          bgcolor: 'action.hover',
          fontSize: 14,
        }}
      >
        {icon}
        <Box
          component="span"
          aria-label={browserText.address}
          translate="no"
          sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {parts ? (
            <>
              <Box component="span" sx={{ fontWeight: 600 }}>
                {parts.host}
              </Box>
              <Box component="span" sx={{ color: 'text.secondary' }}>
                {parts.rest}
              </Box>
            </>
          ) : (
            page
          )}
        </Box>
      </Box>
    )
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const target = (draft ?? page).trim()
    if (target !== '')
      onNavigate(/^[a-z][a-z\d+.-]*:\/\//i.test(target) ? target : `https://${target}`)
    setDraft(null)
  }
  return (
    <Box
      component="form"
      onSubmit={submit}
      sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.5 }}
    >
      <IconButton
        aria-label={browserText.reload}
        onClick={onReload}
        disabled={blank}
        sx={{ width: 44, height: 44 }}
      >
        <AppIcon name="retry" size={18} />
      </IconButton>
      <Box
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          minHeight: 44,
          px: 1.5,
          borderRadius: '999px',
          border: 1,
          borderColor: 'primary.main',
        }}
      >
        {icon}
        <Box component="label" htmlFor={fieldId} sx={offScreen}>
          {browserText.address}
        </Box>
        <Box
          component="input"
          id={fieldId}
          value={draft ?? page}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onBlur={() => setDraft(null)}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            minHeight: 42,
            border: 0,
            outline: 'none',
            bgcolor: 'transparent',
            color: 'text.primary',
            font: 'inherit',
            fontSize: 14,
          }}
        />
      </Box>
      <Box component="button" type="submit" sx={offScreen}>
        {browserText.go}
      </Box>
    </Box>
  )
}

/** Narrower than this, with a finger for a pointer, is a phone (ТР11). */
const PHONE_MAX_WIDTH = 600
const PHONE_QUERY = `(pointer: coarse) and (max-width: ${PHONE_MAX_WIDTH - 0.05}px)`

/** This device is a phone now: a finger and a narrow screen; follows a turn of the screen. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE_QUERY)
    const changed = () => setPhone(query.matches)
    changed()
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  return phone
}

export interface BrowserPaneProps {
  taskId: string
  head: FeedHeadState | null
  stream: BrowserStream
  /** The cabinet knows where the stream is. */
  configured: boolean
  /** The panel is on the screen: the picture is drawn and input taken only then. */
  visible: boolean
  fullscreen: boolean
  onFullscreen: (next: boolean) => void
  /** «Взять управление». */
  onTake: () => void
  /** «Продолжить работу агента»: released on the stream or `task.resumeAgent`, by the status. */
  onResume: () => void
  /** A closed project: the browser is only looked at, its control is neither taken nor given (К39). */
  readOnly?: boolean
  /** «Остановить»: `/cancel` with its confirmation. */
  onStop: () => void
  canStop: boolean
  /** «Остановить» was taken and core has not ended the task yet: the control is not offered. */
  stopping?: boolean
  busy: boolean
  /** The agent answered and asked nothing (26.10.2026): the browser waits for no one. */
  answered?: boolean
  /** `/undo` left it so: there is no answer to speak of. */
  rewound?: boolean
}

/** One input of the client, stamped with what the latest state says. */
type Send = (event: BrowserInputEvent) => void

export function BrowserPane({
  taskId,
  head,
  stream,
  configured,
  visible,
  fullscreen,
  onFullscreen,
  onTake,
  onResume,
  readOnly = false,
  onStop,
  canStop,
  stopping = false,
  busy,
  answered = false,
  rewound = false,
}: BrowserPaneProps) {
  const chipId = useId()
  const hintId = useId()
  const session = head?.browser ?? null
  const taskStatus = head?.task.status
  const state = stream.state
  const live = sessionLive(session)
  const holding = stream.holding
  const manual = holding && state !== null && state.manualReady && state.pageId !== null

  // A phone that drives a window of a computer is offered the site's mobile version; the window
  // itself does not change by itself — the agent works in the same one (docs/plan/85, ТР11).
  const phone = usePhone()
  const [hintClosedFor, setHintClosedFor] = useState<string | null>(null)
  const phoneWindow = browserViewports.find((size) => size.width < PHONE_MAX_WIDTH) ?? null
  const mobileHint =
    manual &&
    phone &&
    state !== null &&
    state.viewport.width >= PHONE_MAX_WIDTH &&
    hintClosedFor !== state.session
  const controller = state?.controller ?? session?.controller ?? 'agent'
  const otherTab = live && controller === 'user' && stream.connection === 'open' && !holding
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const keyboardRef = useRef<HTMLTextAreaElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const painterRef = useRef<FramePainter | null>(null)
  const [painted, setPainted] = useState(false)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [tabsMenu, setTabsMenu] = useState<HTMLElement | null>(null)

  const facts = {
    session,
    taskStatus,
    connection: stream.connection,
    state,
    configured,
    answered,
    rewound,
  }
  const status = paneStatus(facts)
  const overlay = paneOverlay({ ...facts, painted, endReason: stream.endReason })

  // The canvas draws while the panel is shown; its size follows the panel.
  const { setPainter } = stream
  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!visible || canvas === null || stage === null) return
    const painter = createFramePainter(canvas)
    const wrapped: FramePainter = {
      ...painter,
      paint: async (frame) => {
        const drawn = await painter.paint(frame)
        if (drawn) setPainted(true)
        return drawn
      },
    }
    painterRef.current = wrapped
    setPainter(wrapped)
    const fit = () => {
      const box = stage.getBoundingClientRect()
      painter.resize(box.width, box.height, window.devicePixelRatio || 1)
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(stage)
    return () => {
      observer?.disconnect()
      setPainter(null)
      painterRef.current = null
      painter.dispose()
    }
  }, [visible, setPainter])

  // Every input carries the page, the epoch of control and the window size of the latest state.
  const latest = useRef(state)
  useEffect(() => {
    latest.current = state
  }, [state])
  const send: Send = (event) => {
    const now = latest.current
    // Only this tab's own control lets input through: under the agent nothing is sent at all.
    if (!manual || now === null || now.pageId === null) return
    stream.send({
      t: 'input',
      pageId: now.pageId,
      controlEpoch: now.controlEpoch,
      viewportVersion: now.viewportVersion,
      event,
    })
  }

  // --- Pointer --------------------------------------------------------------------------------
  const clicks = useRef(new ClickCounter())
  const pressed = useRef<{
    button: 'left' | 'middle' | 'right'
    clickCount: number
    x: number
    y: number
  } | null>(null)
  const move = useRef<{ x: number; y: number } | null>(null)
  const frame = useRef<number | null>(null)
  const touches = useRef(
    new Map<
      number,
      { x: number; y: number; startX: number; startY: number; at: number; scrolling: boolean }
    >(),
  )
  const pinch = useRef(false)

  // The wheel, one finger and two fingers scroll through one gatherer, one event an animation
  // frame (docs/plan/85-browser-stream-mobile.md, ТР5, ТР6); a finger let go coasts on.
  const wheelGather = useRef(new WheelGatherer())
  const wheelFrame = useRef<number | null>(null)
  const fling = useRef(new Fling())
  const flingFrame = useRef<number | null>(null)

  /** Pixels of the panel as pixels of the browser's window. */
  const windowScale = () => painterRef.current?.rect(latest.current?.viewport).scale ?? 0

  const flushWheel = () => {
    wheelFrame.current = null
    const step = wheelGather.current.take()
    if (step !== null) sendRef.current({ kind: 'wheel', ...step })
  }

  /** A scroll of `dx`, `dy` window pixels aimed at `point`, sent with the next animation frame. */
  const queueWheel = (point: { x: number; y: number }, dx: number, dy: number) => {
    wheelGather.current.add(point, dx, dy)
    if (wheelFrame.current === null) wheelFrame.current = requestAnimationFrame(flushWheel)
  }

  const stopFling = () => {
    const coasting = fling.current.active || flingFrame.current !== null
    fling.current.stop()
    if (flingFrame.current !== null) cancelAnimationFrame(flingFrame.current)
    flingFrame.current = null
    // The step of the coast not sent yet stays unsent: the page stops where the finger found it.
    if (!coasting) return
    wheelGather.current.clear()
    if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = null
  }

  /** The page goes on by itself after the finger, aimed where the finger left it. */
  const coast = (point: { x: number; y: number }) => {
    const tick = (at: number) => {
      flingFrame.current = null
      const step = fling.current.step(at)
      if (step === null || !manualRef.current) return
      queueWheel(point, step.dx, step.dy)
      flingFrame.current = requestAnimationFrame(tick)
    }
    flingFrame.current = requestAnimationFrame(tick)
  }

  useEffect(
    () => () => {
      if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current)
      if (flingFrame.current !== null) cancelAnimationFrame(flingFrame.current)
    },
    [],
  )

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    const painter = painterRef.current
    const now = latest.current
    if (canvas === null || painter === null || now === null) return null
    return viewportPointOf(
      event,
      canvas.getBoundingClientRect(),
      painter.rect(now.viewport),
      now.viewport,
    )
  }

  const flushMove = () => {
    frame.current = null
    const point = move.current
    move.current = null
    if (point)
      send({ kind: 'mouse', type: 'move', x: point.x, y: point.y, button: 'none', clickCount: 0 })
  }

  const releaseAll = () => {
    const down = pressed.current
    pressed.current = null
    if (down)
      send({
        kind: 'mouse',
        type: 'up',
        x: down.x,
        y: down.y,
        button: down.button,
        clickCount: down.clickCount,
      })
    for (const event of heldKeys.current.values()) send({ ...event, type: 'up' })
    heldKeys.current.clear()
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!manual) return
    if (event.pointerType === 'touch') {
      // A touch stops a page that coasts, where it is.
      stopFling()
      touches.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        at: event.timeStamp,
        scrolling: false,
      })
      if (touches.current.size > 1) pinch.current = true
      return
    }
    const point = pointOf(event)
    const button = mouseButtonOf(event.button)
    if (point === null || button === null) return
    event.preventDefault()
    keyboardRef.current?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const clickCount = clicks.current.next(point, button, event.timeStamp)
    pressed.current = { button, clickCount, ...point }
    send({ kind: 'mouse', type: 'move', ...point, button: 'none', clickCount: 0 })
    send({ kind: 'mouse', type: 'down', ...point, button, clickCount })
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!manual) return
    if (event.pointerType === 'touch') {
      const touch = touches.current.get(event.pointerId)
      if (!touch) return
      if (touches.current.size >= 2) {
        // Two fingers move the page: the wheel, by how far their middle moved.
        const before = centre(touches.current)
        touch.x = event.clientX
        touch.y = event.clientY
        const after = centre(touches.current)
        const point = pointOf(after)
        const scale = windowScale()
        if (point !== null && scale > 0)
          queueWheel(
            point,
            (before.clientX - after.clientX) / scale,
            (before.clientY - after.clientY) / scale,
          )
        return
      }
      // One finger moved past the slop scrolls the page, as on a phone, and no longer clicks.
      if (
        !pinch.current &&
        !touch.scrolling &&
        Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) >
          TOUCH_SCROLL_SLOP_PX
      )
        touch.scrolling = true
      const before = { clientX: touch.x, clientY: touch.y }
      touch.x = event.clientX
      touch.y = event.clientY
      if (!touch.scrolling) return
      const point = pointOf(event)
      const scale = windowScale()
      if (point === null || scale <= 0) return
      const dx = (before.clientX - event.clientX) / scale
      const dy = (before.clientY - event.clientY) / scale
      fling.current.moved(dx, dy, event.timeStamp)
      queueWheel(point, dx, dy)
      return
    }
    const point = pointOf(event)
    if (point === null) return
    if (pressed.current) Object.assign(pressed.current, point)
    move.current = point
    if (frame.current === null) frame.current = requestAnimationFrame(flushMove)
  }

  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === 'touch') {
      const touch = touches.current.get(event.pointerId)
      touches.current.delete(event.pointerId)
      if (!manual || !touch) return
      const wasPinch = pinch.current
      if (touches.current.size === 0) pinch.current = false
      // A swipe let go goes on by itself, aimed where the finger left the page.
      if (touch.scrolling && !wasPinch) {
        const point = pointOf(event)
        if (point !== null && fling.current.release(event.timeStamp)) coast(point)
        return
      }
      // A tap is a click: one finger, short, hardly moved.
      const moved = Math.hypot(touch.x - touch.startX, touch.y - touch.startY)
      if (wasPinch || moved > TOUCH_SCROLL_SLOP_PX || event.timeStamp - touch.at > 600) return
      const point = pointOf({ clientX: touch.startX, clientY: touch.startY })
      if (point === null) return
      send({ kind: 'mouse', type: 'move', ...point, button: 'none', clickCount: 0 })
      send({ kind: 'mouse', type: 'down', ...point, button: 'left', clickCount: 1 })
      send({ kind: 'mouse', type: 'up', ...point, button: 'left', clickCount: 1 })
      return
    }
    const down = pressed.current
    if (!down) return
    pressed.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      flushMove()
    }
    const point = pointOf(event) ?? { x: down.x, y: down.y }
    send({ kind: 'mouse', type: 'up', ...point, button: down.button, clickCount: down.clickCount })
  }

  function pointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    touches.current.delete(event.pointerId)
    if (touches.current.size === 0) pinch.current = false
    const down = pressed.current
    if (!down) return
    pressed.current = null
    send({
      kind: 'mouse',
      type: 'up',
      x: down.x,
      y: down.y,
      button: down.button,
      clickCount: down.clickCount,
    })
  }

  // The wheel cannot be held back by a passive listener: this one is not passive.
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })
  const manualRef = useRef(manual)
  useEffect(() => {
    manualRef.current = manual
  }, [manual])
  const queueWheelRef = useRef(queueWheel)
  useEffect(() => {
    queueWheelRef.current = queueWheel
  })
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const wheel = (event: WheelEvent) => {
      const painter = painterRef.current
      const now = latest.current
      if (!manualRef.current || painter === null || now === null) return
      const rect = painter.rect(now.viewport)
      const point = viewportPointOf(event, canvas.getBoundingClientRect(), rect, now.viewport)
      if (point === null) return
      event.preventDefault()
      const { dx, dy } = wheelDelta(event, now.viewport, rect.scale)
      if (dx !== 0 || dy !== 0) queueWheelRef.current(point, dx, dy)
    }
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [visible])

  // --- Keys and text --------------------------------------------------------------------------
  const heldKeys = useRef(new Map<string, Extract<BrowserInputEvent, { kind: 'key' }>>())
  const composing = useRef(false)
  const lastEscape = useRef(-Infinity)

  function keyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!manual) return
    // Esc twice in a row leaves the page for the buttons above it (WCAG 2.1.2): every other key,
    // Tab too, belongs to the page. The first Esc still reaches it.
    if (
      event.key === 'Escape' &&
      !event.repeat &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      if (event.timeStamp - lastEscape.current <= LEAVE_KEYS_MS) {
        lastEscape.current = -Infinity
        event.preventDefault()
        toolbarRef.current?.focus()
        return
      }
      lastEscape.current = event.timeStamp
    }
    const key = keyEventOf(keyOf(event), 'down', isApplePlatform())
    if (key === null || key.kind !== 'key') return
    event.preventDefault()
    heldKeys.current.set(event.code || event.key, key)
    send(key)
  }

  function keyUp(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const id = event.code || event.key
    const held = heldKeys.current.get(id)
    if (!held) return
    heldKeys.current.delete(id)
    if (manual) send({ ...held, type: 'up' })
  }

  function typed(text: string) {
    for (const event of textEventsOf(text)) send(event)
  }

  // Nothing stays held when the focus or the page goes; the browser lets go too (Б17).
  const releaseAllRef = useRef(releaseAll)
  useEffect(() => {
    releaseAllRef.current = releaseAll
  })
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') releaseAllRef.current()
    }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [])
  useEffect(() => {
    if (!manual) {
      pressed.current = null
      heldKeys.current.clear()
    }
  }, [manual])

  // --- Commands -------------------------------------------------------------------------------
  const tabs = state?.tabs ?? []
  const currentTab = tabs.findIndex((tab) => tab.pageId === state?.pageId)
  const url = state?.url ?? ''
  const refusal = stream.refusal
  const refusalText =
    refusal === null || refusal.reason.startsWith('stale_') || refusal.reason === 'outside_viewport'
      ? null
      : refusal.reason === 'address_denied'
        ? browserText.refused.address_denied_public
        : ((browserText.refused as Record<string, string>)[refusal.reason] ??
          browserText.refused.other)
  const showTake = !readOnly && live && !holding && status !== 'error'
  const showResume = !readOnly && live && holding

  const takeButton = (
    <Button
      variant="outlined"
      onClick={onTake}
      disabled={busy || stopping || stream.connection !== 'open'}
      sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
    >
      {feedBrowserButtons.take}
    </Button>
  )
  const resumeButton = (
    <Button
      variant="contained"
      onClick={onResume}
      disabled={busy || stopping}
      sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
    >
      {feedBrowserButtons.resume}
    </Button>
  )
  const stopButton = (
    <Button
      color="error"
      onClick={onStop}
      disabled={!canStop}
      sx={{ minHeight: 44, whiteSpace: 'nowrap' }}
    >
      {feedBrowserButtons.stop}
    </Button>
  )

  return (
    <Box sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box
        ref={toolbarRef}
        role="toolbar"
        aria-label={browserText.toolbar}
        // Where Esc twice leaves the page for; the next Tab goes on to its buttons.
        tabIndex={-1}
        sx={{
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          px: { xs: 1.5, sm: 2 },
          py: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box
          sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 44, flexWrap: 'wrap' }}
        >
          <StatusChip status={status} id={chipId} />
          {stopping ? (
            <Typography variant="body2" color="text.secondary">
              {browserText.stopping}
            </Typography>
          ) : otherTab ? (
            <Typography variant="body2" color="text.secondary">
              {browserText.otherTab}
            </Typography>
          ) : null}
          <Box sx={{ flex: '1 1 auto' }} />
          <Box sx={{ display: { xs: 'none', sm: 'flex' }, alignItems: 'center', gap: 1 }}>
            {showResume ? resumeButton : showTake ? takeButton : null}
            {live && !holding ? stopButton : null}
          </Box>
          <IconButton
            aria-label={fullscreen ? browserText.exitFullscreen : browserText.fullscreen}
            aria-pressed={fullscreen}
            onClick={() => onFullscreen(!fullscreen)}
            // A phone turned to portrait while the browser is over the content still has its way
            // back: «Свернуть» stays.
            sx={{
              width: 44,
              height: 44,
              display: { xs: fullscreen ? 'inline-flex' : 'none', sm: 'inline-flex' },
            }}
          >
            <AppIcon name={fullscreen ? 'shrink' : 'fullscreen'} size={20} />
          </IconButton>
          <IconButton
            aria-label={browserText.more}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => setMenu(event.currentTarget)}
            sx={{ width: 44, height: 44 }}
          >
            <AppIcon name="more" size={20} />
          </IconButton>
          {/* The height of an item is given by breakpoint: MUI lets a menu item shrink to its
              content from `sm` up by a media query of its own, which wins over a plain value — an
              item stays 44px high, a finger's (DESIGN.md), on every width. */}
          <Menu anchorEl={menu} open={menu !== null} onClose={() => setMenu(null)}>
            {holding && live ? (
              <MenuItem
                disabled={!canStop}
                onClick={() => {
                  setMenu(null)
                  onStop()
                }}
                sx={{ minHeight: { xs: 44 }, color: 'error.main' }}
              >
                {feedBrowserButtons.stop}
              </MenuItem>
            ) : null}
            <MenuItem disabled sx={{ minHeight: 36, fontSize: 13, opacity: '1 !important' }}>
              {manual ? browserText.windowSize : browserText.windowSizeLocked}
            </MenuItem>
            {browserViewports.map((size) => {
              const current =
                state?.viewport.width === size.width && state.viewport.height === size.height
              return (
                <MenuItem
                  key={`${size.width}x${size.height}`}
                  selected={current}
                  disabled={!manual}
                  onClick={() => {
                    setMenu(null)
                    if (!current)
                      stream.send({ t: 'viewport', width: size.width, height: size.height })
                  }}
                  sx={{ minHeight: { xs: 44 } }}
                >
                  {browserText.size(size.width, size.height)}
                </MenuItem>
              )
            })}
          </Menu>
        </Box>
        {live && url !== '' ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {tabs.length > 1 ? (
              <>
                <Button
                  variant="outlined"
                  aria-haspopup="menu"
                  aria-expanded={tabsMenu !== null}
                  onClick={(event) => setTabsMenu(event.currentTarget)}
                  endIcon={<AppIcon name="down" size={16} />}
                  sx={{ minHeight: 44, flex: 'none', whiteSpace: 'nowrap' }}
                >
                  {browserText.tabOf(Math.max(1, currentTab + 1), tabs.length)}
                </Button>
                <Menu
                  anchorEl={tabsMenu}
                  open={tabsMenu !== null}
                  onClose={() => setTabsMenu(null)}
                  aria-label={browserText.tabs}
                >
                  {tabs.map((tab, index) => (
                    <MenuItem
                      key={tab.pageId}
                      selected={index === currentTab}
                      disabled={!manual}
                      onClick={() => {
                        setTabsMenu(null)
                        if (index !== currentTab) stream.send({ t: 'tab', pageId: tab.pageId })
                      }}
                      sx={{ minHeight: { xs: 44 }, maxWidth: 360 }}
                    >
                      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {tab.title || browserText.untitledTab}
                      </Box>
                    </MenuItem>
                  ))}
                </Menu>
              </>
            ) : null}
            <Address
              url={url}
              editable={manual}
              onNavigate={(target) => stream.send({ t: 'navigate', url: target })}
              onReload={() => stream.send({ t: 'navigate', url })}
            />
          </Box>
        ) : null}
        {refusalText ? (
          <Typography key={refusal?.seq} role="status" variant="body2" color="text.secondary">
            {refusalText}
          </Typography>
        ) : null}
      </Box>

      <Box
        ref={stageRef}
        sx={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 240,
          overflow: 'hidden',
          bgcolor: 'action.hover',
          ...(manual && {
            outline: '3px solid',
            outlineColor: 'primary.main',
            outlineOffset: '-3px',
          }),
        }}
      >
        <Box
          component="canvas"
          ref={canvasRef}
          role="img"
          aria-label={browserText.canvas}
          aria-describedby={chipId}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}
          onLostPointerCapture={pointerCancel}
          onContextMenu={(event: ReactMouseEvent) => {
            if (manual) event.preventDefault()
          }}
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            display: 'block',
            cursor: manual ? 'default' : 'not-allowed',
            touchAction: manual ? 'none' : 'auto',
          }}
        />
        <StreamStatsLine read={stream.liveStats} />
        {/* The keys and the text of the client: a field the page cannot see, focused on a click. */}
        <Box
          component="textarea"
          ref={keyboardRef}
          aria-label={browserText.keyboardInput}
          aria-describedby={hintId}
          tabIndex={manual ? 0 : -1}
          disabled={!manual}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={keyDown}
          onKeyUp={keyUp}
          onInput={(event: FormEvent<HTMLTextAreaElement>) => {
            const field = event.currentTarget
            if (composing.current || (event.nativeEvent as InputEvent).isComposing) return
            if (field.value !== '') typed(field.value)
            field.value = ''
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
            composing.current = false
            const field = event.currentTarget
            const text = field.value !== '' ? field.value : event.data
            if (text) typed(text)
            field.value = ''
          }}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            event.preventDefault()
            if (manual) typed(event.clipboardData.getData('text/plain'))
          }}
          onBlur={() => releaseAll()}
          sx={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width: 1,
            height: 1,
            p: 0,
            border: 0,
            opacity: 0,
            resize: 'none',
            pointerEvents: 'none',
          }}
        />
        {!manual && live && stream.connection === 'open' && overlay.kind === 'none' ? (
          <Box
            aria-hidden="true"
            sx={{
              position: 'absolute',
              left: 12,
              bottom: 12,
              px: 1.25,
              py: 0.5,
              borderRadius: '999px',
              bgcolor: 'background.paper',
              boxShadow: 2,
              fontSize: 12.5,
              color: 'text.secondary',
            }}
          >
            {browserText.viewOnly}
          </Box>
        ) : null}
        <Overlay
          overlay={overlay}
          onRetry={stream.retry}
          onTake={onTake}
          canTake={showTake && stream.connection === 'open' && !busy && !stopping}
        />
      </Box>

      {mobileHint && phoneWindow ? (
        <Box
          data-testid="browser-mobile-hint"
          sx={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            pl: 2,
            pr: 0.5,
            py: 0.5,
            borderTop: 1,
            borderColor: 'divider',
            fontSize: 13.5,
          }}
        >
          <Box sx={{ flex: '1 1 auto' }}>{browserText.mobileHint}</Box>
          <Button
            size="small"
            onClick={() =>
              stream.send({ t: 'viewport', width: phoneWindow.width, height: phoneWindow.height })
            }
            sx={{ flex: 'none', minHeight: 44 }}
          >
            {browserText.mobileHintAction}
          </Button>
          <IconButton
            aria-label={browserText.mobileHintClose}
            onClick={() => setHintClosedFor(state?.session ?? null)}
            sx={{ flex: 'none', width: 44, height: 44 }}
          >
            <AppIcon name="close" size={18} />
          </IconButton>
        </Box>
      ) : null}

      {manual ? (
        <Box
          id={hintId}
          sx={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 1,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            fontSize: 13.5,
          }}
        >
          <AppIcon name="pointer" size={16} />
          {browserText.manualHint}
        </Box>
      ) : (
        <Box id={hintId} sx={offScreen}>
          {browserText.manualHint}
        </Box>
      )}

      {live ? (
        <Box
          sx={{
            display: { xs: 'flex', sm: 'none' },
            flex: 'none',
            flexWrap: 'wrap',
            gap: 1,
            p: 1.5,
            borderTop: 1,
            borderColor: 'divider',
            '& > *': { flex: '1 1 auto' },
          }}
        >
          {holding ? null : stopButton}
          {manual ? (
            <Button
              variant="outlined"
              startIcon={<AppIcon name="keyboard" size={18} />}
              onClick={() => keyboardRef.current?.focus()}
              sx={{ minHeight: 44 }}
            >
              {browserText.keyboard}
            </Button>
          ) : null}
          {showResume ? resumeButton : showTake ? takeButton : null}
        </Box>
      ) : null}

      {holding && state?.dialog ? (
        <PageDialog
          key={state.dialog.id}
          dialog={state.dialog}
          onAnswer={(accept, text) =>
            stream.send({
              t: 'dialog',
              id: state.dialog!.id,
              accept,
              ...(text === undefined ? {} : { text }),
            })
          }
        />
      ) : null}
      {holding && state?.chooser && !state.dialog ? (
        <FileChooserDialog
          key={state.chooser.id}
          chooser={state.chooser}
          taskId={taskId}
          onAnswer={(attachmentIds) =>
            stream.send({ t: 'files', chooserId: state.chooser!.id, attachmentIds })
          }
        />
      ) : null}
    </Box>
  )
}

/** The middle of the fingers on the screen. */
function centre(touches: ReadonlyMap<number, { x: number; y: number }>): {
  clientX: number
  clientY: number
} {
  let x = 0
  let y = 0
  for (const touch of touches.values()) {
    x += touch.x
    y += touch.y
  }
  const count = Math.max(1, touches.size)
  return { clientX: x / count, clientY: y / count }
}

/** Two Esc presses this close leave the page for the toolbar. */
const LEAVE_KEYS_MS = 800

/** The parts of a keyboard event the mapping reads. */
const keyOf = (event: ReactKeyboardEvent) => ({
  key: event.key,
  code: event.code,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  isComposing: event.nativeEvent.isComposing,
  keyCode: event.keyCode,
  altGraph: event.getModifierState('AltGraph'),
})
