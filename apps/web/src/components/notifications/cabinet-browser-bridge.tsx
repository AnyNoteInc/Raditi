'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

import { useTRPC } from '@/trpc/client'

import { browserZone, claimZoneMark, NAVIGATE_ANSWER, navigatePathOf } from './cabinet-messages'

/** The session storage, or null where reading it throws. */
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Mounted once by the layout of the cabinet; renders nothing (docs/plan/82-scheduled-tasks.md):
 * - a click on a notification while a window of the cabinet is open brings it here as a message of
 *   the service worker; the window answers on the port of the message and goes to the path without
 *   a reload — the words the client was typing stay (Зп41);
 * - the zone of the browser is remembered once a browser session, for the next scheduled task
 *   (Зп12); the list of the tasks is read again, since it names the zone a new task takes.
 */
export function CabinetBrowserBridge({ userId }: { userId: string }) {
  const router = useRouter()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const remember = useMutation(
    trpc.schedule.rememberTimezone.mutationOptions({
      // Read before the zone was written, the list would give a new task the zone of before.
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.schedule.list.queryKey() }),
    }),
  )
  const { mutate } = remember

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const container = navigator.serviceWorker
    const onMessage = (event: MessageEvent) => {
      const path = navigatePathOf(event.data)
      if (path === null) return
      // The worker waits for this answer; without it, it moves the window itself (Зп41).
      event.ports[0]?.postMessage(NAVIGATE_ANSWER)
      router.push(path)
    }
    container.addEventListener('message', onMessage)
    // Messages wait until the page says it listens; a listener added late would miss the first.
    container.startMessages()
    return () => container.removeEventListener('message', onMessage)
  }, [router])

  useEffect(() => {
    const zone = browserZone()
    if (zone === null || !claimZoneMark(sessionStorageOrNull(), userId, zone)) return
    mutate({ timezone: zone })
  }, [mutate, userId])

  return null
}
