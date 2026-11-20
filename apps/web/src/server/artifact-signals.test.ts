import { EventEmitter } from 'node:events'

import type { ArtifactSignal } from '@repo/domain/artifacts'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createArtifactSignals, type PresenceStore } from './artifact-signals'
import type { SignalSubscriber } from './task-signals'

const ARTIFACT = '01960000-0000-7000-8000-0000000000c3'
const USER = '01960000-0000-7000-8000-0000000000d4'
const OTHER = '01960000-0000-7000-8000-0000000000e5'

class FakeRedis extends EventEmitter implements SignalSubscriber {
  readonly channels = new Set<string>()
  async subscribe(...channels: string[]) {
    for (const channel of channels) this.channels.add(channel)
  }
  async unsubscribe(...channels: string[]) {
    for (const channel of channels) this.channels.delete(channel)
  }
}

class FakeStore implements PresenceStore {
  readonly hashes = new Map<string, Map<string, string>>()
  readonly published: [string, string][] = []
  readonly expiries = new Map<string, number>()
  #hash(key: string) {
    let hash = this.hashes.get(key)
    if (!hash) this.hashes.set(key, (hash = new Map()))
    return hash
  }
  async hget(key: string, field: string) {
    return this.#hash(key).get(field) ?? null
  }
  async hgetall(key: string) {
    return Object.fromEntries(this.#hash(key))
  }
  async hset(key: string, field: string, value: string) {
    this.#hash(key).set(field, value)
  }
  async hdel(key: string, ...fields: string[]) {
    for (const field of fields) this.#hash(key).delete(field)
  }
  async pexpire(key: string, ms: number) {
    this.expiries.set(key, ms)
  }
  async publish(channel: string, message: string) {
    this.published.push([channel, message])
  }
}

describe('the signals and presence of artifacts in web (88.5)', () => {
  it('listens to an artifact while a page watches it, and tells resync of chats too', () => {
    const redis = new FakeRedis()
    const signals = createArtifactSignals(redis, new FakeStore())
    const heard: ArtifactSignal[] = []
    const stop = signals.subscribe(ARTIFACT.toUpperCase(), (signal) => heard.push(signal))
    expect(redis.channels.has(`raditi:artifact:${ARTIFACT}`)).toBe(true)
    redis.emit('message', `raditi:artifact:${ARTIFACT}`, 'changes')
    redis.emit('message', `raditi:artifact:${ARTIFACT}`, 'feed')
    redis.emit('message', 'raditi:tasks:resync', 'resync')
    expect(heard).toEqual(['changes', 'resync'])
    stop()
    expect(redis.channels.has(`raditi:artifact:${ARTIFACT}`)).toBe(false)
  })

  it('marks a person present, says presence only when the mark is new or moves, and forgets old marks', async () => {
    const store = new FakeStore()
    const signals = createArtifactSignals(new FakeRedis(), store)
    const until = Date.now() + 30_000
    await signals.mark(ARTIFACT, USER, { block: 'a', until })
    await signals.mark(ARTIFACT, USER, { block: 'a', until: until + 15_000 })
    await signals.mark(ARTIFACT, USER, { block: 'b', until: until + 15_000 })
    expect(store.published).toEqual([
      [`raditi:artifact:${ARTIFACT}`, 'presence'],
      [`raditi:artifact:${ARTIFACT}`, 'presence'],
    ])
    expect(store.expiries.get(`raditi:artifact:${ARTIFACT}:presence`)).toBeGreaterThan(30_000)
    // A mark past its end, and one that is not a mark, are dropped on read.
    store.hashes
      .get(`raditi:artifact:${ARTIFACT}:presence`)!
      .set(OTHER, JSON.stringify({ block: null, until: Date.now() - 1 }))
    store.hashes.get(`raditi:artifact:${ARTIFACT}:presence`)!.set('broken', 'nope')
    const marks = await signals.marks(ARTIFACT)
    expect([...marks.keys()]).toEqual([USER])
    expect(store.hashes.get(`raditi:artifact:${ARTIFACT}:presence`)!.has(OTHER)).toBe(false)
    await signals.leave(ARTIFACT, USER)
    expect((await signals.marks(ARTIFACT)).size).toBe(0)
    expect(store.published).toHaveLength(3)
  })
})
