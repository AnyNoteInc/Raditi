'use client'

import type { TaskStatus } from '@repo/domain'
import { useEffect, useRef } from 'react'

// The tab says the chat waits while the client looks elsewhere (docs/plan/75-chat-input-output.md,
// ВВ11): the agent finished, asked or stopped, and the tab is hidden — «● Агент ответил — <title>».
// The title of the page comes back as soon as the tab is shown again.

const WORKING: readonly TaskStatus[] = ['queued', 'preparing', 'running']
const WAITING: readonly TaskStatus[] = ['awaiting_user', 'awaiting_approval']

export const WAITING_TITLE_MARK = '● Агент ответил — '

export function useWaitingTitle(status: TaskStatus | null) {
  const before = useRef<TaskStatus | null>(status)
  useEffect(() => {
    const previous = before.current
    before.current = status
    if (status === null || previous === null) return
    if (!WORKING.includes(previous) || !WAITING.includes(status)) return
    if (document.visibilityState === 'visible') return
    const own = document.title
    if (own.startsWith(WAITING_TITLE_MARK)) return
    document.title = WAITING_TITLE_MARK + own
    const shown = () => {
      if (document.visibilityState !== 'visible') return
      if (document.title.startsWith(WAITING_TITLE_MARK))
        document.title = document.title.slice(WAITING_TITLE_MARK.length)
      document.removeEventListener('visibilitychange', shown)
    }
    document.addEventListener('visibilitychange', shown)
    return () => document.removeEventListener('visibilitychange', shown)
  }, [status])
}
