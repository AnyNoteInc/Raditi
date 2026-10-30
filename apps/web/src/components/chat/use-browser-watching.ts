'use client'

import { useMutation } from '@tanstack/react-query'
import { useEffect } from 'react'

import { useTRPC } from '@/trpc/client'

// The client looking at the dialog of a task in the browser (docs/plan/59-dialog-tools-panel.md,
// И18; owner's answer of 30.10.2026: «чат тоже считается просмотром браузера, не нужно
// ограничивать 30 минут»). The worker closes a session nobody acted in, watched or looked at for
// its idle time; while the page of the dialog is on the screen, it says the client looks — once it
// is shown, and then every minute — whether the panel of the browser is open or not.

/** How often the page says the client looks at the dialog: well within the idle time. */
export const WATCH_EVERY_MS = 60_000

/** Says the client looks at the dialog while `enabled` — its browser holds a session — and shown. */
export function useBrowserWatching({ taskId, enabled }: { taskId: string; enabled: boolean }) {
  const trpc = useTRPC()
  const { mutate } = useMutation(trpc.browser.watch.mutationOptions())
  useEffect(() => {
    if (!enabled) return
    const look = () => {
      if (document.visibilityState !== 'hidden') mutate({ taskId })
    }
    look()
    const timer = window.setInterval(look, WATCH_EVERY_MS)
    document.addEventListener('visibilitychange', look)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', look)
    }
  }, [enabled, taskId, mutate])
}
