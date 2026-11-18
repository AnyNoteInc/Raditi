import type { TaskSignal } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { readTaskSignals, type TaskSignals } from './signals.ts'

const TASK = '01960000-0000-7000-8000-0000000000a1'
const USER = '01960000-0000-7000-8000-0000000000b1'

/** Signals the test sends by hand, and who listens to them. */
function hub() {
  const listeners = new Map<string, Set<(signal: TaskSignal) => void>>()
  const signals: TaskSignals = {
    subscribe(taskId, listener) {
      const set = listeners.get(taskId) ?? new Set()
      set.add(listener)
      listeners.set(taskId, set)
      return () => set.delete(listener)
    },
  }
  const send = (signal: TaskSignal) => listeners.get(TASK)?.forEach((listener) => listener(signal))
  return { signals, send, listening: () => listeners.get(TASK)?.size ?? 0 }
}

/** The database as the stream sees it: whether the user may read the chat, and how often asked. */
function access(initially = true) {
  const state = { allowed: initially, reads: 0 }
  const db = {
    task: {
      findFirst: async () => {
        state.reads += 1
        return state.allowed ? { id: TASK } : null
      },
    },
  } as unknown as Parameters<typeof readTaskSignals>[0]
  return { db, state }
}

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the signals of a chat', () => {
  it('refuses a chat the user may not read, as NOT_FOUND', async () => {
    const { signals } = hub()
    const stream = readTaskSignals(access(false).db, signals, { userId: USER, taskId: TASK })
    await expect(stream.next()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('says resync first, then each signal once while it waits to be read', async () => {
    const { signals, send, listening } = hub()
    const controller = new AbortController()
    const stream = readTaskSignals(access().db, signals, {
      userId: USER,
      taskId: TASK,
      signal: controller.signal,
    })
    expect(await stream.next()).toEqual({ value: { signal: 'resync' }, done: false })
    const next = stream.next()
    send('activity')
    send('activity')
    send('feed')
    expect(await next).toEqual({ value: { signal: 'activity' }, done: false })
    expect(await stream.next()).toEqual({ value: { signal: 'feed' }, done: false })
    // The page goes away: the stream ends and stops listening.
    const ending = stream.next()
    controller.abort()
    expect(await ending).toEqual({ value: undefined, done: true })
    expect(listening()).toBe(0)
  })

  it('ends once the reader may no longer read the chat, at the next check', async () => {
    const { signals, listening } = hub()
    const { db, state } = access()
    const stream = readTaskSignals(db, signals, { userId: USER, taskId: TASK, recheckMs: 30 })
    await stream.next()
    const next = stream.next()
    await settle(40)
    // Still a member at the first check: the stream goes on.
    expect(state.reads).toBe(2)
    state.allowed = false
    expect(await next).toEqual({ value: undefined, done: true })
    expect(listening()).toBe(0)
  })
})
