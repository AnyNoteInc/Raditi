// @vitest-environment jsdom
import type { TaskStatus } from '@repo/domain'
import type { ChatTodo } from '@repo/domain/tasks/agent-todo'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { taskSignalBus } from './task-signal-bus'
import { TASK_ID } from './testing'
import { todoPolling, useChatTodo } from './use-chat-todo'

// When «План работы» of the open chat is read again (docs/plan/87-agent-todos.md, ТД12).

const todo = vi.hoisted(() => vi.fn<(input: { taskId: string }) => Promise<ChatTodo | null>>())

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    task: {
      todo: {
        queryOptions: (input: { taskId: string }) => ({
          queryKey: ['task.todo', input] as QueryKey,
          queryFn: () => todo(input),
        }),
      },
    },
  }),
}))

const working: ChatTodo = {
  turn: 2,
  state: 'working',
  items: [
    { text: 'Собираем цены', status: 'in_progress' },
    { text: 'Публикуем страницу', status: 'pending' },
  ],
}

type Head = { status: TaskStatus | undefined; turnNo: number | undefined; rewound?: string }

function open(head: Head) {
  // As the app has it: what was read stays fresh for 30 s (trpc/query-client.ts).
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    (props: Head) => useChatTodo(TASK_ID, props.status, props.turnNo, props.rewound),
    {
      wrapper,
      initialProps: head,
    },
  )
}

/** Lets the timers run `ms` and the reads they started settle. */
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

beforeEach(() => {
  vi.useFakeTimers()
  todo.mockReset()
  todo.mockResolvedValue(working)
})

afterEach(() => {
  vi.useRealTimers()
  taskSignalBus.setConnected(TASK_ID, false)
})

describe('«План работы» of the open chat', () => {
  it('is read at once and given as the server has it', async () => {
    const hook = open({ status: 'running', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledWith({ taskId: TASK_ID })
    expect(hook.result.current).toEqual(working)
  })

  it('is null before the server answers, and when it has no plan', async () => {
    todo.mockResolvedValue(null)
    const hook = open({ status: undefined, turnNo: undefined })
    expect(hook.result.current).toBeNull()
    await pass(0)
    expect(hook.result.current).toBeNull()
  })

  it('is read again on a signal of the agent output while it works, once a second at most', async () => {
    taskSignalBus.setConnected(TASK_ID, true)
    open({ status: 'running', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(1)
    act(() => taskSignalBus.activity(TASK_ID))
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(2)
    // Five more signals within the second: one read, when the second is out.
    for (let index = 0; index < 5; index += 1) {
      act(() => taskSignalBus.activity(TASK_ID))
      await pass(100)
    }
    expect(todo).toHaveBeenCalledTimes(2)
    await pass(todoPolling.signalGap)
    expect(todo).toHaveBeenCalledTimes(3)
    // The stream is up: no poll of its own.
    await pass(30_000)
    expect(todo).toHaveBeenCalledTimes(3)
  })

  it('is read every 5 s while the agent works and the stream of signals is down', async () => {
    open({ status: 'running', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(1)
    await pass(todoPolling.every)
    expect(todo).toHaveBeenCalledTimes(2)
    await pass(todoPolling.every)
    expect(todo).toHaveBeenCalledTimes(3)
  })

  it('is not read once the turn has ended, by a poll or a signal', async () => {
    const hook = open({ status: 'awaiting_user', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(1)
    act(() => taskSignalBus.activity(TASK_ID))
    await pass(60_000)
    expect(todo).toHaveBeenCalledTimes(1)
    hook.rerender({ status: 'done', turnNo: 2 })
    await pass(0)
    // The status changed: read once, then nothing more.
    expect(todo).toHaveBeenCalledTimes(2)
    await pass(60_000)
    expect(todo).toHaveBeenCalledTimes(2)
  })

  it('is read again at once on a new turn and on a new status, fresh or not', async () => {
    taskSignalBus.setConnected(TASK_ID, true)
    const hook = open({ status: undefined, turnNo: undefined })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(1)
    // The head comes: nothing has changed yet.
    hook.rerender({ status: 'running', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(1)
    hook.rerender({ status: 'awaiting_user', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(2)
    hook.rerender({ status: 'running', turnNo: 3 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(3)
  })

  it('is read again when `/undo` or `/redo` writes its row, the status and turn as they were', async () => {
    // A chat that waits: no poll, no signal reads it — an undo from another tab comes as its row.
    const hook = open({ status: 'awaiting_user', turnNo: 2 })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(1)
    todo.mockResolvedValue(null)
    hook.rerender({ status: 'awaiting_user', turnNo: 2, rewound: '41' })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(2)
    expect(hook.result.current).toBeNull()
    // The same row read again is nothing new; `/redo` after it is.
    hook.rerender({ status: 'awaiting_user', turnNo: 2, rewound: '41' })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(2)
    todo.mockResolvedValue(working)
    hook.rerender({ status: 'awaiting_user', turnNo: 2, rewound: '42' })
    await pass(0)
    expect(todo).toHaveBeenCalledTimes(3)
    expect(hook.result.current).toEqual(working)
  })

  it('reads nothing for a signal while the page is hidden', async () => {
    taskSignalBus.setConnected(TASK_ID, true)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      open({ status: 'running', turnNo: 2 })
      await pass(0)
      act(() => taskSignalBus.activity(TASK_ID))
      await pass(2_000)
      expect(todo).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })
})
