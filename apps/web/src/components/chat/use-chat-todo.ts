'use client'

import type { TaskStatus } from '@repo/domain'
import type { ChatTodo } from '@repo/domain/tasks/agent-todo'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { useTRPC } from '@/trpc/client'

import { taskSignalBus } from './task-signal-bus'

// «План работы» of the open chat (docs/plan/87-agent-todos.md, ТД12): a snapshot of `task.todo`,
// read again with no signal of its own. The agent's list comes in its output, and every output
// of a turn signals `activity` (task.signals): while the agent works, such a signal reads the plan
// again. A new turn or a new status of the chat reads it too — the plan of the turn that ended
// changes its state then, and so does `/undo` or `/redo` (its row in the feed): they take a turn
// out of the count or bring it back with no new status or turn. Without the stream of signals a
// chat at work is read every 5 s; a chat that waits or has ended is not read until its status
// changes.

export const todoPolling = Object.freeze({
  /** A chat at work while the stream of its signals is down. */
  every: 5_000,
  /** The shortest time between two reads the signals ask for: they come a few times a second. */
  signalGap: 1_000,
})

/** The statuses of a chat whose turn is at work, or about to be: its plan changes. */
const AT_WORK: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['queued', 'preparing', 'running'])

export const chatAtWork = (status: TaskStatus | undefined): boolean =>
  status !== undefined && AT_WORK.has(status)

/**
 * The plan of the chat `taskId` as the card and the line over the field show it; null — none, or
 * not read yet. `status` and `turnNo` are the head of the chat's feed (undefined before it);
 * `rewound` — the id of the newest row of `/undo` or `/redo` in the feed, if any: an undo in
 * another tab reads the plan again too.
 */
export function useChatTodo(
  taskId: string,
  status: TaskStatus | undefined,
  turnNo: number | undefined,
  rewound: string | undefined,
): ChatTodo | null {
  const trpc = useTRPC()
  const atWork = chatAtWork(status)
  const { data, refetch } = useQuery({
    ...trpc.task.todo.queryOptions({ taskId }),
    // A chat opened again shows the plan it had, and reads it at once.
    staleTime: 0,
    // Asked at every drawing of the chat: the stream going down draws it (its state changes).
    refetchInterval: atWork && !taskSignalBus.connected(taskId) ? todoPolling.every : false,
  })
  // A signal reads at once, but not sooner than `signalGap` after the read a signal asked before.
  const lastRead = useRef(Number.NEGATIVE_INFINITY)
  useEffect(() => {
    if (!atWork) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unwake = taskSignalBus.onActivity(taskId, () => {
      if (timer !== undefined || document.visibilityState === 'hidden') return
      timer = setTimeout(
        () => {
          timer = undefined
          lastRead.current = Date.now()
          void refetch()
        },
        Math.max(0, lastRead.current + todoPolling.signalGap - Date.now()),
      )
    })
    return () => {
      clearTimeout(timer)
      unwake()
    }
  }, [atWork, taskId, refetch])
  // A new turn or status, a turn taken back or brought back: the plan follows it at once.
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (status === undefined) return
    const now = `${status}:${turnNo ?? 0}:${rewound ?? ''}`
    if (seen.current !== null && seen.current !== now) void refetch()
    seen.current = now
  }, [status, turnNo, rewound, refetch])
  return data ?? null
}
