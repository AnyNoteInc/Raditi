'use client'

import Box from '@mui/material/Box'
import Dialog from '@mui/material/Dialog'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { slideSize, type ArtifactSlide } from '@repo/domain/artifacts'
import { useQueries } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { useTRPC } from '@/trpc/client'

import { ViewFrame } from '../frame/view-frame'
import { slidesTexts } from './slides-texts'

// «Показать» (docs/plan/93-artifacts-trim.md, АТ8): the slides over the whole screen of the browser
// — the Fullscreen API, the dialog over the window where it is refused —, black around, the slide
// scaled to fit. A transparent layer over the frames takes the clicks, so the keyboard stays with
// the cabinet; the slides beside the shown one are loaded already, so a step shows no black.

/** The controls hide after this long without a move of the mouse. */
export const SHOW_CONTROLS_MS = 2000

/** The keys of the show: forward, back, the first and the last slide. */
export function showStepOf(key: string): 'next' | 'previous' | 'first' | 'last' | null {
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === ' ' || key === 'PageDown')
    return 'next'
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') return 'previous'
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  return null
}

export function SlideShow({
  artifactId,
  seq,
  slides,
  start,
  thumbOf,
  onClose,
}: {
  artifactId: string
  seq: number
  slides: readonly ArtifactSlide[]
  start: number
  /** The picture core drew of a slide: under its frame until the frame is there. */
  thumbOf: (key: string) => string | null
  onClose: () => void
}) {
  const trpc = useTRPC()
  const [at, setAt] = useState(Math.min(start, slides.length - 1))
  const [screen, setScreen] = useState({ width: 1280, height: 720 })
  const [controls, setControls] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const entered = useRef(false)
  const last = slides.length - 1

  // The shown slide and its neighbours: their frames are mounted, the others are not.
  const near = slides
    .map((slide, index) => ({ slide, index }))
    .filter(({ index }) => Math.abs(index - at) <= 1)
  const frames = useQueries({
    queries: near.map(({ slide }) => ({
      ...trpc.artifact.frame.queryOptions({ artifactId, mode: 'view', seq, frame: slide.key }),
      staleTime: 4 * 60_000,
    })),
  })

  const step = useCallback(
    (to: 'next' | 'previous' | 'first' | 'last') =>
      setAt((current) =>
        to === 'next'
          ? Math.min(current + 1, last)
          : to === 'previous'
            ? Math.max(current - 1, 0)
            : to === 'first'
              ? 0
              : last,
      ),
    [last],
  )

  const wake = useCallback(() => {
    setControls(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setControls(false), SHOW_CONTROLS_MS)
  }, [])

  // The controls are there at the start and fade after a while without the mouse.
  useEffect(() => {
    hideTimer.current = setTimeout(() => setControls(false), SHOW_CONTROLS_MS)
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  useEffect(() => {
    const measure = () => setScreen({ width: window.innerWidth, height: window.innerHeight })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const to = showStepOf(event.key)
      if (to === null) return
      // Space on a focused control presses it («Закрыть», «Назад», «Вперёд»), not a step.
      if (event.key === ' ' && event.target instanceof Element && event.target.closest('button'))
        return
      event.preventDefault()
      step(to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  // Esc of the browser leaves its full screen without a key event: the show ends with it.
  const closing = useRef(onClose)
  useEffect(() => {
    closing.current = onClose
  }, [onClose])
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement) entered.current = true
      else if (entered.current) closing.current()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [])

  // The dialog mounts its content a moment later: the full screen is asked when the node is there.
  const attach = useCallback((node: HTMLDivElement | null) => {
    root.current = node
    if (!node || typeof node.requestFullscreen !== 'function' || !document.fullscreenEnabled) return
    node.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
      // Refused (no gesture, a frame without the permission): the dialog covers the window.
    })
  }, [])

  const close = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    onClose()
  }

  const scale = Math.min(screen.width / slideSize.width, screen.height / slideSize.height)
  const width = slideSize.width * scale
  const height = slideSize.height * scale
  const left = (screen.width - width) / 2
  const top = (screen.height - height) / 2
  const shown = slides[at]
  const thumb = shown ? thumbOf(shown.key) : null

  const controlSx = {
    opacity: controls ? 1 : 0,
    pointerEvents: controls ? 'auto' : 'none',
    transition: 'opacity 200ms ease',
    '&:focus-within': { opacity: 1, pointerEvents: 'auto' },
  } as const

  return (
    <Dialog
      fullScreen
      open
      onClose={close}
      slotProps={{ paper: { 'aria-label': slidesTexts.show, sx: { bgcolor: '#000' } } }}
    >
      <Box
        ref={attach}
        data-testid="slide-show"
        onMouseMove={wake}
        sx={{
          position: 'fixed',
          inset: 0,
          bgcolor: '#000',
          color: '#fff',
          overflow: 'hidden',
          cursor: controls ? 'default' : 'none',
        }}
      >
        {thumb && (
          <Box
            component="img"
            src={thumb}
            alt=""
            sx={{ position: 'absolute', left, top, width, height, objectFit: 'cover' }}
          />
        )}
        <Box inert sx={{ position: 'absolute', inset: 0 }}>
          {near.map(({ slide, index }, place) => {
            const frame = frames[place]?.data
            return (
              <Box
                key={slide.key}
                aria-hidden={index === at ? undefined : true}
                sx={{
                  position: 'absolute',
                  left,
                  top,
                  visibility: index === at ? 'visible' : 'hidden',
                }}
              >
                {frame && (
                  <ViewFrame
                    src={frame.url}
                    width={slideSize.width}
                    fixedHeight={slideSize.height}
                    scale={scale}
                    title={slide.name}
                  />
                )}
              </Box>
            )
          })}
        </Box>
        {/* Clicks: the left third goes back, the rest forward. */}
        <Box
          data-testid="slide-show-layer"
          onClick={(event) => {
            const third = (root.current?.clientWidth || screen.width) / 3
            step(event.clientX < third ? 'previous' : 'next')
          }}
          sx={{ position: 'absolute', inset: 0, zIndex: 1 }}
        />
        <Box sx={{ position: 'absolute', top: 16, right: 16, zIndex: 2, ...controlSx }}>
          {/* Inside the show: a portal to the body is not seen over the full screen. */}
          <Tooltip
            title={`${slidesTexts.close} (Esc)`}
            slotProps={{ popper: { disablePortal: true } }}
          >
            <IconButton
              aria-label={slidesTexts.close}
              onClick={close}
              sx={{ color: '#fff', bgcolor: 'rgba(255,255,255,.12)' }}
            >
              <AppIcon name="close" size={20} />
            </IconButton>
          </Tooltip>
        </Box>
        <Box
          sx={{
            position: 'absolute',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            py: 0.5,
            borderRadius: 999,
            bgcolor: 'rgba(20,20,20,.72)',
            ...controlSx,
          }}
        >
          <IconButton
            aria-label={slidesTexts.previous}
            disabled={at === 0}
            onClick={() => step('previous')}
            sx={{ color: '#fff', '&.Mui-disabled': { color: 'rgba(255,255,255,.3)' } }}
          >
            <AppIcon name="back" size={18} />
          </IconButton>
          <Typography
            variant="body2"
            aria-live="polite"
            sx={{ minWidth: 64, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
          >
            {slidesTexts.of(at + 1, slides.length)}
          </Typography>
          <IconButton
            aria-label={slidesTexts.next}
            disabled={at === last}
            onClick={() => step('next')}
            sx={{ color: '#fff', '&.Mui-disabled': { color: 'rgba(255,255,255,.3)' } }}
          >
            <AppIcon name="forward" size={18} />
          </IconButton>
        </Box>
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            height: 3,
            width: `${((at + 1) / slides.length) * 100}%`,
            bgcolor: 'rgba(255,255,255,.5)',
            zIndex: 2,
            ...controlSx,
            transition: 'opacity 200ms ease, width 200ms ease',
          }}
        />
      </Box>
    </Dialog>
  )
}
