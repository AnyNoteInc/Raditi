'use client'

import Box from '@mui/material/Box'
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { LiveStreamStats } from './stream-stats'

// The line of numbers over the browser panel (docs/plan/85-browser-stream-mobile.md, ТР4): what
// this tab measured in the last seconds, for the owner's checks from a phone. A chat address with
// `?stream-stats=1` turns it on until the tab closes, `?stream-stats=0` turns it off; a client
// never sees it otherwise. It takes no input: a finger on it reaches the canvas.

const STORAGE_KEY = 'raditi.streamStats'
const REFRESH_MS = 1_000

/** Whether this tab shows the numbers; the address may turn them on or off for the tab. */
export function streamStatsEnabled(search: string): boolean {
  const asked = new URLSearchParams(search).get('stream-stats')
  try {
    if (asked === '1') window.sessionStorage.setItem(STORAGE_KEY, '1')
    if (asked === '0') window.sessionStorage.removeItem(STORAGE_KEY)
    return window.sessionStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Storage refused (a private window): the address alone decides.
    return asked === '1'
  }
}

const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)} мс`)
const decimal = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })

/** The numbers in a line: frames a second, kilobytes a frame, megabits a second, times. */
export function streamStatsText(stats: LiveStreamStats): string {
  return [
    `${decimal(stats.fps)} к/с`,
    stats.kbPerFrame === null ? '— КБ' : `${stats.kbPerFrame} КБ`,
    `${decimal(stats.mbps)} Мбит/с`,
    `рисование ${ms(stats.drawMs)}`,
    `касание → картинка ${ms(stats.inputMs)}`,
  ].join(' · ')
}

/** The address and the tab's storage change nothing to listen to while the panel is open. */
const subscribeNever = () => () => undefined
const enabledNow = () => streamStatsEnabled(window.location.search)
const enabledOnServer = () => false

export function StreamStatsLine({ read }: { read: () => LiveStreamStats | null }) {
  const enabled = useSyncExternalStore(subscribeNever, enabledNow, enabledOnServer)
  const [stats, setStats] = useState<LiveStreamStats | null>(null)
  useEffect(() => {
    if (!enabled) return
    const tick = () => setStats(read())
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled, read])
  if (!enabled || stats === null) return null
  return (
    <Box
      data-testid="stream-stats"
      aria-hidden
      sx={{
        position: 'absolute',
        top: 4,
        left: 4,
        right: 4,
        zIndex: 1,
        pointerEvents: 'none',
        px: 0.75,
        py: 0.25,
        borderRadius: 0.5,
        width: 'fit-content',
        maxWidth: 'calc(100% - 8px)',
        fontSize: 11,
        lineHeight: 1.4,
        fontVariantNumeric: 'tabular-nums',
        color: '#fff',
        bgcolor: 'rgba(0, 0, 0, 0.6)',
      }}
    >
      {streamStatsText(stats)}
    </Box>
  )
}
