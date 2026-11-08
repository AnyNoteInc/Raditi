'use client'

import Box from '@mui/material/Box'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import {
  CABINET_PANEL_DEFAULT_WIDTH,
  CABINET_PANEL_MAX_WIDTH,
  CABINET_PANEL_MIN_WIDTH,
  clampCabinetPanelWidth,
  serializeCabinetPanelWidthCookie,
} from '@/lib/cabinet-panel'

// The right edge of the panel beside the rail, dragged to make it wider or narrower
// (docs/plan/64-cabinet-navigation.md, owner's answer of 07.11.2026): with a pointer, or with the
// arrow keys once focused, as the edge of the panel of a chat's tools. The width is written to the
// shell (`--cabinet-panel-width`, which the panel and the room left for it read) while it moves,
// and kept for the viewer in a cookie when it stops.

/** One press of an arrow key moves the edge this far; with Shift, four times as far. */
export const PANEL_STEP = 16

export const PANEL_WIDTH_VAR = '--cabinet-panel-width'

const panelOf = (edge: HTMLElement | null) => edge?.parentElement ?? null
const measured = (edge: HTMLElement | null) =>
  Math.round(panelOf(edge)?.getBoundingClientRect().width ?? 0)

function remember(width: number) {
  document.cookie = serializeCabinetPanelWidthCookie(width, {
    secure: window.location.protocol === 'https:',
  })
}

/** Put it as the last child of the panel: it stands on the panel's right edge, from `md`. */
export function PanelResizer({ label = 'Ширина левой панели' }: { label?: string }) {
  const edge = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  const drag = useRef<{ pointerId: number } | null>(null)

  // The width the separator announces: measured whenever the panel changes size — never on the
  // server, which announces the default until then.
  useEffect(() => {
    const panel = panelOf(edge.current)
    if (panel === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const shown = measured(edge.current)
      if (shown > 0) setWidth(shown)
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  function apply(next: number, keep: boolean) {
    const clamped = clampCabinetPanelWidth(next)
    const shell = edge.current?.closest<HTMLElement>('[data-cabinet-shell]')
    shell?.style.setProperty(PANEL_WIDTH_VAR, `${clamped}px`)
    setWidth(clamped)
    if (keep) remember(clamped)
  }

  const current = () => width ?? measured(edge.current)

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? PANEL_STEP * 4 : PANEL_STEP
    let next: number | null = null
    // The edge is on the right of the panel: to the right makes it wider.
    if (event.key === 'ArrowRight') next = current() + step
    else if (event.key === 'ArrowLeft') next = current() - step
    else if (event.key === 'Home') next = CABINET_PANEL_MIN_WIDTH
    else if (event.key === 'End') next = CABINET_PANEL_MAX_WIDTH
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
    const left = panelOf(edge.current)?.getBoundingClientRect().left ?? 0
    apply(event.clientX - left, false)
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    remember(current())
  }

  return (
    <Box
      ref={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width ?? CABINET_PANEL_DEFAULT_WIDTH}
      aria-valuemin={CABINET_PANEL_MIN_WIDTH}
      aria-valuemax={CABINET_PANEL_MAX_WIDTH}
      tabIndex={0}
      onKeyDown={keyDown}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      sx={{
        display: { xs: 'none', md: 'flex' },
        // Inside the card on its edge: the card scrolls, and would cut off what stands outside.
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        width: 12,
        zIndex: 3,
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'col-resize',
        touchAction: 'none',
        outline: 'none',
        // The grip: a pill on the edge, shown under the pointer and while focused.
        '&::after': {
          content: '""',
          width: 4,
          height: 44,
          borderRadius: '999px',
          bgcolor: 'transparent',
          transition: 'background-color 120ms',
        },
        '&:hover::after, &:active::after': { bgcolor: 'divider' },
        '&:focus-visible::after': { bgcolor: 'primary.main' },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: -2,
        },
      }}
    />
  )
}
