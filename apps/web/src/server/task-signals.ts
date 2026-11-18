import 'server-only'

import {
  readTaskSignal,
  TASK_SIGNALS_RESYNC_CHANNEL,
  taskSignalChannel,
  type TaskSignal,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import type { TaskSignals } from '@repo/trpc'
import { Redis } from 'ioredis'

import { env } from '@/env'

/** The part of an ioredis client in subscriber mode the signals use. */
export interface SignalSubscriber {
  subscribe(...channels: string[]): Promise<unknown>
  unsubscribe(...channels: string[]): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
  on(event: 'ready', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

const report = throttledLogger((line) => console.error(`[signals] ${line}`))

/**
 * The signals of chats of this web process (spec §7): one connection to Redis in subscriber mode,
 * a channel per chat some page of this process watches, and the channel of `resync`. Once the
 * connection is back after a loss, ioredis subscribes again, and every page is told `resync`:
 * what was said meanwhile is lost to it.
 */
export function createTaskSignals(redis: SignalSubscriber): TaskSignals {
  const listeners = new Map<string, Set<(signal: TaskSignal) => void>>()
  const everyone = (signal: TaskSignal) => {
    for (const set of listeners.values()) for (const listener of set) listener(signal)
  }
  let ready = false
  redis.on('ready', () => {
    if (ready) everyone('resync')
    ready = true
  })
  redis.on('error', (error) => report('redis', error))
  redis.on('message', (channel, message) => {
    if (channel === TASK_SIGNALS_RESYNC_CHANNEL) return everyone('resync')
    const kind = readTaskSignal(message)
    if (kind === null) return
    for (const listener of listeners.get(channel) ?? []) listener(kind)
  })
  void redis.subscribe(TASK_SIGNALS_RESYNC_CHANNEL).catch((error) => report('subscribe', error))
  return {
    subscribe(taskId, listener) {
      const channel = taskSignalChannel(taskId)
      let set = listeners.get(channel)
      if (set === undefined) {
        set = new Set()
        listeners.set(channel, set)
        void redis.subscribe(channel).catch((error) => report('subscribe', error))
      }
      set.add(listener)
      return () => {
        const known = listeners.get(channel)
        if (known === undefined) return
        known.delete(listener)
        if (known.size > 0) return
        listeners.delete(channel)
        void redis.unsubscribe(channel).catch((error) => report('unsubscribe', error))
      }
    },
  }
}

// Survives module reloads in dev (Next.js HMR), as the Prisma client does: one subscriber.
const globalForSignals = globalThis as typeof globalThis & {
  __raditiTaskSignals?: TaskSignals | null
}

/** The signals of this process; null — REDIS_URL is not set, and the pages poll alone. */
export function taskSignals(): TaskSignals | null {
  if (globalForSignals.__raditiTaskSignals !== undefined)
    return globalForSignals.__raditiTaskSignals
  const url = env.web().redisUrl
  globalForSignals.__raditiTaskSignals = url
    ? createTaskSignals(
        // Commands wait for the connection: a subscription made while it is away goes once it
        // is back, and ioredis subscribes again to every channel after a loss.
        new Redis(url, { maxRetriesPerRequest: null, enableOfflineQueue: true }),
      )
    : null
  return globalForSignals.__raditiTaskSignals
}
