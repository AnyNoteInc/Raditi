'use client'

import Box from '@mui/material/Box'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'

import {
  clampPaneWidth,
  paneWidthCss,
  SITE_PANE_COOKIE,
  SITE_PANE_MIN,
  SITE_PANE_WIDTH_VAR,
} from '@/components/site/site-nav'

import { toolText } from './chat-texts'

// The edge of the panel beside a dialog, dragged to make it wider or narrower (docs/plan/57-
// browser-tasks.md, Б29; one panel of the tools since docs/plan/59, И20): with a pointer, or with
// the arrow keys once focused. The width is written to the shell (a CSS variable both the panel
// and the room left for it read) while it moves, and kept for the viewer in a cookie when it stops.

/** One press of an arrow key moves the edge this far; with Shift, four times as far. */
export const PANE_STEP = 24

/** The width the panel has on the screen now, in whole pixels. */
const measured = (pane: HTMLElement | null) => Math.round(pane?.getBoundingClientRect().width ?? 0)

function remember(width: number) {
  // A year, the whole site, never sent anywhere else: a choice of layout, nothing personal.
  document.cookie = `${SITE_PANE_COOKIE}=${width}; path=/; max-age=31536000; samesite=lax`
}

export function PaneResizer({
  pane,
  label = toolText.separator,
}: {
  pane: RefObject<HTMLElement | null>
  /** The accessible name: the panel it widens. */
  label?: string
}) {
  // What the separator announces: the panel's width and the widest it may be, as measured.
  const [size, setSize] = useState<{ width: number; max: number } | null>(null)
  const drag = useRef<{ pointerId: number } | null>(null)

  const windowWidth = () => window.innerWidth
  const max = () => clampPaneWidth(Number.POSITIVE_INFINITY, windowWidth())

  // Measured whenever the panel or the window changes size — never on the server.
  useEffect(() => {
    const element = pane.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() =>
      setSize({
        width: measured(element),
        max: clampPaneWidth(Number.POSITIVE_INFINITY, window.innerWidth),
      }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [pane])

  function apply(next: number, keep: boolean) {
    const clamped = clampPaneWidth(next, windowWidth())
    const shell = pane.current?.closest<HTMLElement>('[data-site-shell]')
    shell?.style.setProperty(SITE_PANE_WIDTH_VAR, paneWidthCss(clamped))
    setSize({ width: clamped, max: max() })
    if (keep) remember(clamped)
  }

  const current = () => size?.width ?? measured(pane.current)

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? PANE_STEP * 4 : PANE_STEP
    let next: number | null = null
    // The edge is on the left of the panel: to the left makes it wider.
    if (event.key === 'ArrowLeft') next = current() + step
    else if (event.key === 'ArrowRight') next = current() - step
    else if (event.key === 'Home') next = max()
    else if (event.key === 'End') next = SITE_PANE_MIN
    if (next === null) return
    event.preventDefault()
    apply(next, true)
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { pointerId: event.pointerId }
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    const right = pane.current?.getBoundingClientRect().right ?? windowWidth()
    apply(right - event.clientX, false)
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    remember(current())
  }

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size?.width ?? SITE_PANE_MIN}
      aria-valuemin={SITE_PANE_MIN}
      aria-valuemax={size?.max ?? SITE_PANE_MIN}
      tabIndex={0}
      onKeyDown={keyDown}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      sx={{
        display: { xs: 'none', lg: 'flex' },
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: -12,
        width: 24,
        zIndex: 3,
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'col-resize',
        touchAction: 'none',
        outline: 'none',
        // The grip: a pill on the edge, stronger while it is held or focused.
        '&::after': {
          content: '""',
          width: 6,
          height: 44,
          borderRadius: '999px',
          bgcolor: 'divider',
          transition: 'background-color 120ms',
        },
        '&:hover::after, &:focus-visible::after': { bgcolor: 'primary.main' },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: -2,
        },
      }}
    />
  )
}
