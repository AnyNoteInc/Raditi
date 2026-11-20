import 'server-only'

import { TASK_SIGNALS_RESYNC_CHANNEL } from '@repo/domain'
import {
  artifactPresenceKey,
  artifactSignalChannel,
  readArtifactPresenceMark,
  readArtifactSignal,
  type ArtifactPresenceMark,
  type ArtifactSignal,
} from '@repo/domain/artifacts'
import { throttledLogger } from '@repo/observability'
import type { ArtifactSignals } from '@repo/trpc'
import { Redis } from 'ioredis'

import { env } from '@/env'

import type { SignalSubscriber } from './task-signals'

/** The commands of an ioredis client the marks of presence use. */
export interface PresenceStore {
  hget(key: string, field: string): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
  hset(key: string, field: string, value: string): Promise<unknown>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
  publish(channel: string, message: string): Promise<unknown>
}

const report = throttledLogger((line) => console.error(`[artifact-signals] ${line}`))

/** A key of presence lives a little longer than its longest mark: a forgotten one goes alone. */
const KEY_SLACK_MS = 5_000

/**
 * The signals and presence of artifacts of this web process (docs/plan/88-artifacts.md, Ар20):
 * one connection to Redis in subscriber mode, a channel per artifact some page of this process
 * watches, and the `resync` of chats — core says it after any loss of PostgreSQL, for both. The
 * marks of presence are a hash per artifact in Redis (person → block and end), written by any
 * replica and read by all; no row of PostgreSQL is written for them.
 */
export function createArtifactSignals(
  subscriber: SignalSubscriber,
  store: PresenceStore,
): ArtifactSignals {
  const listeners = new Map<string, Set<(signal: ArtifactSignal) => void>>()
  const everyone = (signal: ArtifactSignal) => {
    for (const set of listeners.values()) for (const listener of set) listener(signal)
  }
  let ready = false
  subscriber.on('ready', () => {
    if (ready) everyone('resync')
    ready = true
  })
  subscriber.on('error', (error) => report('redis', error))
  subscriber.on('message', (channel, message) => {
    if (channel === TASK_SIGNALS_RESYNC_CHANNEL) return everyone('resync')
    const kind = readArtifactSignal(message)
    if (kind === null) return
    for (const listener of listeners.get(channel) ?? []) listener(kind)
  })
  void subscriber
    .subscribe(TASK_SIGNALS_RESYNC_CHANNEL)
    .catch((error) => report('subscribe', error))
  const say = (artifactId: string) =>
    store.publish(artifactSignalChannel(artifactId), 'presence').catch((error: unknown) => {
      report('publish', error)
    })
  return {
    subscribe(artifactId, listener) {
      const channel = artifactSignalChannel(artifactId)
      let set = listeners.get(channel)
      if (set === undefined) {
        set = new Set()
        listeners.set(channel, set)
        void subscriber.subscribe(channel).catch((error) => report('subscribe', error))
      }
      set.add(listener)
      return () => {
        const known = listeners.get(channel)
        if (known === undefined) return
        known.delete(listener)
        if (known.size > 0) return
        listeners.delete(channel)
        void subscriber.unsubscribe(channel).catch((error) => report('unsubscribe', error))
      }
    },
    async mark(artifactId, userId, mark) {
      const key = artifactPresenceKey(artifactId)
      const before = await store.hget(key, userId)
      const was = before === null ? null : readArtifactPresenceMark(before)
      await store.hset(key, userId, JSON.stringify(mark))
      await store.pexpire(key, Math.max(0, mark.until - Date.now()) + KEY_SLACK_MS)
      // A page that only renews itself says nothing: the others read it on their own marks.
      if (was === null || was.until <= Date.now() || was.block !== mark.block) await say(artifactId)
    },
    async leave(artifactId, userId) {
      await store.hdel(artifactPresenceKey(artifactId), userId)
      await say(artifactId)
    },
    async marks(artifactId) {
      const key = artifactPresenceKey(artifactId)
      const raw = await store.hgetall(key)
      const out = new Map<string, ArtifactPresenceMark>()
      const gone: string[] = []
      for (const [userId, value] of Object.entries(raw)) {
        const mark = readArtifactPresenceMark(value)
        if (mark === null || mark.until <= Date.now()) gone.push(userId)
        else out.set(userId, mark)
      }
      if (gone.length > 0) await store.hdel(key, ...gone).catch(() => undefined)
      return out
    },
  }
}

// Survives module reloads in dev (Next.js HMR), as the Prisma client does: one pair of clients.
const globalForArtifacts = globalThis as typeof globalThis & {
  __raditiArtifactSignals?: ArtifactSignals | null
}

/** The signals of artifacts of this process; null — REDIS_URL is not set. */
export function artifactSignals(): ArtifactSignals | null {
  if (globalForArtifacts.__raditiArtifactSignals !== undefined)
    return globalForArtifacts.__raditiArtifactSignals
  const url = env.web().redisUrl
  globalForArtifacts.__raditiArtifactSignals = url
    ? createArtifactSignals(
        new Redis(url, { maxRetriesPerRequest: null, enableOfflineQueue: true }),
        // A mark that cannot be written fails its request: the page marks itself again later.
        new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: true }),
      )
    : null
  return globalForArtifacts.__raditiArtifactSignals
}
